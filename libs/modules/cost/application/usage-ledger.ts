import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricLabels, MetricsPort } from '@gogo/observability';
import { operationForSku, utcDay } from '../domain/provider-pricing';
import { COST_REGISTRY } from '../domain/registry';

/**
 * PR2 / COST-BE-002 (#335) — the durable accounting boundary, chosen per
 * §2.3. Full reasoning in `docs/adr/0012-durable-provider-usage-accounting.md`.
 *
 * **Option A: a buffered ledger behind the metrics port.**
 *
 * `ProviderMetrics.increment` is synchronous and returns `void`
 * (`libs/providers/src/ports.ts`). There is no version of "await a DB write
 * from inside it" that is honest — the adapter cannot wait for something the
 * signature says has already finished — so the choice is not *whether* to
 * decouple but *where* the decoupling is admitted. Here it is admitted in the
 * type: `flush()` is the awaited operation, and the two places that must not
 * lose counts (`onApplicationShutdown` in the API, the worker's `shutdown`)
 * call it.
 *
 * What this is NOT: fire-and-forget dressed up as accounting. Three properties
 * make the difference, and all three are tested:
 *
 * 1. **Failure is visible and lossless-until-it-isn't.** A failed flush puts
 *    the counts back in the buffer and increments
 *    `provider_usage_ledger_flush_total{outcome="error"}`. The next flush
 *    carries them. Nothing is silently dropped.
 * 2. **The loss window is bounded and named.** SIGKILL loses at most one flush
 *    interval (`COST_LEDGER_FLUSH_MS`, 5s). SIGTERM loses nothing. Reconciling
 *    a gap against Grafana `increase()` is the documented procedure, and the
 *    number it produces is labelled `basis: ESTIMATED`.
 * 3. **It is not the safety mechanism.** Nothing decides whether to spend
 *    money by reading this table; `provider_budget_daily` does that, before
 *    the call, atomically, with its own row. Accounting that is a few counts
 *    behind is a reporting inaccuracy. A budget that is a few counts behind is
 *    an outage or an invoice.
 *
 * Rejected here (§2.3 B): awaiting a DB upsert per Google call at the
 * orchestrators. It is exact, but it puts a database round trip in the
 * critical path of every provider call, it has to be re-added by hand at every
 * future call site, and nothing in this PR needs exactness at that price.
 */

/** One row's worth of counts, keyed by the day the calls actually happened. */
type BufferKey = string; // `${day}|${operation}`

type Counts = { attempted: number; succeeded: number; units: number };

export type UsageLedgerOptions = {
  environment: string;
  /** How long counts may sit in memory. The SIGKILL loss window. */
  flushMs?: number;
  /** Where flush outcomes are counted. Never the ledger itself — that recurses. */
  metrics?: Pick<MetricsPort, 'increment'>;
  /** Off makes every method a no-op. `COST_LEDGER_ENABLED=false` rolls this PR back. */
  enabled?: boolean;
};

export const DEFAULT_LEDGER_FLUSH_MS = 5_000;

/**
 * Accumulates provider call counts in memory and upserts them into
 * `provider_usage_daily`.
 *
 * Implements `MetricsPort` so it can be a third target of the `TeeMetrics`
 * that already fans every metric to the log stream and the scrape registry.
 * That placement is what makes it complete without touching a single adapter:
 * every provider call already emits `places_provider_requests_total`, and the
 * one that did not (`google.expand`) is instrumented in this PR.
 */
export class DbUsageLedger implements MetricsPort {
  private readonly buffer = new Map<BufferKey, Counts>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly environment: string;
  private readonly flushMs: number;
  private readonly metrics: Pick<MetricsPort, 'increment'> | null;
  private readonly enabled: boolean;

  constructor(
    private readonly db: Db,
    options: UsageLedgerOptions,
  ) {
    this.environment = options.environment;
    this.flushMs = options.flushMs ?? DEFAULT_LEDGER_FLUSH_MS;
    this.metrics = options.metrics ?? null;
    this.enabled = options.enabled ?? true;
  }

