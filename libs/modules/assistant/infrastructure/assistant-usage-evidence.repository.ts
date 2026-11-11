import { Inject, Injectable, Optional } from '@nestjs/common';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { AssistantBillingObserver, AssistantCostReceipt } from '@gogo/providers';
import { DB } from '../../shared/tokens';
import { lockAssistantAccount } from '../../shared/assistant-credits';
import { resolveBooleanFlag, type FlagEnvironment } from '../../shared/feature-flags';
import { writeAudit } from '../../shared/audit';
import type { CreditExec } from './assistant-credit-spend.repository';

export const COST_RECONCILE_EVENT = 'assistant.cost_reconcile';
export async function enqueueCostReconcile(tx: CreditExec, usageId: string): Promise<void> {
  await tx.execute(sql`insert into outbox_events(event_type,resource_type,resource_id,payload)
    select ${COST_RECONCILE_EVENT},'assistant_usage',${usageId},'{}'::jsonb
    where exists(select 1 from assistant_credit_turns where usage_ledger_id=${usageId} and state<>'erased')`);
  await tx.execute(
    sql`update assistant_credit_turns set next_reconcile_at=now() where usage_ledger_id=${usageId} and state<>'erased'`,
  );
}
export async function quarantineCost(
  tx: Pick<Db, 'execute' | 'insert'>,
  usageId: string,
  reason: 'invalid_cost' | 'receipt_conflict',
) {
  await tx.execute(sql`update assistant_credit_turns set state='quarantined',updated_at=now()
    where usage_ledger_id=${usageId} and funding_source='credit' and state<>'erased'`);
  await tx.execute(
    sql`insert into assistant_credit_billing_incidents(usage_ledger_id,reason) values(${usageId},${reason}) on conflict do nothing`,
  );
  await writeAudit(tx, {
    actorType: 'system',
    action: 'assistant.cost_quarantined',
    resourceType: 'assistant_usage',
    resourceId: usageId,
    diff: { reason },
  });
}

