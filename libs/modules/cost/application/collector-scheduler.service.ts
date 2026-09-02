import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import {
  defaultMonitoringBudgetMicros,
  isEnabledIn,
  monitoringCostSummary,
  type CollectorDefinition,
  type MonitoringCostSummary,
} from '../domain/collector';
import { freshnessStatus, nextAttemptDelayMs, type FreshnessStatus } from '../domain/freshness';
import { utcDay } from '../domain/provider-pricing';
import type { CostRegistry } from '../domain/registry';

/**
 * COST-BE-017 (#369) — epic §19 (generic scheduler), §20–§22 (cost of cost,
 * guardrails), §23 (freshness), §38 (failure isolation).
 *
 *     for each registered enabled collector:
 *       if due: collect → validate → persist → update freshness
 *
 * Runs inside one worker periodic job; the job's advisory lock keeps two
 * replicas from ticking at once, and *this* class keeps one collector from
 * hurting another: every run is wrapped, timed out, and recorded on its own
 * freshness row. A collector that throws marks itself UNAVAILABLE and backs
 * off; the next collector runs regardless; consumer traffic never sees any of
 * it (the tick is in the worker, off every request path).
 *
 * Money guard (epic §20/§22): before running anything, the scheduler sums the
 * declared monthly monitoring cost of the enabled collectors. If it exceeds
 * the environment's budget, non-essential collectors are skipped this tick and
 * marked STALE, and a warning is logged and counted. The Cost Center reports
 * the same sum as the internal provider `gogo.cost_observability` (see
 * `monitoringCostRows`).
 */

export type CollectorOutcome =
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'skipped_not_due'
  | 'skipped_budget'
  | 'skipped_calls_cap'
  | 'skipped_env';

export type CollectorTickReport = {
  environment: string;
  monitoring: MonitoringCostSummary & { budgetMicros: number; overBudget: boolean };
  results: { collector: string; outcome: CollectorOutcome; errorCode?: string; samples?: number }[];
};

export type SchedulerLogger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

type FreshnessRow = {
  source_id: string;
  last_successful_at: Date | string | null;
  last_attempt_at: Date | string | null;
  consecutive_failures: number | string;
  calls_day: string | null;
  calls_count: number | string;
};

const toDate = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

export class CollectorSchedulerService {
  private readonly collectors = new Map<string, CollectorDefinition>();

  constructor(
    private readonly db: Db,
    private readonly registry: CostRegistry,
    private readonly options: {
      environment: string;
      metrics?: Pick<MetricsPort, 'increment' | 'observe'>;
      logger?: SchedulerLogger;
      /** Micros per month. Defaults per epic §20 (DEV $1, PROD $5). */
      monitoringBudgetMicros?: number;
      now?: () => Date;
    },
  ) {}

  /**
   * Registration is refused when the definitions registry does not know the
   * provider, or the provider does not declare the collector's capability
   * (epic §6/§7) — the two registries cannot disagree quietly.
   */
  register(def: CollectorDefinition): this {
    if (this.collectors.has(def.id)) throw new Error(`collector ${def.id} already registered`);
    if (this.registry.provider(def.providerId) === null) {
      throw new Error(`collector ${def.id}: unknown provider ${def.providerId}`);
    }
    if (!this.registry.hasCapability(def.providerId, def.capability)) {
      throw new Error(`collector ${def.id}: ${def.providerId} does not declare ${def.capability}`);
    }
    if (
      def.serviceId !== null &&
      this.registry.service(def.serviceId)?.providerId !== def.providerId
    ) {
      throw new Error(`collector ${def.id}: service ${def.serviceId} is not ${def.providerId}'s`);
    }
    if (def.essential && def.monitoringCost.model !== 'FREE') {
      throw new Error(`collector ${def.id}: only a FREE collector may be essential`);
    }
    this.collectors.set(def.id, def);
    return this;
  }

  registered(): readonly CollectorDefinition[] {
    return [...this.collectors.values()];
  }

  private enabledCollectors(): CollectorDefinition[] {
    return this.registered().filter((c) => isEnabledIn(c, this.options.environment));
  }

  /** Epic §20/§21 — what tracking costs, for this environment's enabled set. */
  monitoring(): CollectorTickReport['monitoring'] {
    const summary = monitoringCostSummary(this.enabledCollectors());
    const budgetMicros =
      this.options.monitoringBudgetMicros ??
      defaultMonitoringBudgetMicros(this.options.environment);
    return { ...summary, budgetMicros, overBudget: summary.knownMonthlyMicros > budgetMicros };
  }

