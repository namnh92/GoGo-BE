import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { Tx } from '../../shared/outbox';
import { quietHoursEnd } from '../domain/quiet-hours';

/** Read at each attempt, including retry; no account timezone inferred from locale/device. */
export async function pushDeferredUntil(
  db: Pick<Db, 'execute'>,
  userId: string,
): Promise<Date | null> {
  const { rows } = await db.execute<{
    quiet_hours_enabled: boolean;
    timezone: string | null;
    now: string;
  }>(sql`
    select quiet_hours_enabled, timezone, clock_timestamp() as now from notification_settings
    where user_id = ${userId}::uuid`);
  const row = rows[0];
  return row
    ? quietHoursEnd(new Date(row.now), { enabled: row.quiet_hours_enabled, timezone: row.timezone })
    : null;
}

/** Fence only the decision + durable write against settings mutations. The
 * account lock is released BEFORE any provider call. A concurrent timezone/
 * enable change either wins before this read or wakes the committed deferral.
 */
export async function deferPushDuringQuiet(
  db: Db,
  userId: string,
  defer: (tx: Tx, until: Date) => Promise<unknown>,
): Promise<Date | null> {
  return db.transaction(async (tx) => {
    const account = await tx.execute(sql`select id from users
      where id = ${userId}::uuid and status <> 'deleted' for share`);
    if (!account.rows[0]) throw new Error('NOTIFICATION_ACCOUNT_UNAVAILABLE');
    const until = await pushDeferredUntil(tx, userId);
    if (until) await defer(tx, until);
    return until;
  });
}
