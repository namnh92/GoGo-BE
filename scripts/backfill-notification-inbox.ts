/** Separate from the transactional migration runner: resumable data + concurrent DDL. */
import {
  createDb,
  backfillNotificationInboxBatch,
  finishNotificationInboxRollout,
} from '@gogo/database';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    while ((await backfillNotificationInboxBatch(db)) > 0) {
      // Each iteration is a separate bounded commit. Safe to kill and rerun.
    }
    await finishNotificationInboxRollout(pool);
    console.log('notification inbox backfill/indexes complete; cutoff APIs enabled');
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  // No connection strings or raw database error detail in operator logs.
  console.error('notification inbox rollout failed', error instanceof Error ? error.name : 'Error');
  process.exitCode = 1;
});
