import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import type { MetricLabels, MetricsPort } from '@gogo/observability';
import { billingOperationOf, utcDay } from '../domain/provider-pricing';

/**
 * COST-BE-002 (#335) — durable accounting for provider calls.
 *
 * ## Why this shape (plan §2.3, option A)
 *
 * `ProviderMetrics.increment` is synchronous and sits on the hot path of every
 * Google call. Three shapes were on the table:
 *
 * - **A — buffer behind the metrics port** (this file): accumulate in memory,
 *   flush on an interval and on shutdown. No latency coupling at all; loses at
 *   most one flush window if the process is `SIGKILL`ed.
 * - **B — await a DB write at each orchestrator**: exact, but adds an awaited
 *   round trip per Google call and has to be re-applied at every future call
 *   site, enforced by nothing.
 * - **C — a new async sink port on the adapter**: near-exact, but a new port
 *   through `libs/providers`, which deliberately depends on no `@gogo/*`
 *   package.
 *
 * A wins because of what this data is *for*. Usage is accounting and trend —
 * it answers "what did last month cost", where being a few seconds behind is
 * irrelevant and a bounded gap after a hard kill is reconcilable against
 * Grafana `increase()`. The number that must never be optimistic is the
 * *budget reservation*, and that is a separate, awaited, atomic write that
 * happens **before** the call (`ProviderBudgetService`). Exactness is bought
 * where it protects money, not where it protects a graph.
 *
 * The rule that outranks all three: **nothing awaits a database write before
 * the provider call on a consumer path.** A user waiting on a place lookup
 * must not also wait on our bookkeeping.
 *
 * ## Reconciliation
 *
 * A gap only appears on `SIGKILL`/OOM — a graceful stop flushes. When one is
 * suspected, Grafana's `increase(places_provider_requests_total[…])` over the
 * same window is the reference, and the corrected figure is reported with
 * `basis: 'ESTIMATED'`. The ledger never silently back-fills: a number that
 * repaired itself without saying so is worse than a visible gap.
 */

/** Metric names this ledger understands. Anything else passes straight through. */
const REQUESTS = 'places_provider_requests_total';
const COST_UNITS = 'places_provider_cost_units';

type Bucket = { attempted: number; succeeded: number; units: number };

export type UsageLedgerOptions = {
  environment: string;
  /** Off by default in tests and anywhere the flag is not set (`cost.ledger.enabled`). */
  enabled: boolean;
  flushMs: number;
};

/**
 * Wraps a `MetricsPort` and, as a side effect, accumulates what Google billed.
 *
 * Decorator rather than a second call site: every adapter already emits these
 * counters, so the ledger sees each call exactly once without any adapter
 * knowing it exists, and a future adapter is accounted for by construction
 * rather than by someone remembering.
 */
export class DbUsageLedger implements MetricsPort {
  private readonly buckets = new Map<string, Bucket>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly inner: MetricsPort,
    private readonly db: Db,
    private readonly options: UsageLedgerOptions,
  ) {}

  /** Starts the flush loop. `unref` so a timer never holds a process open. */
  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushMs);
    this.timer.unref?.();
  }

  /** Graceful shutdown: stop the loop, then write what is still buffered. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.inner.increment(name, labels, by);
    if (!this.options.enabled) return;
    if (name === REQUESTS) {
      const operation = billingOperationOf(String(labels['method'] ?? ''));
      if (!operation) return;
      // `status` is the HTTP code the adapter saw. 2xx is what Google bills
      // for; everything else attempted and cost nothing, and the difference
      // between the two columns is what makes a day of 500s legible.
      const status = Number(labels['status'] ?? 0);
      const bucket = this.bucketFor(operation);
      bucket.attempted += by;
      if (status >= 200 && status < 300) bucket.succeeded += by;
      return;
    }
    if (name === COST_UNITS) {
      const operation = String(labels['sku'] ?? '');
      if (!operation) return;
      // Already the billing label, and `by` is already the unit count — one
      // per Places request, one per Routes matrix *element*.
      this.bucketFor(operation).units += by;
    }
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    this.inner.observe(name, value, labels);
  }

  time<T>(name: string, labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
    return this.inner.time(name, labels, fn);
  }

  /**
   * Writes the buffer out and clears it.
   *
   * Serialised against itself: two overlapping flushes would both read the
   * same buffer and double-count. The buffer is taken before the first await,
   * so calls arriving during a flush accumulate into the next one rather than
   * being lost.
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const pending = [...this.buckets.entries()];
    if (pending.length === 0) return;
    this.buckets.clear();
    const day = utcDay();
    this.flushing = this.write(day, pending)
      .catch((err: unknown) => {
        // Put the counts back so a transient database error costs accuracy for
        // one window rather than permanently. Merged, not overwritten: calls
        // that arrived during the failed flush are already in the map.
        for (const [operation, bucket] of pending) {
          const current = this.bucketFor(operation);
          current.attempted += bucket.attempted;
          current.succeeded += bucket.succeeded;
          current.units += bucket.units;
        }
        this.inner.increment('provider_usage_ledger_flush_total', { result: 'error' });
        throw err;
      })
      .finally(() => {
        this.flushing = undefined;
      });
    // The interval owns the failure: a rejected flush must not become an
    // unhandled rejection, and the counts are already restored above.
    return this.flushing.catch(() => undefined);
  }

  private async write(day: string, pending: [string, Bucket][]): Promise<void> {
    for (const [operation, bucket] of pending) {
      await this.db.execute(sql`
        insert into provider_usage_daily
          (day, environment, operation, calls_attempted, calls_succeeded, billable_units, updated_at)
        values (${day}::date, ${this.options.environment}, ${operation},
                ${bucket.attempted}, ${bucket.succeeded}, ${bucket.units}, now())
        on conflict (day, environment, operation) do update
          set calls_attempted = provider_usage_daily.calls_attempted + excluded.calls_attempted,
              calls_succeeded = provider_usage_daily.calls_succeeded + excluded.calls_succeeded,
              billable_units  = provider_usage_daily.billable_units  + excluded.billable_units,
              updated_at      = now()
      `);
    }
    this.inner.increment('provider_usage_ledger_flush_total', { result: 'ok' });
  }

  private bucketFor(operation: string): Bucket {
    const existing = this.buckets.get(operation);
    if (existing) return existing;
    const created: Bucket = { attempted: 0, succeeded: 0, units: 0 };
    this.buckets.set(operation, created);
    return created;
  }
}
