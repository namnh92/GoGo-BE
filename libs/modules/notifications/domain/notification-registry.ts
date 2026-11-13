/** ADR-0050: one registry owns categories, channels and producer decisions. */
export const CONFIGURABLE_CATEGORIES = [
  'invite',
  'preference_reminder',
  'plan_ready',
  'plan_changed',
  'date_reminder',
] as const;
export type NotificationCategory = (typeof CONFIGURABLE_CATEGORIES)[number];
export type CategoryPreferences = Record<NotificationCategory, boolean>;
export const DEFAULT_CATEGORIES: CategoryPreferences = Object.fromEntries(
  CONFIGURABLE_CATEGORIES.map((key) => [key, true]),
) as CategoryPreferences;

type Registration = {
  category: NotificationCategory | 'other';
  channels: readonly ('in_app' | 'push')[];
  producer: string | null;
  audience?: 'host' | 'members' | 'transferred_member';
};
export const NOTIFICATION_REGISTRY = {
  host_transferred: {
    category: 'other',
    channels: ['in_app', 'push'],
    producer: 'room.host_transferred',
    audience: 'transferred_member',
  },
  invite: {
    category: 'invite',
    channels: ['in_app', 'push'],
    producer: 'member.joined',
    audience: 'host',
  },
  preference_reminder: {
    category: 'preference_reminder',
    channels: ['in_app', 'push'],
    producer: 'preferences.completed',
    audience: 'host',
  },
  plan_ready: {
    category: 'plan_ready',
    channels: ['in_app', 'push'],
    producer: 'plan.published',
    audience: 'members',
  },
  plan_changed: {
    category: 'plan_changed',
    channels: ['in_app', 'push'],
    producer: 'plan.changed',
    audience: 'members',
  },
  date_reminder: {
    category: 'date_reminder',
    channels: ['in_app', 'push'],
    producer: 'room.reminder_due',
    audience: 'members',
  },
  campaign: { category: 'other', channels: ['in_app', 'push'], producer: 'campaign' },
  moderation_update: { category: 'other', channels: ['in_app'], producer: null },
  privacy_export_ready: {
    category: 'other',
    channels: ['in_app'],
    producer: 'privacy.export_ready',
  },
} as const satisfies Record<string, Registration>;
export type NotificationKind = keyof typeof NOTIFICATION_REGISTRY;
export const NOTIFICATION_KINDS = Object.keys(NOTIFICATION_REGISTRY) as NotificationKind[];
export function registration(kind: string): Registration {
  return Object.hasOwn(NOTIFICATION_REGISTRY, kind)
    ? NOTIFICATION_REGISTRY[kind as NotificationKind]
    : { category: 'other', channels: ['in_app'], producer: null };
}
export function effectivePush(
  kind: string,
  master: boolean,
  categories: CategoryPreferences,
): boolean {
  const entry = registration(kind);
  return (
    entry.channels.includes('push') &&
    master &&
    (entry.category === 'other' || categories[entry.category])
  );
}
/** Canonical set identity: order and duplicate query parameters do not change a filter. */
export function inboxFilter(kinds: readonly NotificationKind[] = []): string {
  return kinds.length ? [...new Set(kinds)].sort().join(',') : 'all';
}

export type PreferencePatch = { pushEnabled?: boolean; categories?: Partial<CategoryPreferences> };
export function normalizePreferencePatch(
  patch: PreferencePatch,
  globalPut = false,
): PreferencePatch {
  return globalPut && patch.pushEnabled
    ? { ...patch, categories: { ...DEFAULT_CATEGORIES } }
    : patch;
}
export function applyPreferencePatch(
  before: { pushEnabled: boolean; categories: CategoryPreferences },
  patch: PreferencePatch,
) {
  return {
    pushEnabled: patch.pushEnabled ?? before.pushEnabled,
    categories: { ...before.categories, ...patch.categories },
  };
}
