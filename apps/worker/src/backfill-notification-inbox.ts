/** Packaged operator entrypoint: resumable data + concurrent DDL, outside migrations. */
import {
  createDb,
  cleanupDeletedNotificationInboxBatch,
  backfillNotificationInboxBatch,
  finishNotificationInboxRollout,
} from '@gogo/database';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    while ((await cleanupDeletedNotificationInboxBatch(db)) > 0) {
      // Old binaries could recreate erased inboxes before the insert fence.
      // Repair those remnants in bounded commits before enabling cutoff APIs.
    }
    while ((await backfillNotificationInboxBatch(db)) > 0) {
      // Each iteration is a separate bounded commit. Safe to kill and rerun.
    }
    await finishNotificationInboxRollout(pool);
    // eslint-disable-next-line no-console -- one-off operator CLI, no Nest logger
    console.log('notification inbox backfill/indexes complete; cutoff APIs enabled');
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  // No connection strings or raw database error detail in operator logs.
  // eslint-disable-next-line no-console -- sanitized operator CLI failure
  console.error('notification inbox rollout failed', error instanceof Error ? error.name : 'Error');
  process.exitCode = 1;
});
