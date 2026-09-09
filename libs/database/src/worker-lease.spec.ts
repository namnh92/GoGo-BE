import { describe, expect, it, vi } from 'vitest';
import { WorkerLease, type LeaseQuery } from './worker-lease';

/**
 * BE#539. The property these protect is not "a lock works" — advisory locks
 * worked, right up until the unlock landed on a different PgBouncer backend and
 * leaked silently. What is asserted here is that nothing depends on session
 * state, that ownership is matched on every write, and that losing a lease
 * mid-job is *observable to the job*.
 */

/** Records every statement so "one self-contained statement" can be asserted. */
function fakeDb(handler: (sql: string, values: unknown[]) => unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db: LeaseQuery & { calls: typeof calls } = {
    calls,
    async query<T>(text: string, values: unknown[] = []) {
      calls.push({ sql: text, values });
      return { rows: handler(text, values) as T[] };
    },
  };
  return db;
}

const opts = (extra: Record<string, unknown> = {}) => ({
  ttlMs: 30_000,
  renewEveryMs: 10_000,
  workerId: 'worker-a',
  ...extra,
});

describe('WorkerLease', () => {
  it('acquires when the row is free and reports the holder back', async () => {
    const db = fakeDb((sql) =>
      sql.includes('insert into worker_leases') ? [{ holder: 'h' }] : [],
    );
    const held = await new WorkerLease(db, opts()).tryAcquire('outbox');

    expect(held).not.toBeNull();
    expect(held!.isHeld()).toBe(true);
    expect(held!.signal.aborted).toBe(false);
  });

  it('returns null when another worker holds an unexpired lease', async () => {
    // The `where expires_at <= now()` guard matched nothing, so `returning`
    // yielded no row. That is the entire contention story.
    const db = fakeDb(() => []);
    expect(await new WorkerLease(db, opts()).tryAcquire('outbox')).toBeNull();
  });

  it('mints a different holder for every acquisition, so a stale renewal cannot resurrect it', async () => {
    const db = fakeDb(() => [{ holder: 'x' }]);
    const lease = new WorkerLease(db, opts());
    await lease.tryAcquire('outbox');
    await lease.tryAcquire('outbox');

    const holders = db.calls.filter((c) => c.sql.includes('insert into')).map((c) => c.values[1]);
    expect(holders[0]).not.toEqual(holders[1]);
  });

  it('never depends on session state — every statement carries its own predicate', async () => {
    // The bug was session-scoped state under transaction pooling. No statement
    // here may rely on a previous one having run on the same backend.
    const db = fakeDb(() => [{ holder: 'x' }]);
    const held = await new WorkerLease(db, opts()).tryAcquire('outbox');
    await held!.release();

    for (const call of db.calls) {
      expect(call.sql).not.toMatch(/pg_advisory|pg_try_advisory|begin|commit|set\s+local/i);
      // Name and holder appear in every write, so the statement is complete
      // wherever it runs.
      expect(call.values).toContain('outbox');
    }
  });

  it('renews on its own schedule while the job runs', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb(() => [{ holder: 'x' }]);
      const held = await new WorkerLease(db, opts()).tryAcquire('outbox');

      await vi.advanceTimersByTimeAsync(25_000);
      const renewals = db.calls.filter((c) => c.sql.includes('update worker_leases')).length;

      expect(renewals).toBeGreaterThanOrEqual(2);
      expect(held!.isHeld()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the job when a renewal finds the lease is no longer ours', async () => {
    vi.useFakeTimers();
    try {
      let acquired = false;
      const db = fakeDb((sql) => {
        if (sql.includes('insert into')) {
          acquired = true;
          return [{ holder: 'x' }];
        }
        // Renewal matches nothing: taken over, or expired while we were slow.
        return acquired ? [] : [{ holder: 'x' }];
      });
      const events: string[] = [];
      const held = await new WorkerLease(
        db,
        opts({ report: (e: string) => events.push(e) }),
      ).tryAcquire('outbox');

      expect(held!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(held!.isHeld()).toBe(false);
      expect(held!.signal.aborted).toBe(true);
      expect(events).toContain('worker_lease_lost');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the database cannot be reached to renew', async () => {
    vi.useFakeTimers();
    try {
      let first = true;
      const db: LeaseQuery = {
        async query<T>(sql: string) {
          if (first && sql.includes('insert into')) {
            first = false;
            return { rows: [{ holder: 'x' }] as T[] };
          }
          throw new Error('connection reset');
        },
      };
      const held = await new WorkerLease(db, opts()).tryAcquire('outbox');
      await vi.advanceTimersByTimeAsync(10_000);

      // Unreachable is not proof the lease is gone, but it is proof we can no
      // longer defend it — and two runners is worse than none.
      expect(held!.isHeld()).toBe(false);
      expect(held!.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases with the holder matched, so a lost lease is never freed for its successor', async () => {
    const db = fakeDb(() => [{ holder: 'x' }]);
    const held = await new WorkerLease(db, opts()).tryAcquire('outbox');
    const holder = db.calls[0]!.values[1];
    await held!.release();

    const release = db.calls.find((c) => c.sql.includes('set expires_at = now()'));
    expect(release).toBeDefined();
    expect(release!.values).toEqual(['outbox', holder]);
    expect(release!.sql).toContain('holder = $2');
  });

  it('does not touch the row when releasing a lease it already lost', async () => {
    vi.useFakeTimers();
    try {
      let acquired = false;
      const db = fakeDb((sql) => {
        if (sql.includes('insert into')) {
          acquired = true;
          return [{ holder: 'x' }];
        }
        return acquired ? [] : [{ holder: 'x' }];
      });
      const held = await new WorkerLease(db, opts()).tryAcquire('outbox');
      await vi.advanceTimersByTimeAsync(10_000);
      const before = db.calls.length;

      await held!.release();

      // The successor's lease is not ours to expire.
      expect(db.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops renewing once released, so a finished job leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb(() => [{ holder: 'x' }]);
      const held = await new WorkerLease(db, opts()).tryAcquire('outbox');
      await held!.release();
      const after = db.calls.length;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(db.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});