@Injectable()
export class AssistantUsageEvidenceRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  observer(
    input: { userId: string; ledgerId: string; messageId: string },
    environment: FlagEnvironment,
  ): AssistantBillingObserver {
    return {
      start: async (provider, model) => {
        const requestId = randomUUID();
        // An intent is durable before even the dispatch claim. A lost claim is
        // never permission for the worker to rerun the request.
        const callIndex = await this.db.transaction(async (tx) => {
          await lockAssistantAccount(tx, input.userId);
          if (!(await resolveBooleanFlag(tx, 'assistant.enabled', { environment })))
            throw new Error('Dispatch disabled');
          const readiness = await tx.execute(sql`select exists(select 1 from assistant_usage_ledger
          where haiku_is_byok=false and accepted_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC') as violated`);
          if ((readiness.rows[0] as { violated: boolean } | undefined)?.violated)
            throw new Error('Provider billing safeguards unavailable');
          const u =
            await tx.execute(sql`select u.id from assistant_usage_ledger u join users a on a.id=u.user_id
          join assistant_messages m on m.id=u.message_id
          where u.id=${input.ledgerId} and u.user_id=${input.userId} and m.id=${input.messageId}
          and a.status='active' and m.status='streaming' and m.lease_expires_at>now()
          and u.dispatch_closed_at is null for update of u`);
          if (!u.rows.length) throw new Error('Dispatch fenced');
          const r =
            await tx.execute(sql`insert into assistant_usage_calls(usage_ledger_id,call_index,provider,model,correlation_id,provider_request_id)
          select ${input.ledgerId},coalesce(max(call_index)+1,0),${provider},${model},${requestId}::uuid,${requestId}
          from assistant_usage_calls where usage_ledger_id=${input.ledgerId} returning call_index`);
          return (r.rows[0] as { call_index: number }).call_index;
        });
        await this.db.transaction(async (tx) => {
          await lockAssistantAccount(tx, input.userId);
          if (!(await resolveBooleanFlag(tx, 'assistant.enabled', { environment })))
            throw new Error('Dispatch disabled');
          const readiness = await tx.execute(sql`select exists(select 1 from assistant_usage_ledger
          where haiku_is_byok=false and accepted_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC') as violated`);
          if ((readiness.rows[0] as { violated: boolean } | undefined)?.violated)
            throw new Error('Provider billing safeguards unavailable');
          const u =
            await tx.execute(sql`select u.id from assistant_usage_ledger u join users a on a.id=u.user_id
          join assistant_messages m on m.id=u.message_id where u.id=${input.ledgerId} and u.user_id=${input.userId}
          and a.status='active' and m.status='streaming' and m.lease_expires_at>now() and u.dispatch_closed_at is null for update of u`);
          if (!u.rows.length) throw new Error('Dispatch fenced');
          await tx.execute(sql`update assistant_usage_calls set dispatch_state='dispatched',dispatched_at=now(),updated_at=now()
          where usage_ledger_id=${input.ledgerId} and call_index=${callIndex} and dispatch_state='intent'`);
        });
        return {
          requestId,
          generation: (id) => this.generation(input.ledgerId, callIndex, id),
          receipt: (receipt) =>
            this.ingest(input.ledgerId, callIndex, receipt).then(() => undefined),
        };
      },
    };
  }
  /** Identity discovery must not hold a usage/call row while waiting for account. */
  private async account(usageId: string): Promise<string | null> {
    const r = await this.db.execute(
      sql`select user_id from assistant_usage_ledger where id=${usageId}`,
    );
    return (r.rows[0] as { user_id: string | null } | undefined)?.user_id ?? null;
  }
  async generation(usageId: string, callIndex: number, id: string): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(id)) return;
    const userId = await this.account(usageId);
    if (!userId) return;
    await this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      await tx.execute(sql`update assistant_usage_calls c set provider_generation_id=${id},updated_at=now()
        where usage_ledger_id=${usageId} and call_index=${callIndex} and provider_generation_id is null
        and exists(select 1 from assistant_usage_ledger where id=${usageId} and user_id=${userId})`);
    });
  }
  async recoveryAttempted(usageId: string, callIndex: number): Promise<void> {
    const userId = await this.account(usageId);
    if (!userId) return;
    await this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      await tx.execute(sql`update assistant_usage_calls set updated_at=now() where usage_ledger_id=${usageId} and call_index=${callIndex}
        and exists(select 1 from assistant_usage_ledger where id=${usageId} and user_id=${userId})`);
    });
  }
  async ingest(usageId: string, callIndex: number, receipt: AssistantCostReceipt) {
    const userId = await this.account(usageId);
    if (!userId) return 'erased' as const;
    const result = await this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      const u = await tx.execute(
        sql`select id from assistant_usage_ledger where id=${usageId} and user_id=${userId} for update`,
      );
      if (!u.rows.length) return 'erased' as const;
      const r = await tx.execute(
        sql`select * from assistant_usage_calls where usage_ledger_id=${usageId} and call_index=${callIndex} for update`,
      );
      const call = r.rows[0] as
        | {
            receipt_revision: string | null;
            cost_state: string;
            provider_generation_id: string | null;
          }
        | undefined;
      if (!call) throw new Error('Missing call intent');
      try {
        if (
          [receipt.direct, receipt.upstream, receipt.fee].some(
            (v) => v.length > 1000 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v),
          )
        )
          throw new RangeError();
        if (
          receipt.generationId !== undefined &&
          !/^[A-Za-z0-9._:-]{1,256}$/.test(receipt.generationId)
        )
          throw new RangeError();
        if (receipt.revision < 1n || receipt.revision > 9223372036854775807n)
          throw new RangeError();
      } catch {
        await tx.execute(
          sql`update assistant_usage_calls set cost_state='quarantined' where usage_ledger_id=${usageId} and call_index=${callIndex}`,
        );
        await quarantineCost(tx, usageId, 'invalid_cost');
        await enqueueCostReconcile(tx, usageId);
        return 'quarantined' as const;
      }
      const normalized = [receipt.direct, receipt.upstream, receipt.fee].map((v) =>
        v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v,
      );
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([receipt.revision.toString(), ...normalized, receipt.final]))
        .digest('hex');
      const old =
        await tx.execute(sql`select receipt_revision::text,fingerprint from assistant_usage_receipts
        where usage_ledger_id=${usageId} and call_index=${callIndex}
        and (receipt_revision=${receipt.revision.toString()}::bigint or fingerprint=${fingerprint})`);
      if (old.rows.some((row) => (row as { fingerprint: string }).fingerprint === fingerprint))
        return 'duplicate' as const;
      await tx.execute(sql`insert into assistant_usage_receipts(usage_ledger_id,call_index,receipt_revision,fingerprint,direct_cost_usd,upstream_cost_usd,fee_cost_usd,final)
        values(${usageId},${callIndex},${receipt.revision.toString()}::bigint,${fingerprint},${receipt.direct}::numeric,${receipt.upstream}::numeric,${receipt.fee}::numeric,${receipt.final})`);
      if (receipt.revision < BigInt(call.receipt_revision ?? '0')) return 'stale' as const;
      if (
        old.rows.length ||
        receipt.revision === BigInt(call.receipt_revision ?? '0') ||
        (receipt.generationId &&
          call.provider_generation_id &&
          receipt.generationId !== call.provider_generation_id)
      ) {
        await quarantineCost(tx, usageId, 'receipt_conflict');
        await tx.execute(
          sql`update assistant_usage_calls set cost_state='quarantined' where usage_ledger_id=${usageId} and call_index=${callIndex}`,
        );
        await enqueueCostReconcile(tx, usageId);
        return 'quarantined' as const;
      }
      if (call.cost_state === 'quarantined') return 'quarantined' as const;
      await tx.execute(sql`update assistant_usage_calls set direct_cost_usd=${receipt.direct}::numeric,
        upstream_cost_usd=${receipt.upstream}::numeric,fee_cost_usd=${receipt.fee}::numeric,
        receipt_revision=${receipt.revision.toString()}::bigint,receipt_fingerprint=${fingerprint},
        provider_generation_id=coalesce(provider_generation_id,${receipt.generationId ?? null}),
        cost_state=${receipt.final ? 'final' : 'complete'},dispatch_state='closed',
        finalized_at=case when ${receipt.final} then now() else null end,updated_at=now()
        where usage_ledger_id=${usageId} and call_index=${callIndex}`);
      // Finality is derived from every attempt AND durable dispatch closure.
      await this.advance(tx, usageId);
      return 'ingested' as const;
    });
    if (result === 'quarantined')
      this.metrics.increment('assistant_credit_bound_violation_total', {
        reason: 'evidence_quarantined',
      });
    return result;
  }
  private async advance(tx: CreditExec, usageId: string) {
    const r = await tx.execute(sql`update assistant_usage_ledger set cost_revision=cost_revision+1,
      cost_finalized_at=case when dispatch_closed_at is not null and not exists(
        select 1 from assistant_usage_calls where usage_ledger_id=${usageId} and cost_state<>'final') then now() else null end
      where id=${usageId} returning cost_revision::text`);
    if (!r.rows.length) return;
    await tx.execute(sql`update assistant_credit_turns set cost_revision=${(r.rows[0] as { cost_revision: string }).cost_revision}::bigint,
      updated_at=now() where usage_ledger_id=${usageId} and state<>'erased'`);
    await enqueueCostReconcile(tx, usageId);
  }
  /** Caller has fenced further dispatch (terminal message or local runner end). */
  async closeDispatch(usageId: string) {
    const userId = await this.account(usageId);
    if (!userId) return;
    await this.db.transaction(async (tx) => {
      await lockAssistantAccount(tx, userId);
      const u =
        await tx.execute(sql`select u.id from assistant_usage_ledger u where u.id=${usageId} and u.user_id=${userId}
        and u.dispatch_closed_at is null and not exists(select 1 from assistant_messages m where m.id=u.message_id and m.status='streaming') for update`);
      if (!u.rows.length) return;
      await tx.execute(
        sql`update assistant_usage_ledger set dispatch_closed_at=now() where id=${usageId}`,
      );
      // A durable intent without a dispatch claim is provably unattempted once
      // this fence commits. Dispatched/ambiguous attempts remain unknown.
      await tx.execute(sql`update assistant_usage_calls set dispatch_state='closed',cost_state='final',
        direct_cost_usd=0,upstream_cost_usd=0,fee_cost_usd=0,finalized_at=now()
        where usage_ledger_id=${usageId} and dispatch_state='intent'`);
      await this.advance(tx, usageId);
    });
  }
}
