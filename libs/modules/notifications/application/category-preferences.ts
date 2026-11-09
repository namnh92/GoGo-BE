import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import {
  beginIdempotent,
  completeIdempotentWithin,
  type IdempotencyScope,
} from '../../shared/idempotency.interceptor';
import {
  CONFIGURABLE_CATEGORIES,
  normalizePreferencePatch,
  applyPreferencePatch,
  type PreferencePatch,
  DEFAULT_CATEGORIES,
  effectivePush,
  NOTIFICATION_KINDS,
  type CategoryPreferences,
} from '../domain/notification-registry';
import { pushAllowed } from './push-preference';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type NotificationSettingsView = {
  pushEnabled: boolean;
  source: 'default' | 'explicit' | 'migrated' | 'legacy';
  updatedAt: string | null;
  version: string;
  categories: CategoryPreferences;
};
export type SettingsPatch = PreferencePatch;
export const settingsEtag = (version: string): string => `"notification-settings-${version}"`;

/** One statement keeps version, master and categories in the same MVCC snapshot. */
export async function readNotificationSettings(
  db: Pick<Db, 'execute'>,
  userId: string,
): Promise<NotificationSettingsView> {
  const { rows } = await db.execute<{
    push_enabled: boolean;
    source: NotificationSettingsView['source'];
    updated_at: string | null;
    version: string;
    categories: Partial<CategoryPreferences> | null;
  }>(sql`select ${pushAllowed(sql`u.id`)} as push_enabled,
      coalesce(ns.source, case when ${pushAllowed(sql`u.id`)} then 'default' else 'legacy' end) as source,
      ns.updated_at, coalesce(ns.version, 0)::text as version,
      (select jsonb_object_agg(category, enabled) from notification_category_preferences where user_id = u.id) as categories
    from users u left join notification_settings ns on ns.user_id = u.id
    where u.id = ${userId}::uuid and u.status <> 'deleted'`);
  const row = rows[0];
  if (!row) throw AppError.unauthorized();
  return {
    pushEnabled: row.push_enabled,
    source: row.source,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    version: row.version,
    categories: { ...DEFAULT_CATEGORIES, ...row.categories },
  };
}

async function lockChoices(tx: Tx, userId: string) {
  const gate = await tx.execute<{ writes_frozen: boolean; recipient_keys_enabled: boolean }>(
    sql`select writes_frozen, recipient_keys_enabled from notification_category_rollout where singleton for share`,
  );
  if (!gate.rows[0] || gate.rows[0].writes_frozen || !gate.rows[0].recipient_keys_enabled)
    throw AppError.serviceUnavailable(
      'NOTIFICATION_PREFERENCES_FROZEN',
      'Preference mutations temporarily frozen',
    );
  const account = await tx.execute(
    sql`select id from users where id = ${userId}::uuid and status <> 'deleted' for no key update`,
  );
  if (!account.rows[0]) throw AppError.unauthorized();
}
async function store(
  tx: Tx,
  userId: string,
  before: NotificationSettingsView,
  patch: SettingsPatch,
  source: 'explicit' | 'legacy',
) {
  const { categories, pushEnabled: master } = applyPreferencePatch(before, patch);
  const changed =
    master !== before.pushEnabled ||
    CONFIGURABLE_CATEGORIES.some((k) => categories[k] !== before.categories[k]);
  // Metadata changes also get a new resource version: the strong ETag covers the whole response.
  const increment = changed || before.source !== source || before.updatedAt === null;
  await tx.execute(sql`insert into notification_settings(user_id, push_enabled, source, version)
    values (${userId}::uuid, ${master}, ${source}, ${increment ? 1 : 0})
    on conflict(user_id) do update set push_enabled = excluded.push_enabled, source = excluded.source,
      version = notification_settings.version + ${increment ? 1 : 0},
      updated_at = case when ${increment} then now() else notification_settings.updated_at end`);
  for (const category of CONFIGURABLE_CATEGORIES) {
    if (patch.categories?.[category] === undefined) continue;
    await tx.execute(sql`insert into notification_category_preferences(user_id, category, enabled)
      values (${userId}::uuid, ${category}, ${categories[category]}) on conflict(user_id, category)
      do update set enabled = excluded.enabled, updated_at = case
        when notification_category_preferences.enabled <> excluded.enabled then now()
        else notification_category_preferences.updated_at end`);
  }
  for (const kind of NOTIFICATION_KINDS) {
    await tx.execute(sql`insert into notification_preferences(user_id, channel, kind, enabled)
      values (${userId}::uuid, 'push', ${kind}, ${effectivePush(kind, master, categories)})
      on conflict(user_id, channel, kind) do update set enabled = excluded.enabled`);
  }
  const result = await readNotificationSettings(tx, userId);
  if (increment)
    await writeAudit(tx, {
      actorType: 'user',
      actorId: userId,
      action: 'user.notification_settings_updated',
      resourceType: 'user',
      resourceId: userId,
      diff: { pushEnabled: master, categories, version: result.version, source },
    });
  return result;
}
export async function mutateNotificationSettings(
  db: Db,
  userId: string,
  patch: SettingsPatch,
  options: {
    legacyPut?: boolean;
    legacyOptIn?: boolean;
    ifMatch?: string;
    scope?: IdempotencyScope;
    source?: 'explicit' | 'legacy';
  } = {},
) {
  return db.transaction(async (tx) => {
    await lockChoices(tx, userId);
    // A committed replay wins over a stale (or absent) precondition.
    const begin = options.scope ? await beginIdempotent(tx, options.scope) : null;
    if (begin?.kind === 'replay') return begin.body as NotificationSettingsView;
    const before = await readNotificationSettings(tx, userId);
    if (options.scope) {
      if (!options.ifMatch) throw new AppError('PRECONDITION_REQUIRED', 'If-Match required', 428);
      if (options.ifMatch !== settingsEtag(before.version))
        throw new AppError(
          'NOTIFICATION_SETTINGS_VERSION_MISMATCH',
          'Notification settings changed',
          412,
        );
    }
    const applied = normalizePreferencePatch(patch, options.legacyPut);
    // A legacy opt-in retains all choices; its first mutation materializes the fallback master.
    const result = options.legacyOptIn
      ? before.updatedAt === null
        ? await store(tx, userId, before, {}, 'legacy')
        : before
      : await store(tx, userId, before, applied, options.source ?? 'explicit');
    if (begin?.kind === 'owned' && !(await completeIdempotentWithin(tx, begin.claim, 200, result)))
      throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Retry the request');
    return result;
  });
}

export async function mutateNotificationEmail(
  db: Db,
  userId: string,
  input: { kind: string; enabled: boolean },
) {
  await db.transaction(async (tx) => {
    await lockChoices(tx, userId);
    await tx.execute(sql`insert into notification_preferences(user_id, channel, kind, enabled)
      values (${userId}::uuid, 'email', ${input.kind}, ${input.enabled})
      on conflict(user_id, channel, kind) do update set enabled = excluded.enabled`);
  });
}
