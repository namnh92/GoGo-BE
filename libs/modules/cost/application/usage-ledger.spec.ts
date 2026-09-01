import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { DbUsageLedger } from './usage-ledger';

/**
 * #335 — the ledger's own guarantees, without a database.
 *
 * What is under test is the part that makes this accounting rather than
 * fire-and-forget: the counts it keeps, the counts it refuses to keep, and
 * what happens to them when the write fails.
 */

type Executed = { sql: string; params: unknown[] };

/** Renders the drizzle template the way the driver would, so the bound
 *  parameters — which is where the counts actually are — can be asserted. */
const dialect = new PgDialect();

function fakeDb(onExecute?: () => void) {
  const executed: Executed[] = [];
  const db = {
    execute: vi.fn(async (query: SQL) => {
      onExecute?.();
      const rendered = dialect.sqlToQuery(query);
      executed.push({ sql: rendered.sql, params: rendered.params });
      return { rows: [] };
    }),
  } as unknown as Db;
  return { db, executed };
}

function recorder() {
  const counts: { name: string; labels: Record<string, unknown> }[] = [];
  return {
    counts,
    increment: (name: string, labels: Record<string, unknown> = {}) =>
      void counts.push({ name, labels }),
  };
}

describe('DbUsageLedger', () => {
  it('separates attempted, succeeded and billable units', async () => {
    const { db, executed } = fakeDb();
    const ledger = new DbUsageLedger(db, { environment: 'dev' });

    ledger.increment('places_provider_requests_total', {
      method: 'google.details.quality',
      status: 200,
    });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.quality',
      status: 429,
    });
    ledger.increment('places_provider_cost_units', { sku: 'google.details.quality' });

    await ledger.flush();

    // Two attempts, one served, one unit billed. A table that stored only
    // "calls" could not tell an expensive day from a broken one.
    const params = executed[0]!.params;
    expect(params).toContain('google.details.quality');
    expect(params.slice(-3)).toEqual([2, 1, 1]);
  });

  it('counts Routes by matrix element, not by call', () => {
    const { db } = fakeDb();
    const ledger = new DbUsageLedger(db, { environment: 'dev' });
    ledger.increment('places_provider_requests_total', {
      method: 'google.routeMatrix',
      status: 200,
    });
    // The adapter increments by `destinations.length`; ignoring `by` would
    // report one unit for a 25-element matrix and understate by 24.
    ledger.increment('places_provider_cost_units', { sku: 'routes.computeRouteMatrix' }, 25);
    // Folded onto the operation, not left under the SKU name (#332).
    expect(ledger.pending()).toBe(1);
  });

  it('ignores every metric that is not an accounting fact', async () => {
    const { db, executed } = fakeDb();
    const ledger = new DbUsageLedger(db, { environment: 'dev' });
    ledger.increment('place_import_rows_total', { status: 'imported' });
    ledger.observe();
    await ledger.flush();
    // A ledger that persisted every counter in the system would be a second
    // metrics backend, which is not what this is.
    expect(executed).toHaveLength(0);
  });

  it('puts the counts back when the write fails, and says so', async () => {
    let fail = true;
    const { db, executed } = fakeDb(() => {
      if (fail) throw new Error('connection terminated');
    });
    const metrics = recorder();
    const ledger = new DbUsageLedger(db, { environment: 'dev', metrics });

    ledger.increment('places_provider_requests_total', {
      method: 'google.searchText',
      status: 200,
    });
    await expect(ledger.flush()).rejects.toThrow('connection terminated');
    // Dropping counts on a transient blip and staying quiet is worse than no
    // ledger: the number printed later still looks authoritative.
    expect(ledger.pending()).toBe(1);
    expect(metrics.counts.at(-1)).toMatchObject({
      name: 'provider_usage_ledger_flush_total',
      labels: { outcome: 'error' },
    });

    fail = false;
    await ledger.flush();
    expect(ledger.pending()).toBe(0);
    expect(executed.at(-1)!.params.slice(-3)).toEqual([1, 1, 0]);
  });

  it('does nothing at all when disabled', async () => {
    const { db, executed } = fakeDb();
    const ledger = new DbUsageLedger(db, { environment: 'dev', enabled: false });
    ledger.increment('places_provider_requests_total', {
      method: 'google.searchText',
      status: 200,
    });
    ledger.start();
    await ledger.stop();
    // `COST_LEDGER_ENABLED=false` is the rollback for this PR.
    expect(executed).toHaveLength(0);
    expect(ledger.pending()).toBe(0);
  });

  it('attributes calls to the day they happened, not the day they are written', async () => {
    vi.useFakeTimers();
    try {
      const { db, executed } = fakeDb();
      const ledger = new DbUsageLedger(db, { environment: 'dev' });
      vi.setSystemTime(new Date('2026-09-01T23:59:59.000Z'));
      ledger.increment('places_provider_requests_total', {
        method: 'google.searchText',
        status: 200,
      });
      vi.setSystemTime(new Date('2026-09-02T00:00:01.000Z'));
      ledger.increment('places_provider_requests_total', {
        method: 'google.searchText',
        status: 200,
      });
      // A buffer that spans midnight must not post yesterday's calls to today
      // — the whole table is per day, and so is every ceiling built on it.
      expect(ledger.pending()).toBe(2);
      await ledger.flush();
      expect(executed[0]!.params).toContain('2026-09-01');
      expect(executed[0]!.params).toContain('2026-09-02');
    } finally {
      vi.useRealTimers();
    }
  });

  it('serialises overlapping flushes', async () => {
    let inFlight = 0;
    let overlapped = false;
    const { db } = fakeDb(() => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
    });
    const ledger = new DbUsageLedger(db, { environment: 'dev' });
    ledger.increment('places_provider_requests_total', {
      method: 'google.searchText',
      status: 200,
    });
    // Two partial drains would each put back their own half on failure, and
    // the same counts would land twice.
    await Promise.all([ledger.flush(), ledger.flush(), ledger.flush()]);
    expect(overlapped).toBe(false);
  });
});

