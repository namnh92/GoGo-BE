import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { resolveBooleanFlag } from '../../shared/feature-flags';
import { writeAudit } from '../../shared/audit';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { lockAssistantAccount } from '../../shared/assistant-credits';
import { assertAssistantCreditSpendReady } from '../../shared/assistant-credit-readiness';
import { assertPublicCredits, assertCreditAmounts, reviseCredits } from '../domain/credit-cost';
import type { AssistantTurnCredits, AssistantConversationCredits } from '../domain/assistant.types';

export type CreditExec = Pick<Db, 'execute'>;
export type SpendControl = {
  policy_key: 'legacy_allowance_v1' | 'free_then_actual_cost_v1';
  epoch: string;
  bound_version: string | null;
};
export type FundingSnapshot = SpendControl & {
  balance: number;
  reserved: string;
  accepted_today: number;
  as_of: string;
  quarantined: boolean;
};
type CreditTurnRow = {
  usage_ledger_id: string;
  accepted_at: string;
  user_id: string | null;
  funding_source: string;
  reserved_ceiling: number;
  held_credits: number;
  applied_credits: number;
  cost_revision: string;
  applied_cost_revision: string;
  finalized_at: string | null;
  state: string;
};

/** Correlated facts share their caller's SQL statement snapshot. */
export const turnCreditsSql = (messageId: SQL, userId: SQL): SQL => sql`(
 select case when t.usage_ledger_id is not null then jsonb_build_object(
  'policyKey',t.policy_key,'fundingSource',t.funding_source,
  'state',case when t.state='quarantined' then case when t.applied_cost_revision>0 then 'reconciling' else 'pending' end else t.state end,
  'creditsCharged',t.applied_credits,'creditsReserved',t.held_credits,'updatedAt',to_char(t.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 else jsonb_build_object('policyKey','legacy_allowance_v1',
  'fundingSource',case when u.allowance_source='daily' then 'free' when l.n>0 then 'credit' else 'unavailable' end,
  'state',case when u.allowance_source='daily' or l.n>0 then 'settled' else 'unavailable' end,
  'creditsCharged',case when u.allowance_source='daily' then 0 when l.n>0 then l.charged else null end,
  'creditsReserved',case when u.allowance_source='daily' or l.n>0 then 0 else null end,
  'updatedAt',to_char(coalesce(u.completed_at,u.accepted_at,statement_timestamp()) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end
 from (select 1) seed
 left join assistant_usage_ledger u on u.message_id=${messageId} and u.user_id=${userId}
 left join assistant_credit_turns t on t.message_id=${messageId} and t.user_id=${userId}
 left join lateral (select count(*) as n,-sum(delta)::bigint as charged from assistant_credit_ledger
  where usage_ledger_id=u.id and reason in ('message_spent','assistant_usage_adjustment')) l on true
 limit 1
)`;

export const conversationCreditsSql = (conversationId: SQL, userId: SQL): SQL => sql`(
 select jsonb_build_object(
  'creditsUsed',case when coalesce(bool_or(f->>'state'='unavailable'),false) then null else coalesce(sum((f->>'creditsCharged')::bigint),0) end,
  'creditsReserved',coalesce(sum((f->>'creditsReserved')::bigint),0),
  'pendingTurns',count(*) filter(where f->>'fundingSource'='credit' and f->>'state' in ('pending','reconciling')),
  'state',case when coalesce(bool_or(f->>'state'='unavailable'),false) then 'unavailable'
    when count(*) filter(where f->>'state' in ('pending','reconciling'))>0 then 'pending' else 'settled' end,
  'asOf',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 from (
  select jsonb_build_object(
   'fundingSource',t.funding_source,
   'state',case when t.state='quarantined' then case when t.applied_cost_revision>0 then 'reconciling' else 'pending' end else t.state end,
   'creditsCharged',t.applied_credits,'creditsReserved',t.held_credits) as f
  from assistant_credit_turns t
  where t.conversation_id=${conversationId} and t.user_id=${userId}
  union all
  select ${turnCreditsSql(sql`m_credit.id`, sql`m_credit.user_id`)} as f from assistant_messages m_credit
  where m_credit.conversation_id=${conversationId} and m_credit.user_id=${userId} and m_credit.role='assistant'
   and not exists (select 1 from assistant_credit_turns t
    where t.message_id=m_credit.id or t.usage_ledger_id in (
     select u.id from assistant_usage_ledger u where u.message_id=m_credit.id))
 ) facts
)`;

