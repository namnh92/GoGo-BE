/**
 * GoGo-BE#632 — a green integration run must not exit non-zero, and a suite
 * that hides a lost database is worse than one that exits noisily.
 *
 * Every integration spec starts its own Postgres container and tears it down in
 * `afterAll`. When the server goes away while a pooled client is still
 * connected, Postgres sends `57P01 terminating connection due to administrator
 * command`. A `pg.Pool` with no `error` listener re-emits that as an unhandled
 * error, and vitest counts it: run 35677085520 reported `1377 passed | 3
 * skipped` and still exited 1.
 *
 * `pg`'s own guidance is to attach an error handler to the pool. This does that
 * once, for every pool a test process creates. **Two conditions must both hold**
 * before an error is tolerated:
 *
 *  1. that pool is in intentional teardown — `pool.end()` has been called on
 *     **it**, so `pool.ending` is true; and
 *  2. the error is one the teardown explains.
 *
 * Neither alone is enough. A `57P02` while a test is still running means the
 * database crashed under it, and that must fail the run — which is the review
 * finding this shape answers. And because the listener closes over its own pool,
 * one pool tearing down can never silence another pool that is still working.
 */

/** Errors a pool's own shutdown explains. Only consulted once teardown is confirmed. */
export function isShutdownNoise(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  // 57P01 admin shutdown, 57P02 crash shutdown, 08006 connection failure.
  if (e.code === '57P01' || e.code === '57P02' || e.code === '08006') return true;
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return true;
  const m = typeof e.message === 'string' ? e.message : '';
  return (
    m.includes('terminating connection due to administrator command') ||
    m.includes('Connection terminated unexpectedly')
  );
}

/** A pool whose lifecycle flags we read; `pg` sets these in `end()`. */
type PoolLifecycle = { ending?: boolean; ended?: boolean };

/**
 * Whether this pool is being shut down on purpose. `pg` sets `ending` at the top
 * of `end()` and `ended` when it resolves, so either one means the test asked
 * for this teardown rather than suffering it.
 */
export function isTearingDown(pool: unknown): boolean {
  const p = pool as PoolLifecycle | null;
  return Boolean(p && (p.ending === true || p.ended === true));
}

/** The one rule: tolerate only an explained error on a pool that is closing. */
export function shouldTolerate(pool: unknown, error: unknown): boolean {
  return isTearingDown(pool) && isShutdownNoise(error);
}

let ignored = 0;
/** How many teardown-explained pool errors were tolerated; for assertions. */
export function ignoredShutdownErrors(): number {
  return ignored;
}

/**
 * Attaches the handler to every pool this process creates, by wrapping the
 * constructor once. Test-only: it changes no production path, and it is the
 * single place that knows a pool's own teardown from a database lost mid-test.
 */
export function installPoolShutdownGuard(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS module shape
  const pg = require('pg') as { Pool: unknown };
  const Original = pg.Pool as { prototype: object; __gogoGuarded?: boolean };
  if (Original.__gogoGuarded) return;

  const Wrapped = function (this: unknown, ...args: never[]) {
    const pool = new (
      Original as unknown as new (...a: never[]) => {
        on: (event: string, cb: (e: unknown) => void) => void;
      }
    )(...args);
    pool.on('error', (error: unknown) => {
      if (shouldTolerate(pool, error)) {
        ignored += 1;
        return;
      }
      // Either this pool is still in use, or the error is not one its shutdown
      // explains. Be exactly as loud as an unguarded pool was.
      throw error;
    });
    return pool;
  } as unknown as typeof Original;

  Wrapped.prototype = Original.prototype;
  Wrapped.__gogoGuarded = true;
  (pg as { Pool: unknown }).Pool = Wrapped;
}

installPoolShutdownGuard();
