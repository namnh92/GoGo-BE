import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ignoredShutdownErrors,
  isShutdownNoise,
  isTearingDown,
  shouldTolerate,
} from './support/pg-shutdown';

/**
 * GoGo-BE#632 — a run where every test passes must exit zero, and a run where
 * the database disappears under a live test must not.
 *
 * The first shape is what CI hit: run 35677085520 reported `1377 passed | 3
 * skipped` and exited 1 on an unhandled `57P01`. The second is the review
 * finding on this PR: an earlier version of the guard tolerated `57P02`/`08006`
 * whenever they appeared, which would have hidden a database crash mid-test.
 *
 * So the boundary itself is what these cases pin: the same error must be
 * tolerated inside a pool's own teardown and fatal outside it, and one pool
 * closing must not cover for another that is still working.
 *
 * A throwing `error` listener propagates out of `emit`, so `toThrow` here is
 * exactly what an unguarded pool did to the run.
 */
const DEAD = 'postgres://u:p@127.0.0.1:1/none';
const shutdownError = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

describe('pool shutdown guard (GoGo-BE#632)', () => {
  const pools: Pool[] = [];
  const idlePool = () => {
    // Never connected, so nothing here opens a socket or needs a container.
    const pool = new Pool({ connectionString: DEAD });
    pools.push(pool);
    return pool;
  };

  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined);
  });

  it('classifies error codes, and says nothing about when they arrived', () => {
    for (const code of ['57P01', '57P02', '08006', 'ECONNRESET', 'EPIPE']) {
      expect(isShutdownNoise(shutdownError(code))).toBe(true);
    }
    expect(
      isShutdownNoise({ message: 'terminating connection due to administrator command' }),
    ).toBe(true);
    // Never explained by a shutdown, whenever they arrive.
    expect(isShutdownNoise(shutdownError('23505'))).toBe(false);
    expect(isShutdownNoise(shutdownError('42P01'))).toBe(false);
    expect(isShutdownNoise(shutdownError('28P01'))).toBe(false);
    expect(isShutdownNoise(new Error('syntax error at or near'))).toBe(false);
    expect(isShutdownNoise(null)).toBe(false);
    expect(isShutdownNoise(undefined)).toBe(false);
  });

  it('attaches an error listener to every pool the tests create', () => {
    // Before the guard this was 0, which is what made 57P01 unhandled.
    expect(idlePool().listenerCount('error')).toBeGreaterThan(0);
  });

  it('reads teardown from the pool, not from the error', () => {
    const pool = idlePool();
    expect(isTearingDown(pool)).toBe(false);
    expect(shouldTolerate(pool, shutdownError('57P01'))).toBe(false);
    void pool.end().catch(() => undefined);
    expect(isTearingDown(pool)).toBe(true);
    expect(shouldTolerate(pool, shutdownError('57P01'))).toBe(true);
  });

  describe('the same error, on either side of teardown', () => {
    // The review finding: a database that goes away under a running test is a
    // failure, and the old guard swallowed it because it only read the code.
    it.each(['57P01', '57P02', '08006', 'ECONNRESET', 'EPIPE'])(
      'is fatal while the pool is still in use: %s',
      (code) => {
        const pool = idlePool();
        const before = ignoredShutdownErrors();
        expect(() => pool.emit('error', shutdownError(code))).toThrow(`injected ${code}`);
        expect(ignoredShutdownErrors()).toBe(before);
      },
    );

    it.each(['57P01', '57P02', '08006', 'ECONNRESET', 'EPIPE'])(
      'is tolerated once that pool is closing: %s',
      async (code) => {
        const pool = idlePool();
        await pool.end().catch(() => undefined);
        const before = ignoredShutdownErrors();
        expect(() => pool.emit('error', shutdownError(code))).not.toThrow();
        expect(ignoredShutdownErrors()).toBe(before + 1);
      },
    );

    it('stays fatal during teardown when the shutdown does not explain it', async () => {
      const pool = idlePool();
      await pool.end().catch(() => undefined);
      const before = ignoredShutdownErrors();
      expect(() => pool.emit('error', shutdownError('23505'))).toThrow('injected 23505');
      expect(ignoredShutdownErrors()).toBe(before);
    });
  });

  it('does not let one pool closing silence another that is still working', async () => {
    const closing = idlePool();
    const working = idlePool();
    await closing.end().catch(() => undefined);

    // A is closing, so its own 57P01 is noise.
    const before = ignoredShutdownErrors();
    expect(() => closing.emit('error', shutdownError('57P01'))).not.toThrow();
    expect(ignoredShutdownErrors()).toBe(before + 1);

    // B never called end(): the identical error must still end the run.
    expect(isTearingDown(working)).toBe(false);
    expect(() => working.emit('error', shutdownError('57P01'))).toThrow('injected 57P01');
    expect(ignoredShutdownErrors()).toBe(before + 1);
  });

  describe('a real container, closed in the order the specs use', () => {
    let container: StartedPostgreSqlContainer;
    let pool: Pool;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
      pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
      await pool.query('select 1');
    }, 180_000);

    it('ends the pool first, so the container stop has nothing to interrupt', async () => {
      // The ordering the review asked for, and what every spec already does:
      // close the pool, then stop the container. Asserted rather than assumed.
      await pool.end();
      expect(isTearingDown(pool)).toBe(true);
      await container.stop();
      // Nothing to tolerate, because nothing was still connected. This test
      // completing at all is the assertion that no unhandled error escaped.
      await expect(pool.query('select 1')).rejects.toThrow();
    }, 120_000);
  });
});
