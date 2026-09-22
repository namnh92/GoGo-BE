/**
 * GoGo-BE#632 — a green integration run must not exit non-zero.
 *
 * Every integration spec starts its own Postgres container and its own `pg.Pool`,
 * and tears both down in `afterAll`. When the server goes away while a pooled
 * client is still connected, Postgres sends `57P01 terminating connection due to
 * administrator command`. A `pg.Pool` with no `error` listener re-emits that as
 * an unhandled error, and vitest counts it: run 35677085520 reported
 * `1377 passed | 3 skipped` and still exited 1.
 *
 * `pg`'s own guidance is to attach an error handler to the pool. This does that
 * once, for every pool a test process creates, and it **classifies** rather than
 * swallows: a shutdown-class error during teardown is expected and ignored, and
 * anything else is re-thrown so the run still fails loudly.
 */

/** Errors that only mean "the server this pool talked to has gone away". */
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

let ignored = 0;
/** How many shutdown-class pool errors were tolerated; for assertions. */
export function ignoredShutdownErrors(): number {
  return ignored;
}

/**
 * Attaches the handler to every pool this process creates, by wrapping the
 * constructor once. Test-only: it changes no production path, and it is the
 * single place that knows teardown noise from a real pool failure.
 */
export function installPoolShutdownGuard(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS module shape
  const pg = require('pg') as { Pool: new (...args: never[]) => unknown };
  const Original = pg.Pool as unknown as { prototype: object };
  if ((Original as { __gogoGuarded?: boolean }).__gogoGuarded) return;

  const proto = Original.prototype as { on?: unknown };
  const originalOn = (proto as { on: (...a: unknown[]) => unknown }).on;
  void originalOn;

  const Wrapped = function (this: unknown, ...args: never[]) {
    const pool = new (
      Original as unknown as new (...a: never[]) => {
        on: (event: string, cb: (e: unknown) => void) => void;
      }
    )(...args);
    pool.on('error', (error: unknown) => {
      if (isShutdownNoise(error)) {
        ignored += 1;
        return;
      }
      // Not teardown noise: let it be as loud as it was before.
      throw error;
    });
    return pool;
  } as unknown as typeof Original;

  Wrapped.prototype = Original.prototype;
  (Wrapped as { __gogoGuarded?: boolean }).__gogoGuarded = true;
  (pg as { Pool: unknown }).Pool = Wrapped;
}

installPoolShutdownGuard();
