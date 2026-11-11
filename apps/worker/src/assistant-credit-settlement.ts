import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  AssistantCreditSettlementService,
  COST_RECONCILE_EVENT,
  RECEIPT_RECOVERY_BACKOFF_SECONDS,
  RECEIPT_RECOVERY_WINDOW_SECONDS,
} from '@gogo/modules';
import { OpenRouterAssistantReceiptReader } from '@gogo/providers';
import type { MetricsPort } from '@gogo/observability';

/** Periodic runner already holds a worker_leases row (safe through PgBouncer).
 * Per-turn CAS leases cover outbox/sweep overlap without holding rows while
 * waiting for the shared account lock. Revisions remain the financial dedupe. */
export class AssistantCreditSettlementWorker {
  constructor(
    private readonly db: Db,
    private readonly service: AssistantCreditSettlementService,
    private readonly metrics?: MetricsPort,
  ) {}
  async tick(signal: AbortSignal, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid settlement batch');
    const outbox = await this.db
      .execute(sql`select id,resource_id,extract(epoch from now()-occurred_at)::float8 as lag
      from outbox_events where event_type=${COST_RECONCILE_EVENT} and published_at is null
      and (next_attempt_at is null or next_attempt_at<=now()) order by next_attempt_at nulls first,occurred_at limit ${limit}`);
    const sweep = await this.db.execute(sql`select usage_ledger_id from assistant_credit_turns
      where funding_source='credit' and state in ('pending','reconciling','settled') and (next_reconcile_at is null or next_reconcile_at<=now())
      and exists(select 1 from assistant_usage_ledger u where u.id=usage_ledger_id and u.user_id is not null
        and (u.cost_finalized_at is null or (funding_source='credit' and u.cost_revision>applied_cost_revision)))
      order by state,next_reconcile_at nulls first limit ${limit}`);
    const ids = new Set<string>([
      ...outbox.rows.map((r) => (r as { resource_id: string }).resource_id),
      ...sweep.rows.map((r) => (r as { usage_ledger_id: string }).usage_ledger_id),
    ]);
    for (const usageId of ids) {
      signal.throwIfAborted();
      const owner = randomUUID();
      const wakeup = outbox.rows.some(
        (r) => (r as { resource_id: string }).resource_id === usageId,
      );
      const lease = await this.db
        .execute(sql`update assistant_credit_turns set lease_owner=${owner},lease_expires_at=now()+interval '2 minutes'
        where usage_ledger_id=${usageId} and state<>'erased' and (lease_expires_at is null or lease_expires_at<now())
        and (${wakeup} or next_reconcile_at is null or next_reconcile_at<=now()) returning cost_revision::text,retry_count`);
      if (!lease.rows.length) continue;
      const before = lease.rows[0] as { cost_revision: string; retry_count: number };
      let outcome: string = 'retry';
      try {
        outcome = await this.service.reconcile(
          usageId,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        );
      } catch {
        this.metrics?.increment('assistant_credit_settlement_total', { outcome: 'retry' });
      }
      const retry = outcome === 'pending' || outcome === 'paused' || outcome === 'retry';
      const delay = Math.min(3600, 5 * 2 ** Math.min(before.retry_count, 10));
      // Snapshot the delivered IDs: a new wakeup produced during reconcile must
      // survive this ACK. Commit-before-ACK crash simply repeats the revision.
      const delivered = outbox.rows.filter(
        (r) => (r as { resource_id: string }).resource_id === usageId,
      ) as { id: string; lag: number }[];
      await this.db.transaction(async (tx) => {
        // A usage owns its recovery schedule, independent of deliveries/ticks.
        // Exhausted attempts wait for the 24h quarantine deadline.
        const next = sql`case
          when state in ('erased','quarantined') or funding_source='free' then null
          when cost_revision<>${before.cost_revision}::bigint and cost_revision>applied_cost_revision then now()
          when ${retry} and exists(select 1 from assistant_usage_calls c
            where c.usage_ledger_id=assistant_credit_turns.usage_ledger_id and c.cost_state='unknown')
            then case when not exists(select 1 from assistant_usage_calls c
              where c.usage_ledger_id=assistant_credit_turns.usage_ledger_id and c.cost_state='unknown'
                and c.provider in ('jev','haiku') and c.provider_generation_id is not null)
              then accepted_at+make_interval(secs=>${RECEIPT_RECOVERY_WINDOW_SECONDS})
              else least(accepted_at+make_interval(secs=>${RECEIPT_RECOVERY_WINDOW_SECONDS}),
              coalesce(recovery_next_at,accepted_at+make_interval(secs=>${RECEIPT_RECOVERY_BACKOFF_SECONDS[0]}))) end
          when ${retry} then now()+make_interval(secs=>${delay}) else null end`;
        const owned =
          await tx.execute(sql`update assistant_credit_turns set lease_owner=null,lease_expires_at=null,
          retry_count=case when ${retry} then least(retry_count+1,1000000) else 0 end,
          next_reconcile_at=${next}
          where usage_ledger_id=${usageId} and lease_owner=${owner} returning usage_ledger_id,next_reconcile_at`);
        if (!owned.rows.length) return;
        const scheduled = (owned.rows[0] as { next_reconcile_at: string | null }).next_reconcile_at;
        for (const event of delivered) {
          this.metrics?.observe(
            'assistant_credit_reconciliation_queue_lag_seconds',
            Number(event.lag),
            {},
          );
          await tx.execute(sql`update outbox_events set published_at=case when ${retry} then null else now() end,
            next_attempt_at=case when ${retry} then ${scheduled ?? null}::timestamptz else null end,
            attempts=least(attempts+1,1000000),last_error=case when ${retry} then 'settlement_pending' else null end
            where id=${event.id}`);
        }
      });
    }
    return ids.size;
  }
}
export function assistantCreditSettlementFromEnv(
  db: Db,
  env: Record<string, string | undefined>,
  metrics: MetricsPort,
) {
  const environment =
    env.APP_ENV === 'prod' || env.APP_ENV === 'production'
      ? 'production'
      : env.APP_ENV === 'staging'
        ? 'staging'
        : 'dev';
  const reader = new OpenRouterAssistantReceiptReader({
    jev: env.OPENROUTER_API_KEY ?? '',
    haiku: env.OPENROUTER_ASSISTANT_API_KEY ?? '',
  });
  return new AssistantCreditSettlementWorker(
    db,
    new AssistantCreditSettlementService(db, environment, metrics, reader),
    metrics,
  );
}

