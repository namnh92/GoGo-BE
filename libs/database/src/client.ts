import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

export type DbOptions = {
  /**
   * DB-002 — pool size per process, not per deployment.
   *
   * The ceiling is Postgres `max_connections` divided by every process that
   * connects: api replicas, the worker, migrations, and whatever a human has
   * open in psql. Sizing this from the *application's* concurrency instead is
   * how a deploy that doubles replicas takes the database down at the moment
   * it is under most load.
   *
   * 10 fits a single-VPS MVP (default 100 connections, ~4 processes, with
   * headroom for a migration and an operator). Raise it only alongside
   * max_connections or a pooler.
   */
  max?: number;
  /** Fail fast: a request queueing on a connection is already a slow request. */
  connectionTimeoutMillis?: number;
  /**
   * #414 — time every statement as one registry operation. Structural on
   * purpose: this package is a leaf and does not import `@gogo/observability`;
   * the API and the worker pass their metrics registry and the registry's
   * `neon.postgres.query` descriptor in.
   */
  runtime?: DbRuntimeTelemetry;
};

type RuntimeLabels = Record<string, string | number | boolean | undefined>;

export type DbRuntimeTelemetry = {
  metrics: {
    increment(name: string, labels?: RuntimeLabels, by?: number): void;
    observe(name: string, value: number, labels?: RuntimeLabels): void;
  };
  operation: { provider: string; service: string; operation: string };
};

export function createDb(connectionString: string, options: DbOptions = {}) {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ...(options.runtime ? { Client: meteredClient(options.runtime) } : {}),
  });
  /**
   * An idle pooled client whose server goes away emits `error` on the pool,
   * and an unhandled one takes the process down. That is the wrong outcome
   * during a database restart or failover: the queries in flight should fail
   * and be retried, not the API. Logged through the pool's own consumers
   * instead of crashing.
   */
  pool.on('error', () => {
    /* the next query surfaces the real failure with its own context */
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function closeDb(pool: Pool): Promise<void> {
  await pool.end();
}

// ── #414 runtime telemetry ───────────────────────────────────────────────────

type QueryInvoke = (...args: unknown[]) => unknown;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * `Client.query` has three shapes and the pool uses two of them: `pg-pool`
 * runs every `pool.query` through the *callback* form on a checked-out
 * client, Drizzle's transactions call the *promise* form on the client it
 * holds, and a Submittable (a Cursor, a QueryStream) manages its own
 * lifecycle and is passed through unmeasured. One record per statement,
 * whichever door it came in by; the SQL text never reaches a label.
 */
export function withQueryTelemetry(
  invoke: QueryInvoke,
  args: unknown[],
  record: (status: 'ok' | 'error', startedAtMs: number) => void,
): unknown {
  const started = Date.now();
  const last = args[args.length - 1];
  if (typeof last === 'function') {
    const callback = last as (err: unknown, result?: unknown) => void;
    const wrapped: typeof callback = (err, result) => {
      record(err ? 'error' : 'ok', started);
      callback(err, result);
    };
    return invoke(...args.slice(0, -1), wrapped);
  }
  const result = invoke(...args);
  if (!isPromiseLike(result)) return result;
  return Promise.resolve(result).then(
    (value) => {
      record('ok', started);
      return value;
    },
    (err: unknown) => {
      record('error', started);
      throw err;
    },
  );
}

function recordQuery(runtime: DbRuntimeTelemetry, status: 'ok' | 'error', startedAtMs: number) {
  const labels = {
    provider: runtime.operation.provider,
    service: runtime.operation.service,
    operation: runtime.operation.operation,
    status,
  };
  runtime.metrics.increment('provider_requests_total', labels);
  runtime.metrics.observe(
    'provider_request_duration_seconds',
    (Date.now() - startedAtMs) / 1000,
    labels,
  );
}

/**
 * A `pg.Client` whose `query` records one runtime call per statement. Done
 * as a subclass handed to the pool (`PoolConfig.Client`) rather than by
 * patching instances on `acquire`, so every connection the pool ever opens
 * is measured from its first statement. The override is installed on the
 * prototype because `Client.query` is overloaded and TypeScript will not let
 * a subclass restate it looser.
 */
function meteredClient(runtime: DbRuntimeTelemetry): typeof Client {
  const base = Client.prototype.query as unknown as QueryInvoke;
  class MeteredClient extends Client {}
  Object.defineProperty(MeteredClient.prototype, 'query', {
    configurable: true,
    writable: true,
    value(this: Client, ...args: unknown[]): unknown {
      return withQueryTelemetry(
        (...a) => base.apply(this, a),
        args,
        (status, started) => recordQuery(runtime, status, started),
      );
    },
  });
  return MeteredClient;
}