@Injectable()
export class AssistantCreditSpendRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}
  /** First admission lock, before account and global budget. */
  async lockControl(tx: CreditExec): Promise<SpendControl> {
    try {
      await assertAssistantCreditSpendReady(tx);
    } catch {
      throw AppError.serviceUnavailable(
        'ASSISTANT_DISABLED',
        'Assistant credit storage unavailable',
        false,
      );
    }
    const r = await tx.execute(
      sql`select policy_key,epoch::text,bound_version from assistant_credit_spend_control where singleton=true for share`,
    );
    if (!r.rows.length)
      throw AppError.serviceUnavailable('ASSISTANT_DISABLED', 'Spend policy unavailable', false);
    return r.rows[0] as SpendControl;
  }
  async snapshot(exec: CreditExec, userId: string, dayStart: Date): Promise<FundingSnapshot> {
    const r = await exec.execute(sql`select c.policy_key,c.epoch::text,c.bound_version,
   coalesce(a.balance,0)::int as balance,
   (select coalesce(sum(held_credits),0)::text from assistant_credit_turns where user_id=u.id) as reserved,
   (select count(*)::int from assistant_usage_ledger where user_id=u.id and allowance_source='daily' and accepted_at>=${dayStart.toISOString()}::timestamptz
     and accepted_at<${new Date(dayStart.getTime() + 86400000).toISOString()}::timestamptz) as accepted_today,
   (exists(select 1 from assistant_credit_turns where state='quarantined') or exists(select 1 from assistant_credit_billing_incidents where resolved_at is null)) as quarantined,
   to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of
   from users u cross join assistant_credit_spend_control c
   left join assistant_credit_accounts a on a.user_id=u.id where u.id=${userId} and u.status='active'`);
    if (!r.rows.length)
      throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
    return r.rows[0] as FundingSnapshot;
  }
  /** Caller holds control -> account -> budget. Free sends never create a wallet. */
  async reserveWithin(
    tx: CreditExec,
    input: {
      usageId: string;
      userId: string;
      messageId: string;
      conversationId: string;
      acceptedAt: Date;
      control: SpendControl;
      required: number;
      boundVersion: string | null;
    },
  ): Promise<void> {
    assertCreditAmounts({
      ceiling: input.required,
      held: input.required,
      applied: 0,
      finalized: false,
    });
    const paid = input.required > 0;
    if (paid) {
      const funds =
        await tx.execute(sql`select a.user_id from assistant_credit_accounts a where a.user_id=${input.userId}
        and a.balance::bigint-(select coalesce(sum(held_credits),0) from assistant_credit_turns where user_id=${input.userId})>=${input.required}`);
      if (!funds.rows.length)
        throw AppError.conflict('CREDIT_BALANCE_CHANGED', 'Credit reservation no longer fits');
    }
    await tx.execute(sql`insert into assistant_credit_turns
   (usage_ledger_id,user_id,message_id,conversation_id,accepted_at,free_day,policy_key,policy_epoch,
    funding_source,reserved_ceiling,held_credits,applied_credits,bound_version,state,finalized_at,updated_at)
   values (${input.usageId},${input.userId},${input.messageId},${input.conversationId},${input.acceptedAt.toISOString()}::timestamptz,
    case when ${paid} then null else (${input.acceptedAt.toISOString()}::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date end,
    ${input.control.policy_key},${input.control.epoch}::bigint,${paid ? 'credit' : 'free'},${input.required},${input.required},0,
    ${input.boundVersion},${paid ? 'pending' : 'settled'},${paid ? null : input.acceptedAt.toISOString()}::timestamptz,${input.acceptedAt.toISOString()}::timestamptz)`);
  }
  async facts(exec: CreditExec, userId: string, conversationId: string) {
    const r =
      await exec.execute(sql`select ${conversationCreditsSql(sql`c.id`, sql`c.user_id`)} as credits,
   coalesce((select jsonb_object_agg(m.id,${turnCreditsSql(sql`m.id`, sql`m.user_id`)}) from assistant_messages m
    where m.conversation_id=c.id and m.role='assistant'),'{}'::jsonb) as turns
   from assistant_conversations c where c.id=${conversationId} and c.user_id=${userId}`);
    if (!r.rows.length) throw AppError.notFound();
    const facts = r.rows[0] as {
      credits: AssistantConversationCredits;
      turns: Record<string, AssistantTurnCredits>;
    };
    assertPublicCredits([
      facts.credits.creditsUsed,
      facts.credits.creditsReserved,
      facts.credits.pendingTurns,
    ]);
    for (const turn of Object.values(facts.turns))
      assertPublicCredits([turn.creditsCharged, turn.creditsReserved]);
    return facts;
  }
  /** D2 supplies complete authoritative evidence at this revision. Discovery stays
   * unlocked; acquire the account before reservation/usage row locks. */
  async applyRevision(
    userId: string,
    usageId: string,
    revision: bigint,
    target: number,
    environment: 'all' | 'dev' | 'staging' | 'production',
    final = false,
    refundOnly = false,
  ) {
    let committed:
      { delta: number; released: number; finalized: boolean; acceptedAt: string } | undefined;
    const result = await this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      if (!(await resolveBooleanFlag(tx, 'assistant_credits.settlement_enabled', { environment })))
        return 'paused' as const;
      const result = await tx.execute(sql`select t.* from assistant_credit_turns t
    join users u on u.id=t.user_id where t.usage_ledger_id=${usageId} and t.user_id=${userId}
     and u.status<>'deleted' for update of t`);
      const t = result.rows[0] as CreditTurnRow | undefined;
      if (!t || t.state === 'erased' || t.funding_source !== 'credit') return 'ignored' as const;
      if (refundOnly && target > t.applied_credits)
        throw new RangeError('Refund target cannot increase a charge');
      if (
        revision < BigInt(t.applied_cost_revision) ||
        (revision === BigInt(t.applied_cost_revision) && (!final || t.finalized_at !== null))
      )
        return 'duplicate' as const;
      if (revision === BigInt(t.applied_cost_revision) && target !== t.applied_credits)
        throw new RangeError('Revision target changed');
      const usage =
        await tx.execute(sql`select cost_revision::text,dispatch_closed_at,cost_finalized_at from assistant_usage_ledger
    where id=${usageId} for update`);
      const evidence = usage.rows[0] as
        | {
            cost_revision: string;
            dispatch_closed_at: string | null;
            cost_finalized_at: string | null;
          }
        | undefined;
      if (evidence && revision < BigInt(evidence.cost_revision)) return 'duplicate' as const;
      if (
        !evidence ||
        revision !== BigInt(evidence.cost_revision) ||
        revision !== BigInt(t.cost_revision) ||
        (final && (!evidence.dispatch_closed_at || !evidence.cost_finalized_at))
      )
        throw new RangeError('Incomplete billing evidence');
      let next;
      try {
        next = reviseCredits(
          {
            ceiling: t.reserved_ceiling,
            held: t.held_credits,
            applied: t.applied_credits,
            finalized: t.finalized_at !== null,
          },
          target,
          final,
        );
      } catch {
        await tx.execute(
          sql`update assistant_credit_turns set state='quarantined',updated_at=clock_timestamp() where usage_ledger_id=${usageId}`,
        );
        await tx.execute(
          sql`insert into assistant_credit_billing_incidents(usage_ledger_id,reason) values(${usageId},'bound_or_finality') on conflict do nothing`,
        );
        await writeAudit(tx, {
          actorType: 'system',
          action: 'assistant.credit_quarantined',
          resourceType: 'assistant_usage',
          resourceId: usageId,
          diff: { revision: revision.toString() },
        });
        this.metrics.increment('assistant_credit_bound_violation_total', {
          reason: 'bound_or_finality',
        });
        return 'quarantined' as const;
      }
      if (t.state === 'quarantined') return 'quarantined' as const;
      if (next.delta !== 0) {
        const base = await tx.execute(
          sql`select id from assistant_credit_ledger where usage_ledger_id=${usageId} and reason='message_spent'`,
        );
        const account =
          await tx.execute(sql`update assistant_credit_accounts set balance=balance+${next.delta}
          where user_id=${userId} and balance::bigint+${next.delta} between 0 and 2147483647 returning balance`);
        if (!account.rows.length) {
          await tx.execute(
            sql`update assistant_credit_turns set state='quarantined',updated_at=clock_timestamp() where usage_ledger_id=${usageId}`,
          );
          await tx.execute(
            sql`insert into assistant_credit_billing_incidents(usage_ledger_id,reason) values(${usageId},'account_invariant') on conflict do nothing`,
          );
          await writeAudit(tx, {
            actorType: 'system',
            action: 'assistant.credit_quarantined',
            resourceType: 'assistant_usage',
            resourceId: usageId,
            diff: { revision: revision.toString(), reason: 'account_invariant' },
          });
          this.metrics.increment('assistant_credit_account_mismatch_total', {});
          return 'quarantined' as const;
        }
        await tx.execute(sql`insert into assistant_credit_ledger(user_id,delta,reason,usage_ledger_id,cost_revision)
          values(${userId},${next.delta},${base.rows.length ? 'assistant_usage_adjustment' : 'message_spent'},${usageId},${revision.toString()}::bigint)`);
      }
      await tx.execute(sql`update assistant_credit_turns set applied_credits=${next.applied},held_credits=${next.held},
    applied_cost_revision=${revision.toString()}::bigint,state=${next.finalized ? 'settled' : 'reconciling'},
    finalized_at=case when ${next.finalized} then coalesce(finalized_at,clock_timestamp()) else null end,
    updated_at=clock_timestamp() where usage_ledger_id=${usageId}`);
      await writeAudit(tx, {
        actorType: 'system',
        action: 'assistant.credit_revision_applied',
        resourceType: 'assistant_usage',
        resourceId: usageId,
        diff: {
          revision: revision.toString(),
          delta: next.delta,
          held: next.held,
          final: next.finalized,
        },
      });
      // Durable notification/audit marker commits with the financial revision.
      await tx.execute(sql`insert into outbox_events(event_type,resource_type,resource_id,payload)
        values('assistant.credit_applied','assistant_usage',${usageId},${JSON.stringify({ revision: revision.toString() })}::jsonb)`);
      committed = {
        delta: next.delta,
        released: t.held_credits + next.delta - next.held,
        finalized: next.finalized,
        acceptedAt: t.accepted_at,
      };
      return 'applied' as const;
    });
    if (result === 'applied' && committed) {
      if (committed.delta < 0)
        this.metrics.increment('assistant_credit_charged_total', {}, -committed.delta);
      if (committed.delta > 0)
        this.metrics.increment('assistant_credit_refunded_total', {}, committed.delta);
      if (committed.released > 0)
        this.metrics.increment('assistant_credit_released_total', {}, committed.released);
      if (committed.finalized && Number.isFinite(new Date(committed.acceptedAt).getTime()))
        this.metrics.observe(
          'assistant_credit_settlement_latency_seconds',
          Math.max(0, (Date.now() - new Date(committed.acceptedAt).getTime()) / 1000),
          {},
        );
    }
    return result;
  }
  /** Refund is a lower aggregate target at a new authoritative revision. */
  refund(
    userId: string,
    usageId: string,
    revision: bigint,
    target: number,
    environment: 'all' | 'dev' | 'staging' | 'production',
  ) {
    return this.applyRevision(userId, usageId, revision, target, environment, false, true);
  }
  /** Requires durable dispatch closure by the fenced runner; no TTL release. */
  async releaseUndispatched(
    userId: string,
    usageId: string,
    environment: 'all' | 'dev' | 'staging' | 'production',
    proof?: { messageId: string },
  ) {
    return this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      if (!(await resolveBooleanFlag(tx, 'assistant_credits.settlement_enabled', { environment })))
        return false;
      const r =
        await tx.execute(sql`select t.* from assistant_credit_turns t join users u on u.id=t.user_id
    where t.usage_ledger_id=${usageId} and t.user_id=${userId} and u.status<>'deleted' for update of t`);
      const t = r.rows[0] as CreditTurnRow | undefined;
      if (!t || t.state !== 'pending' || t.applied_credits !== 0) return false;
      if (proof)
        await tx.execute(sql`update assistant_usage_ledger set dispatch_closed_at=clock_timestamp(),cost_finalized_at=clock_timestamp()
     where id=${usageId} and message_id=${proof.messageId} and not exists(select 1 from assistant_usage_calls where usage_ledger_id=${usageId})
     and exists(select 1 from assistant_messages where id=${proof.messageId} and user_id=${userId} and status<>'streaming')`);
      const u =
        await tx.execute(sql`select id from assistant_usage_ledger where id=${usageId} and dispatch_closed_at is not null
    and not exists(select 1 from assistant_usage_calls where usage_ledger_id=${usageId} and dispatch_state<>'intent') for update`);
      if (!u.rows.length) return false;
      await tx.execute(sql`update assistant_credit_turns set held_credits=0,state='settled',
    finalized_at=clock_timestamp(),updated_at=clock_timestamp() where usage_ledger_id=${usageId}`);
      await writeAudit(tx, {
        actorType: 'system',
        action: 'assistant.credit_undispatched_released',
        resourceType: 'assistant_usage',
        resourceId: usageId,
      });
      return true;
    });
  }
}
