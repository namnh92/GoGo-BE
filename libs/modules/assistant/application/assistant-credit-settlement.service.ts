import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { AssistantReceiptReader } from '@gogo/providers';
import { NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { FlagEnvironment } from '../../shared/feature-flags';
import { lockAssistantAccount } from '../../shared/assistant-credits';
import { AssistantCreditSpendRepository } from '../infrastructure/assistant-credit-spend.repository';
import {
  AssistantUsageEvidenceRepository,
  quarantineCost,
} from '../infrastructure/assistant-usage-evidence.repository';
import { costCredits } from '../domain/credit-cost';

/** One use case shared by outbox delivery and bounded sweep. No inference port. */
export class AssistantCreditSettlementService {
  private readonly spend: AssistantCreditSpendRepository;
  private readonly evidence: AssistantUsageEvidenceRepository;
  constructor(
    private readonly db: Db,
    private readonly environment: FlagEnvironment,
    private readonly metrics: MetricsPort = new NoopMetrics(),
    private readonly receipts?: AssistantReceiptReader,
  ) {
    this.spend = new AssistantCreditSpendRepository(db, metrics);
    this.evidence = new AssistantUsageEvidenceRepository(db, metrics);
  }
  async reconcile(usageId: string, signal: AbortSignal) {
    // Recovery can close a terminal orphan's dispatch fence, never rerun a call.
    await this.evidence.closeDispatch(usageId);
    const calls = await this.db
      .execute(sql`select c.call_index,c.provider,c.provider_generation_id from assistant_usage_calls c
      join assistant_usage_ledger u on u.id=c.usage_ledger_id
      where c.usage_ledger_id=${usageId} and u.user_id is not null
      and c.cost_state in ('unknown','complete') and c.provider_generation_id is not null
      order by (c.cost_state='unknown') desc,c.updated_at,c.call_index limit 4`);
    for (const call of calls.rows as {
      call_index: number;
      provider: string;
      provider_generation_id: string;
    }[]) {
      signal.throwIfAborted();
      if (this.receipts && (call.provider === 'jev' || call.provider === 'haiku')) {
        try {
          const receipt = await this.receipts.read(
            call.provider,
            call.provider_generation_id,
            AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          );
          if (receipt) await this.evidence.ingest(usageId, call.call_index, receipt);
        } catch {
          signal.throwIfAborted();
          this.metrics.increment('assistant_credit_settlement_total', {
            outcome: 'receipt_unavailable',
          });
          // A failed retrieval never destroys an already complete revision.
          // Missing evidence remains pending; known correctable cost may apply.
        } finally {
          await this.evidence.recoveryAttempted(usageId, call.call_index);
        }
      }
    }
    // One statement snapshot: totals and revision cannot come from different receipts.
    const r = await this.db
      .execute(sql`select t.user_id,t.funding_source,t.state,u.cost_revision::text,
      u.dispatch_closed_at is not null as closed,u.cost_finalized_at is not null as final,
      not exists(select 1 from assistant_usage_calls c where c.usage_ledger_id=u.id and
        (c.cost_state not in ('complete','final') or c.direct_cost_usd is null or c.upstream_cost_usd is null or c.fee_cost_usd is null)) as complete,
      (select coalesce(sum(direct_cost_usd+upstream_cost_usd+fee_cost_usd),0)::text
        from assistant_usage_calls where usage_ledger_id=u.id) as total
      from assistant_credit_turns t join assistant_usage_ledger u on u.id=t.usage_ledger_id
      where t.usage_ledger_id=${usageId}`);
    const t = r.rows[0] as
      | {
          user_id: string | null;
          funding_source: string;
          state: string;
          cost_revision: string;
          closed: boolean;
          final: boolean;
          complete: boolean;
          total: string;
        }
      | undefined;
    if (!t?.user_id || t.state === 'erased' || t.funding_source === 'free')
      return this.outcome('ignored');
    if (t.state === 'quarantined') {
      this.metrics.increment('assistant_credit_bound_violation_total', {
        reason: 'evidence_quarantined',
      });
      return this.outcome('quarantined');
    }
    // Until dispatch closes, a future call could make this a partial aggregate.
    if (!t.closed || !t.complete) return this.outcome('pending');
    let target: number;
    try {
      target = costCredits([t.total]);
    } catch {
      await this.db.transaction(async (tx) => {
        await lockAssistantAccount(tx, t.user_id!);
        const current =
          await tx.execute(sql`select cost_revision from assistant_credit_turns where usage_ledger_id=${usageId}
          and user_id=${t.user_id} and cost_revision=${t.cost_revision}::bigint and state<>'erased' for update`);
        if (current.rows.length) await quarantineCost(tx, usageId, 'invalid_cost');
      });
      this.metrics.increment('assistant_credit_bound_violation_total', { reason: 'invalid_cost' });
      return this.outcome('quarantined');
    }
    const result = await this.spend.applyRevision(
      t.user_id,
      usageId,
      BigInt(t.cost_revision),
      target,
      this.environment,
      t.final,
    );
    return this.outcome(result);
  }
  private outcome<T extends string>(outcome: T): T {
    this.metrics.increment('assistant_credit_settlement_total', { outcome });
    return outcome;
  }
}
