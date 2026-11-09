import {
  createDb,
  enableNotificationRecipientKeys,
  disableNotificationRecipientKeys,
  quiesceNotificationProducers,
  resumeNotificationProducers,
  collapseNotificationCategoriesBatch,
  unfreezeNotificationPreferenceWrites,
} from '@gogo/database';
import { EVENT_TO_NOTIFICATION } from '@gogo/modules';

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (
    ![
      '--quiesce-producers',
      '--resume-producers',
      '--enable-recipient-keys',
      '--rollback-collapse',
      '--unfreeze',
    ].includes(action ?? '') ||
    extra.length
  )
    throw new Error(
      'Expected --quiesce-producers, --resume-producers, --enable-recipient-keys, --rollback-collapse or --unfreeze',
    );
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    if (action === '--quiesce-producers') await quiesceNotificationProducers(db);
    if (action === '--resume-producers') await resumeNotificationProducers(db);
    if (action === '--enable-recipient-keys')
      await enableNotificationRecipientKeys(db, Object.keys(EVENT_TO_NOTIFICATION));
    if (action === '--rollback-collapse') {
      await disableNotificationRecipientKeys(db, Object.keys(EVENT_TO_NOTIFICATION));
      while (await collapseNotificationCategoriesBatch(db)) {
        /* bounded account commits */
      }
    }
    if (action === '--unfreeze') await unfreezeNotificationPreferenceWrites(db);
    // eslint-disable-next-line no-console -- operator CLI
    console.log('notification category rollout step completed');
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  // eslint-disable-next-line no-console -- no DB/provider detail
  console.error('notification category rollout step failed');
  process.exitCode = 1;
});