  async tick(): Promise<CollectorTickReport> {
    const now = (this.options.now ?? (() => new Date()))();
    const env = this.options.environment;
    const monitoring = this.monitoring();
    if (monitoring.overBudget) {
      this.options.logger?.warn(
        {
          knownMonthlyMicros: monitoring.knownMonthlyMicros,
          budgetMicros: monitoring.budgetMicros,
        },
        'cost monitoring over budget — pausing non-essential collectors',
      );
      this.options.metrics?.increment('cost_monitoring_over_budget_total', {});
    }
    const results: CollectorTickReport['results'] = [];
    const rows = await this.freshnessRows();

    for (const def of this.registered()) {
      if (!isEnabledIn(def, env)) {
        results.push({ collector: def.id, outcome: 'skipped_env' });
        continue;
      }
      const row = rows.get(def.id) ?? null;
      const lastAttempt = toDate(row?.last_attempt_at ?? null);
      const failures = Number(row?.consecutive_failures ?? 0);
      const dueAt =
        lastAttempt === null
          ? now
          : new Date(lastAttempt.getTime() + nextAttemptDelayMs(def.frequencyMs, failures));
      if (dueAt > now) {
        results.push({ collector: def.id, outcome: 'skipped_not_due' });
        continue;
      }
      if (monitoring.overBudget && !def.essential) {
        await this.markStatus(def, row, now, 'skipped_budget');
        results.push({ collector: def.id, outcome: 'skipped_budget' });
        this.record(def, 'skipped_budget');
        continue;
      }
      const day = utcDay(now);
      const callsToday = row?.calls_day === day ? Number(row.calls_count) : 0;
      if (def.maxCallsPerDay !== null && callsToday >= def.maxCallsPerDay) {
        results.push({ collector: def.id, outcome: 'skipped_calls_cap' });
        this.record(def, 'skipped_calls_cap');
        continue;
      }

      const outcome = await this.runOne(def, now, day, failures, callsToday);
      results.push(outcome);
      this.record(def, outcome.outcome);
    }
    return { environment: env, monitoring, results };
  }

