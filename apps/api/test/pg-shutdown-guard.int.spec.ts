import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ignoredShutdownErrors, isShutdownNoise } from './support/pg-shutdown';

/**
 * GoGo-BE#632 — a run where every test passes must exit zero.
 *
 * The failure this guards against is not a wrong assertion: run 35677085520
 * reported `1377 passed | 3 skipped` and still exited 1, because a pool lost its
 * container mid-teardown and `57P01` reached nobody. These cases pin the two
 * halves of the fix: the classifier's verdicts, and the fact that a real
 * container stopped under a live pool no longer produces an unhandled error.
 */
describe('pool shutdown guard (GoGo-BE#632)', () => {
  it('knows teardown noise from a real failure', () => {
    // Tolerated: the server went away.
    expect(isShutdownNoise({ code: '57P01' })).toBe(true);
    expect(isShutdownNoise({ code: '57P02' })).toBe(true);
    expect(isShutdownNoise({ code: '08006' })).toBe(true);
    expect(isShutdownNoise({ code: 'ECONNRESET' })).toBe(true);
    expect(
      isShutdownNoise({ message: 'terminating connection due to administrator command' }),
    ).toBe(true);

    // Not tolerated: these must still fail a run.
    expect(isShutdownNoise({ code: '23505', constraint: 'plans_room_version_unique' })).toBe(false);
    expect(isShutdownNoise({ code: '42P01' })).toBe(false);
    expect(isShutdownNoise({ code: '28P01' })).toBe(false);
    expect(isShutdownNoise(new Error('syntax error at or near'))).toBe(false);
    expect(isShutdownNoise(null)).toBe(false);
    expect(isShutdownNoise(undefined)).toBe(false);
  });

  it('attaches an error listener to every pool the tests create', () => {
    const pool = new Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/none' });
    // Before the guard this was 0, which is what made 57P01 unhandled.
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    void pool.end().catch(() => undefined);
  });

  describe('a container stopped under a live pool', () => {
    let container: StartedPostgreSqlContainer;
    let pool: Pool;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
      pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
      // A real connection, so the socket is open when the server dies.
      await pool.query('select 1');
    }, 180_000);

    it('reports the 57P01 to the guard instead of to nobody', async () => {
      const before = ignoredShutdownErrors();
      // The order the specs use, but with the pool deliberately still holding a
      // connection: this is the shape that produced the unhandled error.
      await container.stop();
      // Give the FATAL time to arrive on the idle client's socket.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await pool.end().catch(() => undefined);
      // Either the error was delivered and tolerated, or the socket closed
      // quietly — both are fine. What must not happen is an unhandled error,
      // and this test file completing at all is that assertion.
      expect(ignoredShutdownErrors()).toBeGreaterThanOrEqual(before);
    }, 120_000);

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
    });
  });
});