export async function collectAssistantSettlementHealth(
  db: Db,
  registry: {
    gauge(name: string, value: number): void;
    increment(name: string, labels: Record<string, never>, by: number): void;
  },
) {
  const unresolved = sql`u.billing_policy='free_then_actual_cost_v1' and
    (u.cost_finalized_at is null or t.state in ('pending','reconciling','quarantined') or
     exists(select 1 from assistant_credit_billing_incidents i where i.usage_ledger_id=u.id and i.resolved_at is null))`;
  const r = await db.execute(sql`select
    (select count(*)::int from assistant_usage_ledger u left join assistant_credit_turns t on t.usage_ledger_id=u.id where ${unresolved}) as unresolved,
    (select coalesce(extract(epoch from now()-min(u.accepted_at)),0)::float8 from assistant_usage_ledger u left join assistant_credit_turns t on t.usage_ledger_id=u.id where ${unresolved}) as oldest,
    (select count(*)::int from assistant_credit_accounts a where a.balance::bigint<>(select coalesce(sum(delta::bigint),0) from assistant_credit_ledger l where l.user_id=a.user_id)) as account_mismatch,
    (select count(*)::int from (select t.user_id,sum(t.held_credits::bigint) held from assistant_credit_turns t where t.held_credits>0 group by t.user_id) h
      left join assistant_credit_accounts a on a.user_id=h.user_id where h.held>coalesce(a.balance,0) or h.held<0) as hold_mismatch,
    (select count(*)::int from assistant_credit_turns t where funding_source='free' and exists(select 1 from assistant_credit_ledger l where l.usage_ledger_id=t.usage_ledger_id and l.reason in ('message_spent','assistant_usage_adjustment'))) as free_violation`);
  const row = r.rows[0] as {
    unresolved: number;
    oldest: number;
    account_mismatch: number;
    hold_mismatch: number;
    free_violation: number;
  };
  registry.gauge('assistant_credit_unresolved_count', row.unresolved);
  registry.gauge('assistant_credit_unresolved_oldest_age_seconds', Number(row.oldest));
  if (row.account_mismatch > 0)
    registry.increment('assistant_credit_account_mismatch_total', {}, row.account_mismatch);
  if (row.hold_mismatch > 0)
    registry.increment('assistant_credit_hold_mismatch_total', {}, row.hold_mismatch);
  if (row.free_violation > 0)
    registry.increment('assistant_credit_free_allowance_violation_total', {}, row.free_violation);
}
