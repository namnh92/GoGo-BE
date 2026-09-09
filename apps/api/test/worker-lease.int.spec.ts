import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, WorkerLease } from '@gogo/database';

/**
 * BE#539 — against a real Postgres, because the defect this replaces was
 * invisible to every unit test that existed.
 *
 * `pg_try_advisory_lock` is session-scoped; PgBouncer transaction pooling moves
 * statements between backends, so the unlock missed and the lock leaked. On DEV
 * that stopped the worker completely for eleven minutes with a healthy
 * container and no error line. What follows exercises contention, crash
 * recovery and takeover as SQL, which is the layer where that went wrong.
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '../../../migrations') });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const lease = (workerId: string, ttlMs = 60_000) =>
  new WorkerLease(pool, { ttlMs, renewEveryMs: ttlMs / 3, workerId });

/**
 * A worker that dies mid-job: it holds the lease and never renews it again.
 * Injecting a no-op timer is the faithful simulation — a crashed process stops
 * renewing, it does not politely release. (Renewal that kept running would keep
 * the lease alive and there would be nothing to recover from.)
 */
const crashed = (workerId: string, ttlMs: number) =>
  new WorkerLease(pool, {
    ttlMs,
    renewEveryMs: ttlMs / 3,
    workerId,
    setInterval: (() => 0) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as unknown as typeof clearInterval,
  });

describe('WorkerLease against Postgres', () => {
  it('grants one worker and refuses the other — contention is a single statement', async () => {
    const a = await lease('a').tryAcquire('contended');
    const b = await lease('b').tryAcquire('contended');

    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await a!.release();
  });

  it('lets the next worker in as soon as the holder releases', async () => {
    const a = await lease('a').tryAcquire('handover');
    await a!.release();

    const b = await lease('b').tryAcquire('handover');
    expect(b).not.toBeNull();
    await b!.release();
  });

  it('recovers from a crash on its own, with nobody terminating a backend', async () => {
    // The whole point. A worker that dies holding a lease never releases it —
    // this is the case that wedged DEV until a human ran pg_terminate_backend.
    // A very short TTL stands in for time passing.
    const dead = await crashed('crashed', 900).tryAcquire('crash');
    expect(dead).not.toBeNull();

    // No release: simulate the process vanishing mid-job.
    await new Promise((r) => setTimeout(r, 1200));

    const next = await lease('successor', 60_000).tryAcquire('crash');
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('refuses to renew a lease that was taken over, so the loser learns it lost', async () => {
    const loser = await crashed('loser', 900).tryAcquire('takeover');
    const loserHolder = (
      await pool.query(`select holder from worker_leases where name = $1`, ['takeover'])
    ).rows[0].holder;
    await new Promise((r) => setTimeout(r, 1200));

    const winner = await lease('winner', 60_000).tryAcquire('takeover');
    expect(winner).not.toBeNull();

    // The loser's renewal is the real statement, with its own holder: it must
    // match nothing now that the row belongs to someone else.
    const renewed = await pool.query(
      `update worker_leases
         set expires_at = now() + make_interval(secs => 60), renewed_at = now()
       where name = $1 and holder = $2 and expires_at > now()
       returning holder`,
      ['takeover', loserHolder],
    );
    expect(renewed.rows).toHaveLength(0);

    const held = await pool.query(`select worker_id from worker_leases where name = $1`, [
      'takeover',
    ]);
    expect(held.rows[0].worker_id).toBe('winner');
    expect(loser!.isHeld()).toBe(true); // it does not know yet — that is why renewal must check
    await winner!.release();
  });

  it("a loser's release cannot free the lease its successor is holding", async () => {
    const loser = await crashed('loser', 900).tryAcquire('release-safety');
    await new Promise((r) => setTimeout(r, 1200));
    const winner = await lease('winner', 60_000).tryAcquire('release-safety');
    expect(winner).not.toBeNull();

    // The loser tidies up late. Owner-matched, so it must be a no-op.
    await loser!.release();

    const third = await lease('third').tryAcquire('release-safety');
    expect(third).toBeNull(); // still the winner's
    await winner!.release();
  });

  it('keeps a long job alive past the TTL by renewing', async () => {
    // Sustained progress beyond the expiry window is the property DEV needs:
    // the lease must not fall over simply because a job outlives one TTL.
    const held = await lease('long', 1_200).tryAcquire('long-job');
    expect(held).not.toBeNull();

    await new Promise((r) => setTimeout(r, 2_000)); // > TTL, renewals in between

    expect(held!.isHeld()).toBe(true);
    expect(held!.signal.aborted).toBe(false);
    // Nobody else can take it while it is being renewed.
    expect(await lease('other', 60_000).tryAcquire('long-job')).toBeNull();
    await held!.release();
  });
});
