import { sql, type SQL } from 'drizzle-orm';
import { registration } from '../domain/notification-registry';

/**
 * NTF-BE-014 (#572), ADR-0025 — may GoGo ask the provider to push to this
 * account at all?
 *
 * One SQL expression over a user id, used by the transactional outbox, the
 * campaign estimate and the campaign send, so the three cannot disagree about
 * who asked not to be pushed.
 *
 * `notification_settings.push_enabled` decides whenever the account has a row.
 * Without one the account is on, unless it holds a push-channel per-kind
 * opt-out — the same rule migration 0064 backfilled with, so an account the
 * migration never saw (a legacy write racing the deploy) lands where the
 * backfill would have put it rather than silently back on.
 */
export function pushAllowed(userId: SQL): SQL {
  return sql`coalesce(
    (select ns.push_enabled from notification_settings ns where ns.user_id = ${userId}),
    not exists (
      select 1 from notification_preferences np
      where np.user_id = ${userId} and np.channel = 'push' and np.enabled = false
    )
  )`;
}

/** Unknown/unregistered push kinds fail closed; other still follows master. */
export function kindPushAllowed(userId: SQL, kind: string): SQL {
  const entry = registration(kind);
  if (!entry.channels.includes('push')) return sql`false`;
  return sql`(${pushAllowed(userId)}) and ${
    entry.category === 'other'
      ? sql`true`
      : sql`coalesce(
    (select cp.enabled from notification_category_preferences cp
      where cp.user_id = ${userId} and cp.category = ${entry.category}), true)`
  }`;
}