  /**
   * The only two metrics that carry accounting facts.
   *
   * `places_provider_requests_total{method,status}` is every attempt with the
   * HTTP status Google answered; a 2xx is a success and a success is what gets
   * billed. `places_provider_cost_units{sku}` is the billable quantity, which
   * is *not* one per call for Routes — it increments by the number of matrix
   * elements, so the `by` argument is the amount and must be respected.
   *
   * Everything else the tee sends here is ignored, on purpose. A ledger that
   * tried to persist every counter in the system would be a second metrics
   * backend, which is not what this is.
   */
  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    if (!this.enabled || by <= 0) return;
    if (name === 'places_provider_requests_total') {
      const operation = stringLabel(labels.method);
      if (operation === null) return;
      const status = String(labels.status ?? '');
      const counts = this.slot(operation);
      counts.attempted += by;
      if (status.startsWith('2')) counts.succeeded += by;
      return;
    }
    if (name === 'places_provider_cost_units') {
      const sku = stringLabel(labels.sku);
      if (sku === null) return;
      this.slot(operationForSku(sku)).units += by;
    }
  }

  /**
   * Durations are not accounting. They live in a histogram, they are already
   * scraped, and persisting them here would turn a cost ledger into a
   * time-series database.
   */
  observe(): void {}

  async time<T>(_name: string, _labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /** Begin flushing on an interval. Idempotent. */
  start(): void {
    if (!this.enabled || this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    // A flush timer must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  /** Stop the interval and write everything still buffered. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.drain();
  }

  /**
   * Flush until nothing is buffered.
   *
   * #336: one `flush()` is not a drain, and the shutdown path assumed it was.
   * `flush()` joins a flush already in flight and resolves when *that* one
   * resolves — but `flushOnce` clears the buffer before it awaits the write,
   * so anything counted during the write lands in a fresh buffer that the
   * joined promise knows nothing about. On SIGTERM that is a silent loss, and
   * ADR-0012 §"loss window" says in as many words that SIGTERM loses nothing.
   * It now does.
   *
   * Bounded rather than `while`: a database that fails every write would spin
   * here forever, and a shutdown that never completes is worse than a count
   * that is one flush short. The last error propagates, as `flush()` already
   * did, so a failing drain is still visible in the flush counter and in the
   * exit path.
   */
  async drain(maxPasses = 5): Promise<void> {
    if (!this.enabled) return;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      await this.flush();
      if (this.buffer.size === 0) return;
    }
  }

  /**
   * Write the buffer.
   *
   * Serialised against itself: two overlapping flushes would each drain a
   * partial buffer and the failure path would put the same counts back twice.
   * Concurrent callers await the flush already in flight.
   */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    if (this.flushing !== null) return this.flushing;
    const run = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.size === 0) return;
    // Drained before the await, so calls arriving during the write accumulate
    // into a fresh buffer instead of being lost to the clear that follows it.
    const drained = [...this.buffer.entries()];
    this.buffer.clear();

    const values = drained.map(([key, counts]) => {
      const [day, operation] = splitKey(key);
      return sql`(${day}::date, ${this.environment}, ${operation}, ${counts.attempted}, ${counts.succeeded}, ${counts.units}, now())`;
    });

    // COST-BE-016 (#368): the same counts, dual-written as canonical meter
    // rows (epic §9). `calls` is the attempted count under the operation's
    // non-billable meter; the billable meter — `requests` for Places,
    // `billable_elements` for Routes — carries the billed quantity under its
    // SKU. An operation the registry does not know gets `calls` only, under
    // the service its prefix attributes it to, so an unregistered label is
    // still visible rather than silently uncounted.
    const meterValues = drained.flatMap(([key, counts]) => {
      const [day, operation] = splitKey(key);
      return meterRowsFor(day, this.environment, operation, counts).map(
        (r) =>
          sql`(${r.day}::date, ${r.environment}, ${r.providerId}, ${r.serviceId}, ${r.operationId}, ${r.metric}, ${r.billingSkuId}, ${r.quantity}, ${r.unit}, 'ledger', 'HIGH', now(), now())`,
      );
    });

    try {
      // One transaction in production, so the two tables never disagree by a
      // flush window. The unit spec's fake `db` has no `transaction`; there
      // the two statements run in sequence against the same fake, which is
      // enough to pin the ledger's own arithmetic and failure handling.
      const write = async (exec: Pick<Db, 'execute'>) => {
        await exec.execute(sql`
          insert into provider_usage_daily
            (day, environment, operation, calls_attempted, calls_succeeded, billable_units, updated_at)
          values ${sql.join(values, sql`, `)}
          on conflict (day, environment, operation) do update set
            calls_attempted = provider_usage_daily.calls_attempted + excluded.calls_attempted,
            calls_succeeded = provider_usage_daily.calls_succeeded + excluded.calls_succeeded,
            billable_units  = provider_usage_daily.billable_units  + excluded.billable_units,
            updated_at      = now()
        `);
        if (meterValues.length > 0) {
          await exec.execute(sql`
            insert into provider_usage_meter_daily
              (day, environment, provider_id, service_id, operation_id, usage_metric_id,
               billing_sku_id, quantity, unit, source, confidence, collected_at, updated_at)
            values ${sql.join(meterValues, sql`, `)}
            on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                         usage_metric_id, coalesce(billing_sku_id, ''), source)
            do update set
              quantity     = provider_usage_meter_daily.quantity + excluded.quantity,
              collected_at = now(),
              updated_at   = now()
          `);
        }
      };
      if (typeof (this.db as { transaction?: unknown }).transaction === 'function') {
        await this.db.transaction(async (tx) => write(tx));
      } else {
        await write(this.db);
      }
      this.metrics?.increment('provider_usage_ledger_flush_total', {
        outcome: 'ok',
      });
    } catch (err) {
      // Put them back. A ledger that drops counts on a transient database blip
      // and says nothing is worse than no ledger: the number it prints later
      // still looks authoritative.
      for (const [key, counts] of drained) {
        const slot = this.buffer.get(key) ?? { attempted: 0, succeeded: 0, units: 0 };
        slot.attempted += counts.attempted;
        slot.succeeded += counts.succeeded;
        slot.units += counts.units;
        this.buffer.set(key, slot);
      }
      this.metrics?.increment('provider_usage_ledger_flush_total', { outcome: 'error' });
      throw err;
    }
  }

  /** Test seam: what is still unwritten. */
  pending(): number {
    return this.buffer.size;
  }

  private slot(operation: string): Counts {
    // Keyed by the day the call happened. A buffer that spans midnight must
    // not post yesterday's calls to today — the whole table is per-day.
    const key = `${utcDay()}|${operation}`;
    const existing = this.buffer.get(key);
    if (existing) return existing;
    const fresh: Counts = { attempted: 0, succeeded: 0, units: 0 };
    this.buffer.set(key, fresh);
    return fresh;
  }
}

