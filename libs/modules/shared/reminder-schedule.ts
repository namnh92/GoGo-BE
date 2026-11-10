import { sql } from 'drizzle-orm';
import type { Tx } from './outbox';

export const REMINDER_LEAD_SECONDS = 120 * 60;
export function reminderDueAt(start: Date | null, now: Date): Date | null {
  if (!start || start.getTime() <= now.getTime()) return null;
  return new Date(Math.max(now.getTime(), start.getTime() - REMINDER_LEAD_SECONDS * 1000));
}

/** Room lock precedes job locks in writers AND scheduler. Same transaction as business changes.
 * A date-only scheduled_date is never a confirmed start. Plan revisions at the same
 * start retain the job identity, including after delivery. No provider work here.
 */
export async function syncReminderSchedule(tx: Tx, roomId: string): Promise<void> {
  // Acquire separately: a locking join that waits for a constraint edit can
  // otherwise combine the updated room row with constraints from its older
  // statement snapshot. The following read gets a fresh READ COMMITTED snapshot.
  await tx.execute(sql`select id from rooms where id = ${roomId}::uuid for update`);
  const room = await tx.execute<{ start_at: string | null; status: string; now: string }>(sql`
    select rc.start_at, r.status, clock_timestamp() as now from rooms r
    left join room_constraints rc on rc.room_id = r.id and rc.version = r.constraint_version
    where r.id = ${roomId}::uuid
  `);
  const row = room.rows[0];
  const start = row?.start_at ? new Date(row.start_at) : null;
  const due =
    row && ['collecting', 'matching', 'ready'].includes(row.status)
      ? reminderDueAt(start, new Date(row.now))
      : null;
  await tx.execute(sql`update notification_reminder_jobs set status = 'cancelled', updated_at = now()
    where room_id = ${roomId}::uuid and status = 'pending'
      ${due && start ? sql`and starts_at <> ${start.toISOString()}::timestamptz` : sql``}`);
  if (!due || !start) return;
  await tx.execute(sql`insert into notification_reminder_jobs(room_id, starts_at, scheduled_for)
    values (${roomId}::uuid, ${start.toISOString()}::timestamptz, ${due.toISOString()}::timestamptz)
    on conflict(room_id, starts_at) do update set status = 'pending', updated_at = now()
    where notification_reminder_jobs.status = 'cancelled'`);
}