  private async runOne(
    def: CollectorDefinition,
    now: Date,
    day: string,
    priorFailures: number,
    callsToday: number,
  ): Promise<CollectorTickReport['results'][number]> {
    const started = Date.now();
    let attempts = 0;
    let lastError: unknown = null;
    while (attempts < Math.max(1, def.retry.maxAttemptsPerTick)) {
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), def.timeoutMs);
      try {
        const result = await Promise.race([
          def.run({ environment: this.options.environment, now, day, signal: controller.signal }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new CollectorTimeout()), {
              once: true,
            });
          }),
        ]);
        clearTimeout(timer);
        await this.persistSuccess(def, now, day, callsToday + attempts, result.sourceAsOf);
        this.options.metrics?.observe(
          'cost_collector_duration_seconds',
          (Date.now() - started) / 1000,
          {
            collector: def.id,
          },
        );
        return { collector: def.id, outcome: 'ok', samples: result.samples };
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (err instanceof CollectorTimeout) break; // a timeout is not retried in-tick
      }
    }
    const errorCode = lastError instanceof CollectorTimeout ? 'TIMEOUT' : errorCodeOf(lastError);
    await this.persistFailure(def, now, day, callsToday + attempts, priorFailures + 1, errorCode);
    this.options.logger?.error(
      { collector: def.id, errorCode, consecutiveFailures: priorFailures + 1 },
      'cost collector failed',
    );
    this.options.metrics?.observe(
      'cost_collector_duration_seconds',
      (Date.now() - started) / 1000,
      {
        collector: def.id,
      },
    );
    return {
      collector: def.id,
      outcome: lastError instanceof CollectorTimeout ? 'timeout' : 'failed',
      errorCode,
    };
  }

  private record(def: CollectorDefinition, outcome: CollectorOutcome): void {
    this.options.metrics?.increment('cost_collector_runs_total', { collector: def.id, outcome });
  }

  private async freshnessRows(): Promise<Map<string, FreshnessRow>> {
    const { rows } = await this.db.execute(sql`
      select source_id, last_successful_at, last_attempt_at, consecutive_failures, calls_day, calls_count
      from cost_source_freshness
      where environment = ${this.options.environment}
    `);
    return new Map((rows as unknown as FreshnessRow[]).map((r) => [r.source_id, r]));
  }

  private statusFor(
    def: CollectorDefinition,
    facts: {
      lastSuccessfulAt: Date | null;
      lastAttemptAt: Date | null;
      consecutiveFailures: number;
    },
    now: Date,
  ): FreshnessStatus {
    return freshnessStatus({ ...facts, staleAfterMs: def.staleAfterMs }, now);
  }

  private async persistSuccess(
    def: CollectorDefinition,
    now: Date,
    day: string,
    callsCount: number,
    sourceAsOf: Date | null,
  ) {
    const status = this.statusFor(
      def,
      { lastSuccessfulAt: now, lastAttemptAt: now, consecutiveFailures: 0 },
      now,
    );
    await this.db.execute(sql`
      insert into cost_source_freshness
        (environment, source_id, provider_id, service_id, last_successful_at, last_attempt_at,
         source_as_of, stale_after_s, status, last_error_code, consecutive_failures, calls_day, calls_count, updated_at)
      values (${this.options.environment}, ${def.id}, ${def.providerId}, ${def.serviceId}, ${now.toISOString()},
              ${now.toISOString()}, ${sourceAsOf?.toISOString() ?? null}, ${Math.round(def.staleAfterMs / 1000)},
              ${status}, ${null}, ${0}, ${day}::date, ${callsCount}, now())
      on conflict (environment, source_id) do update set
        provider_id = excluded.provider_id,
        service_id = excluded.service_id,
        last_successful_at = excluded.last_successful_at,
        last_attempt_at = excluded.last_attempt_at,
        source_as_of = excluded.source_as_of,
        stale_after_s = excluded.stale_after_s,
        status = excluded.status,
        last_error_code = null,
        consecutive_failures = 0,
        calls_day = excluded.calls_day,
        calls_count = case when cost_source_freshness.calls_day = excluded.calls_day
                           then greatest(cost_source_freshness.calls_count, excluded.calls_count)
                           else excluded.calls_count end,
        updated_at = now()
    `);
  }

  private async persistFailure(
    def: CollectorDefinition,
    now: Date,
    day: string,
    callsCount: number,
    failures: number,
    errorCode: string,
  ) {
    // Status needs the last success, which only the row knows; compute in SQL
    // from the stored facts so a restart cannot lose the distinction between
    // STALE and UNAVAILABLE.
    await this.db.execute(sql`
      insert into cost_source_freshness
        (environment, source_id, provider_id, service_id, last_successful_at, last_attempt_at,
         source_as_of, stale_after_s, status, last_error_code, consecutive_failures, calls_day, calls_count, updated_at)
      values (${this.options.environment}, ${def.id}, ${def.providerId}, ${def.serviceId}, ${null},
              ${now.toISOString()}, ${null}, ${Math.round(def.staleAfterMs / 1000)},
              ${'UNAVAILABLE'}, ${errorCode}, ${failures}, ${day}::date, ${callsCount}, now())
      on conflict (environment, source_id) do update set
        last_attempt_at = excluded.last_attempt_at,
        stale_after_s = excluded.stale_after_s,
        last_error_code = excluded.last_error_code,
        consecutive_failures = excluded.consecutive_failures,
        status = case
          when cost_source_freshness.last_successful_at is null then 'UNAVAILABLE'
          when cost_source_freshness.last_successful_at >= ${now.toISOString()}::timestamptz - make_interval(secs => excluded.stale_after_s) then 'FRESH'
          else 'UNAVAILABLE' end,
        calls_day = excluded.calls_day,
        calls_count = case when cost_source_freshness.calls_day = excluded.calls_day
                           then greatest(cost_source_freshness.calls_count, excluded.calls_count)
                           else excluded.calls_count end,
        updated_at = now()
    `);
  }

  /** Budget pause: the row keeps its facts; only the label moves to STALE. */
  private async markStatus(
    def: CollectorDefinition,
    row: FreshnessRow | null,
    now: Date,
    reason: 'skipped_budget',
  ) {
    void now;
    void reason;
    if (row === null) return;
    await this.db.execute(sql`
      update cost_source_freshness
      set status = case when status = 'UNKNOWN' then 'UNKNOWN' else 'STALE' end, updated_at = now()
      where environment = ${this.options.environment} and source_id = ${def.id}
    `);
  }

  /**
   * Epic §21 — the internal provider's daily row: today's share of the known
   * monthly monitoring cost, `basis = FIXED`, `source = 'monitoring_cost_model'`,
   * under `gogo.cost_observability`. Written by the same tick so the Cost
   * Center can show "cost of tracking" next to "cost tracked". Unknown
   * collectors are named in metadata; the amount is a floor when any exist.
   */
  async writeMonitoringCostRow(
    now: Date = (this.options.now ?? (() => new Date()))(),
  ): Promise<void> {
    const m = this.monitoring();
    const day = utcDay(now);
    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const daily = Math.ceil(m.knownMonthlyMicros / daysInMonth);
    const metadata = JSON.stringify({
      knownMonthlyMicros: m.knownMonthlyMicros,
      unknownCollectors: m.unknown,
      needsApproval: m.needsApproval,
      budgetMicros: m.budgetMicros,
      overBudget: m.overBudget,
      collectors: this.enabledCollectors().map((c) => c.id),
    });
    await this.db.execute(sql`
      insert into provider_cost_daily
        (day, environment, provider_id, service_id, amount_micros, currency, basis, confidence, source,
         collected_at, metadata)
      values (${day}::date, ${this.options.environment}, 'gogo', 'gogo.cost_observability', ${daily}, ${m.currency},
              'FIXED', ${m.unknown.length > 0 ? 'LOW' : 'HIGH'}, 'monitoring_cost_model', now(), ${metadata}::jsonb)
      on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                   coalesce(usage_metric_id, ''), coalesce(billing_sku_id, ''), source, basis)
      do update set amount_micros = excluded.amount_micros, confidence = excluded.confidence,
                    metadata = excluded.metadata, collected_at = now(), updated_at = now()
    `);
  }
}

class CollectorTimeout extends Error {
  constructor() {
    super('collector timed out');
    this.name = 'CollectorTimeout';
  }
}

/** A status code for the row, never a message. */
function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0 && code.length <= 64) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name.toUpperCase().slice(0, 64);
  }
  return 'ERROR';
}
