import { sql } from 'drizzle-orm';
import type { Db } from './client';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Fence every outbox producer, including old binaries, before draining workers. */
export async function quiesceNotificationProducers(db: Db) {
  await db.execute(
    sql`update notification_category_rollout set producers_frozen = true where singleton`,
  );
}

async function requireReconciledDeliveries(tx: Tx, eventTypes: string[]) {
  const gate = await tx.execute<{ producers_frozen: boolean }>(
    sql`select producers_frozen from notification_category_rollout where singleton for update`,
  );
  if (!gate.rows[0]?.producers_frozen)
    throw new Error('Quiesce outbox producers before switching workers');
  if (!eventTypes.length) throw new Error('Notification event types are required');
  // No timestamp boundary: rollback-era events and dead letters need the same
  // reconciliation as the initial cutover. Published events with active leases
  // or pending recipients also block a binary transition.
  const unresolved = await tx.execute(sql`select 1 from outbox_events e
    where e.published_at is null and e.event_type in (${sql.join(
      eventTypes.map((k) => sql`${k}`),
      sql`, `,
    )})
    union all select 1 from notification_push_deliveries where status in ('pending', 'attempting')
    limit 1`);
  if (unresolved.rows[0])
    throw new Error(
      'Unresolved deliveries require reconciliation with existing provider keys before switching workers',
    );
}

/** Explicit operator cutover after old workers are quiesced; never re-key ambiguity. */
export async function enableNotificationRecipientKeys(db: Db, eventTypes: string[]) {
  await db.transaction(async (tx) => {
    await requireReconciledDeliveries(tx, eventTypes);
    await tx.execute(
      sql`update notification_category_rollout set recipient_keys_enabled = true where singleton`,
    );
  });
}

/** Drain with the current binary/keys first; only then freeze and close its gate. */
export async function disableNotificationRecipientKeys(db: Db, eventTypes: string[]) {
  await db.transaction(async (tx) => {
    await requireReconciledDeliveries(tx, eventTypes);
    await tx.execute(sql`update notification_category_rollout
      set writes_frozen = true, recipient_keys_enabled = false where singleton`);
  });
}

const needsCollapse = sql`u.status <> 'deleted'
  and exists (select 1 from notification_category_preferences cp where cp.user_id = u.id and not cp.enabled)
  and (not exists (select 1 from notification_settings ns where ns.user_id = u.id and not ns.push_enabled)
    or exists (select 1 from notification_preferences np where np.user_id = u.id and np.channel = 'push' and np.enabled))`;

/** Resume only after cutover, or a complete conservative binary rollback. */
export async function resumeNotificationProducers(db: Db) {
  await db.transaction(async (tx) => {
    const gate = await tx.execute<{ recipient_keys_enabled: boolean; writes_frozen: boolean }>(
      sql`select recipient_keys_enabled, writes_frozen from notification_category_rollout where singleton for update`,
    );
    if (!gate.rows[0]) throw new Error('Notification rollout gate is missing');
    if (!gate.rows[0].recipient_keys_enabled) {
      const remaining = await tx.execute(sql`select 1 from users u where ${needsCollapse} limit 1`);
      if (!gate.rows[0].writes_frozen || remaining.rows[0])
        throw new Error('Complete rollback collapse before resuming outbox producers');
    }
    await tx.execute(
      sql`update notification_category_rollout set producers_frozen = false where singleton`,
    );
  });
}
export async function freezeNotificationPreferenceWrites(db: Db) {
  await db.execute(
    sql`update notification_category_rollout set writes_frozen = true where singleton`,
  );
}
/** Freeze commits first. One account per commit; safe to resume, no fleet-wide transaction. */
export async function collapseNotificationCategoriesBatch(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const gate = await tx.execute<{ writes_frozen: boolean }>(
      sql`select writes_frozen from notification_category_rollout where singleton for share`,
    );
    if (!gate.rows[0]?.writes_frozen)
      throw new Error('Freeze notification preferences before rollback collapse');
    const candidate = await tx.execute<{ id: string }>(sql`select u.id from users u
      where ${needsCollapse}
      order by u.id limit 1 for no key update of u`);
    const userId = candidate.rows[0]?.id;
    if (!userId) return 0;
    // Operator-only, transaction-local bypass. APIs never set this variable.
    await tx.execute(sql`select set_config('gogo.notification_rollback', 'on', true)`);
    await tx.execute(sql`insert into notification_settings(user_id, push_enabled, source, version)
      values (${userId}::uuid, false, 'migrated', 1) on conflict(user_id) do update
      set push_enabled = false, version = notification_settings.version + case when notification_settings.push_enabled then 1 else 0 end,
      updated_at = case when notification_settings.push_enabled then now() else notification_settings.updated_at end`);
    await tx.execute(sql`insert into notification_preferences(user_id, channel, kind, enabled)
      select ${userId}::uuid, 'push', k, false from unnest(enum_range(null::notification_kind)) k
      on conflict(user_id, channel, kind) do update set enabled = false`);
    await tx.execute(sql`insert into audit_logs(actor_type, action, resource_type, resource_id, diff)
      select 'system', 'notification.category_rollback_collapsed', 'user', ${userId},
        jsonb_build_object('pushEnabled', false, 'version', version::text)
      from notification_settings where user_id = ${userId}::uuid`);
    return 1;
  });
}
export async function unfreezeNotificationPreferenceWrites(db: Db) {
  const result = await db.execute(sql`update notification_category_rollout set writes_frozen = false
    where singleton and recipient_keys_enabled returning singleton`);
  if (!result.rows[0]) throw new Error('Category-aware cutover must be enabled before unfreeze');
}