type MeterRow = {
  day: string;
  environment: string;
  providerId: string;
  serviceId: string;
  operationId: string;
  metric: string;
  billingSkuId: string | null;
  quantity: number;
  unit: string;
};

/**
 * The canonical rows one ledger slot becomes. Exported for the spec: the
 * mapping is the whole of what #368 adds to the write path, and it must be
 * pinned without a database.
 */
export function meterRowsFor(
  day: string,
  environment: string,
  operation: string,
  counts: { attempted: number; succeeded: number; units: number },
): MeterRow[] {
  const service = COST_REGISTRY.serviceForOperation(operation);
  if (service === null) return [];
  const provider = service.providerId;
  const rows: MeterRow[] = [];
  const calls = COST_REGISTRY.callsMeterFor(operation);
  if (counts.attempted > 0) {
    rows.push({
      day,
      environment,
      providerId: provider,
      serviceId: service.id,
      operationId: operation,
      metric: calls?.metric ?? 'calls',
      billingSkuId: null,
      quantity: counts.attempted,
      unit: calls?.unit ?? 'request',
    });
  }
  const billable = COST_REGISTRY.billableMeterFor(operation);
  if (billable !== null && counts.units > 0) {
    rows.push({
      day,
      environment,
      providerId: provider,
      serviceId: service.id,
      operationId: operation,
      metric: billable.metric,
      billingSkuId: billable.billingSkuId,
      quantity: counts.units,
      unit: billable.unit,
    });
  }
  return rows;
}

function stringLabel(value: MetricLabels[string]): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function splitKey(key: BufferKey): [string, string] {
  const at = key.indexOf('|');
  return [key.slice(0, at), key.slice(at + 1)];
}

/** DI token. Exported so the API can flush it on shutdown. */
export const COST_USAGE_LEDGER = Symbol('COST_USAGE_LEDGER');
