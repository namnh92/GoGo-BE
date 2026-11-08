import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from './client';

/** Erasure repair: one deleted owner and at most 500 removed rows per commit. */
export async function cleanupDeletedNotificationInboxBatch(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const candidate = await tx.execute<{ user_id: string }>(sql`
      select u.id as user_id from users u
      where u.status = 'deleted' and (
        exists (select 1 from notifications n where n.user_id = u.id)
        or exists (select 1 from notification_inbox_state s where s.user_id = u.id)
        or exists (select 1 from notification_read_operations o where o.user_id = u.id)
      ) limit 1 for update of u
    `);
    const userId = candidate.rows[0]?.user_id;
    if (!userId) return 0;
    // Operations first matches the read worker's operation -> notification lock
    // order. Commit each nonempty batch before moving on to another table.
    const operations = await tx.execute<{ count: number }>(sql`
      with removed as (
        delete from notification_read_operations where id in (
          select id from notification_read_operations
          where user_id = ${userId}::uuid order by id limit 500
        ) returning id
      ) select count(*)::int as count from removed
    `);
    if (operations.rows[0]!.count > 0) return operations.rows[0]!.count;
    const notifications = await tx.execute<{ count: number }>(sql`
      with removed as (
        delete from notifications where id in (
          select id from notifications where user_id = ${userId}::uuid order by id limit 500
        ) returning id
      ) select count(*)::int as count from removed
    `);
    if (notifications.rows[0]!.count > 0) return notifications.rows[0]!.count;
    const state = await tx.execute(sql`
      delete from notification_inbox_state where user_id = ${userId}::uuid returning user_id
    `);
    return state.rows.length;
  });
}

/** One resumable commit, at most 500 historical rows, sharing the insert lock. */
export async function backfillNotificationInboxBatch(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const candidate = await tx.execute<{ user_id: string }>(sql`
      select n.user_id from notifications n join users u on u.id = n.user_id
      where n.inbox_sequence is null and u.status <> 'deleted' limit 1
      for share of u
    `);
    const userId = candidate.rows[0]?.user_id;
    if (!userId) return 0;
    await tx.execute(sql`
      insert into notification_inbox_state(user_id) values (${userId}::uuid)
      on conflict do nothing
    `);
    await tx.execute(sql`
      select last_sequence from notification_inbox_state
      where user_id = ${userId}::uuid for update
    `);
    const result = await tx.execute<{ count: number }>(sql`
      with batch as (
        select id, row_number() over (order by created_at, id) as sequence_offset
        from (select id, created_at from notifications
          where user_id = ${userId}::uuid and inbox_sequence is null
          order by created_at, id limit 500) n
      ), changed as (
        update notifications n set inbox_sequence = s.last_sequence + b.sequence_offset
        from batch b, notification_inbox_state s
        where n.id = b.id and s.user_id = ${userId}::uuid
        returning n.id
      ), advance as (
        update notification_inbox_state set last_sequence = last_sequence + (select count(*) from changed)
        where user_id = ${userId}::uuid returning user_id
      ) select count(*)::int as count from changed
    `);
    return result.rows[0]!.count;
  });
}

/** Single-operator rollout step; deliberately outside the migrator transaction. */
export async function finishNotificationInboxRollout(pool: Pool): Promise<void> {
  // An interrupted concurrent build leaves an invalid index; repair it before
  // IF NOT EXISTS, which would otherwise silently accept the invalid object.
  for (const [name, ddl] of [
    [
      'notifications_user_sequence_unique',
      'CREATE UNIQUE INDEX CONCURRENTLY notifications_user_sequence_unique ON notifications(user_id, inbox_sequence)',
    ],
    [
      'notifications_unread_sequence_idx',
      'CREATE INDEX CONCURRENTLY notifications_unread_sequence_idx ON notifications(user_id, inbox_sequence) WHERE read_at IS NULL',
    ],
    [
      'notifications_inbox_page_idx',
      'CREATE INDEX CONCURRENTLY notifications_inbox_page_idx ON notifications(user_id, created_at DESC, id DESC)',
    ],
  ]) {
    const { rows } = await pool.query(
      'select indisvalid from pg_index where indexrelid = to_regclass($1)',
      [name],
    );
    if (rows[0]?.indisvalid === false) await pool.query(`DROP INDEX CONCURRENTLY ${name}`);
    if (rows[0]?.indisvalid !== true) await pool.query(ddl!);
  }
  // The insert trigger is already installed (DDL waited for old inserts).
  // There can be no new null sequence from any still-running old binary.
  const enabled = await pool.query(`UPDATE notification_inbox_rollout SET ready = true
      WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE inbox_sequence IS NULL) RETURNING ready`);
  if (enabled.rowCount !== 1) throw new Error('Notification inbox backfill is incomplete');
}
