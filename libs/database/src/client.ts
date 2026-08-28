import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
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
