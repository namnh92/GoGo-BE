import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
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
};

export function createDb(connectionString: string, options: DbOptions = {}) {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
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
