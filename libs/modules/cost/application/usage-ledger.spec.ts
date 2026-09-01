import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { MetricLabels, MetricsPort } from '@gogo/observability';
import { DbUsageLedger } from './usage-ledger';

/**
 * #335 — the ledger must count what Google billed, pass every metric through
 * untouched, and never make a caller wait.
 */

function recorder() {
  const counters: { name: string; labels: MetricLabels; by: number }[] = [];
  const inner: MetricsPort = {
    increment: (name, labels = {}, by = 1) => void counters.push({ name, labels, by }),
    observe: () => undefined,
    time: <T>(_n: string, _l: MetricLabels, fn: () => Promise<T>) => fn(),
  };
  return { inner, counters };
}

/**
 * The bound parameters of a drizzle `sql` template, in order.
 *
 * Asserting on these rather than on the serialised object: the SQL text is an
 * implementation detail that will change, while "which numbers reached the
 * database" is the actual claim every test here wants to make.
 */
function paramsOf(query: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object') {
      // A bare scalar inside the chunk list is a bound value.
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record['queryChunks'])) {
      walk(record['queryChunks']);
      return;
    }
    // A `StringChunk` carries an array of SQL text; skip it. A `Param` carries
    // the scalar that was interpolated.
    if (Array.isArray(record['value'])) return;
    if ('value' in record) out.push(record['value']);
  };
  walk(query);
  return out;
}

function fakeDb() {
  const statements: unknown[][] = [];
  let fail = false;
  const db = {
    execute: async (query: unknown) => {
      if (fail) throw new Error('db down');
      statements.push(paramsOf(query));
      return { rows: [] };
    },
  } as unknown as Db;
  return { db, statements, setFail: (v: boolean) => void (fail = v) };
}

function build(enabled = true) {
  const { inner, counters } = recorder();
  const { db, statements, setFail } = fakeDb();
  const ledger = new DbUsageLedger(inner, db, {
    environment: 'test',
    enabled,
    flushMs: 60_000,
  });
  return { ledger, inner, counters, statements, setFail };
}

/**
 * Flushes and returns the one written row as
 * `[day, environment, operation, attempted, succeeded, units]`.
 */
async function flushedRow(ledger: DbUsageLedger, statements: unknown[][]) {
  await ledger.flush();
  const params = statements.at(-1) ?? [];
  return {
    operation: params[2],
    attempted: params[3],
    succeeded: params[4],
    units: params[5],
  };
}

describe('pass-through', () => {
  it('forwards every metric to the real port, ledger or not', async () => {
    const { ledger, counters } = build();
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.core',
      status: 200,
    });
    ledger.observe('place_provider_request_duration_seconds', 0.2, { method: 'x' });

    // The ledger is a decorator. If it ever swallowed a metric, the Grafana
    // series that reconciles it would be the thing that went missing.
    expect(counters.map((c) => c.name)).toContain('places_provider_requests_total');
  });

  it('counts nothing while disabled, but still forwards', async () => {
    const { ledger, counters, statements } = build(false);
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' }, 3);
    await ledger.flush();

    expect(counters).toHaveLength(1);
    expect(statements).toHaveLength(0);
  });
});

describe('what gets counted', () => {
  it('separates attempted from succeeded by HTTP status', async () => {
    const { ledger, statements } = build();
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.core',
      status: 200,
    });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.core',
      status: 500,
    });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.core',
      status: 429,
    });

    const row = await flushedRow(ledger, statements);
    // A day of 500s costs nothing and must not read as a quiet day: three
    // attempts, one success.
    expect(row.attempted).toBe(3);
    expect(row.succeeded).toBe(1);
  });

  it('files Routes calls and Routes money under one operation', async () => {
    const { ledger, statements } = build();
    // Requests arrive labelled google.routeMatrix; units arrive labelled
    // routes.computeRouteMatrix. Ungrouped, that is two rows for one thing.
    ledger.increment('places_provider_requests_total', {
      method: 'google.routeMatrix',
      status: 200,
    });
    ledger.increment('places_provider_cost_units', { sku: 'routes.computeRouteMatrix' }, 12);

    const row = await flushedRow(ledger, statements);
    expect(statements).toHaveLength(1);
    expect(row.operation).toBe('routes.computeRouteMatrix');
    expect(row.attempted).toBe(1);
    expect(row.units).toBe(12);
  });

  it('takes the unit count from the counter, not one per call', async () => {
    const { ledger, statements } = build();
    // A 20-destination matrix is one call and twenty billable elements.
    ledger.increment('places_provider_cost_units', { sku: 'routes.computeRouteMatrix' }, 20);

    const row = await flushedRow(ledger, statements);
    expect(row.units).toBe(20);
  });

  it('ignores metrics that are not about provider spend', async () => {
    const { ledger, statements } = build();
    ledger.increment('place_import_rows_total', { status: 'ready' });
    ledger.increment('places_provider_failures_total', {
      method: 'google.details.core',
      status: 500,
    });

    await ledger.flush();
    expect(statements).toHaveLength(0);
  });
});

describe('flush', () => {
  it('writes one statement per operation and then empties', async () => {
    const { ledger, statements } = build();
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' }, 2);
    ledger.increment('places_provider_cost_units', { sku: 'google.details.quality' }, 5);

    await ledger.flush();
    expect(statements).toHaveLength(2);

    // Second flush has nothing to say — the buffer was cleared, so counts
    // cannot be written twice.
    await ledger.flush();
    expect(statements).toHaveLength(2);
  });

  it('does nothing when there is nothing buffered', async () => {
    const { ledger, statements } = build();
    await ledger.flush();
    expect(statements).toHaveLength(0);
  });

  it('puts the counts back when the write fails', async () => {
    const { ledger, statements, setFail, counters } = build();
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' }, 7);

    setFail(true);
    await ledger.flush();
    expect(statements).toHaveLength(0);
    expect(counters.some((c) => c.name === 'provider_usage_ledger_flush_total')).toBe(true);

    // A transient database error costs accuracy for one window, not forever.
    setFail(false);
    const row = await flushedRow(ledger, statements);
    expect(row.units).toBe(7);
  });

  it('does not reject into the caller — the interval owns the failure', async () => {
    const { ledger, setFail } = build();
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' }, 1);
    setFail(true);
    // An unhandled rejection from a timer would take the process down over
    // bookkeeping.
    await expect(ledger.flush()).resolves.toBeUndefined();
  });

  it('stop() flushes what is buffered', async () => {
    const { ledger, statements } = build();
    ledger.start();
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' }, 4);

    await ledger.stop();
    expect(statements.at(-1)?.[5]).toBe(4);
  });
});

describe('the timer', () => {
  it('does not hold the process open', () => {
    const { ledger } = build();
    const spy = vi.spyOn(global, 'setInterval');
    ledger.start();
    const timer = spy.mock.results[0]?.value as { unref?: unknown } | undefined;
    // A metrics timer that keeps a worker alive turns a graceful shutdown
    // into a hang.
    expect(typeof timer?.unref).toBe('function');
    void ledger.stop();
    spy.mockRestore();
  });

  it('stays off while disabled', () => {
    const { ledger } = build(false);
    const spy = vi.spyOn(global, 'setInterval');
    ledger.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