/**
 * #336 — a single `flush()` is not a drain, and the shutdown path assumed it
 * was.
 *
 * `flush()` joins a flush already in flight, and `flushOnce` clears the buffer
 * *before* it awaits the write. So anything counted while that write is in
 * flight goes into a fresh buffer that the joined promise knows nothing about,
 * and `stop()` returned before it was written — a silent loss on SIGTERM,
 * which ADR-0012 says explicitly does not happen.
 *
 * Found by the #336 baseline: a scenario's provider calls kept appearing in
 * the *next* scenario's ledger window while the in-process metric registry
 * showed them in the right one.
 */
describe('DbUsageLedger.drain (#336)', () => {
  it('writes counts that arrive while a flush is already in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const executed: { params: unknown[] }[] = [];
    const db = {
      execute: vi.fn(async (query: SQL) => {
        writes += 1;
        const rendered = dialect.sqlToQuery(query);
        executed.push({ params: rendered.params });
        // Hold the first write open so a second count lands mid-flight.
        if (writes === 1) await gate;
        return { rows: [] };
      }),
    } as unknown as Db;

    const ledger = new DbUsageLedger(db, { environment: 'dev' });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.quality',
      status: 200,
    });

    const inFlight = ledger.flush();
    // Counted after the buffer was drained but before the write resolved.
    ledger.increment('places_provider_requests_total', {
      method: 'google.searchText',
      status: 200,
    });

    const drained = ledger.drain();
    release!();
    await Promise.all([inFlight, drained]);

    expect(ledger.pending()).toBe(0);
    const operations = executed.flatMap((e) => e.params.filter((p) => typeof p === 'string'));
    expect(operations).toContain('google.details.quality');
    expect(operations, 'the mid-flight count must not be lost on shutdown').toContain(
      'google.searchText',
    );
  });

  it('stops after its pass budget rather than spinning on a database that refuses', async () => {
    const db = {
      execute: vi.fn(async () => {
        throw new Error('write refused');
      }),
    } as unknown as Db;
    const ledger = new DbUsageLedger(db, { environment: 'dev', metrics: recorder() });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.quality',
      status: 200,
    });

    // The error propagates exactly as `flush()` already did; what must not
    // happen is an unbounded retry loop inside a shutdown path.
    await expect(ledger.drain(3)).rejects.toThrow('write refused');
    expect(ledger.pending()).toBe(1);
  });

  it('is a no-op when the ledger is disabled', async () => {
    const { db, executed } = fakeDb();
    const ledger = new DbUsageLedger(db, { environment: 'dev', enabled: false });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.quality',
      status: 200,
    });
    await ledger.drain();
    expect(executed).toEqual([]);
  });
});
