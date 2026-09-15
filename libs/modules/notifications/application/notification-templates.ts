import type { schema } from '@gogo/database';
import type { PushLocale, UserNotification } from '@gogo/providers';

/**
 * NTF-BE-005 (#196), GoGo-BE#594 — push copy and the push data contract, kept
 * out of the dispatcher.
 *
 * Before this file the outbox sent `headings: { en: 'GoGo' }` and the kind key
 * as the body, so every phone showed `plan_ready` on its lock screen. The
 * dispatcher decides who is told; this file decides what they read and what
 * the app routes on.
 *
 * Data contract v1, agreed with GoGo-MobileApp#256:
 *   - `type`, `version`, `notificationId`, `route`, `entityType`, `entityId`;
 *   - `kind`, `roomId`, `eventType` stay, because shipped clients read them.
 *
 * Lock screens show push content (spec §40). Every data value is an id, a
 * stable key or a route, and the copy takes no input at all — no member name,
 * no room title, no invite code — so there is nothing private a template could
 * leak.
 */

type NotificationKind = (typeof schema.notifications.$inferSelect)['kind'];

/** The kinds the outbox pushes. Campaigns carry CMS-authored copy of their own. */
export type PushKind = Extract<
  NotificationKind,
  'invite' | 'preference_reminder' | 'plan_ready' | 'plan_changed' | 'date_reminder'
>;

export const PUSH_PAYLOAD_VERSION = '1';

/** Product default (spec §39): an account without a supported locale reads Vietnamese. */
export const DEFAULT_PUSH_LOCALE: PushLocale = 'vi';

/** Send order. The default goes first and keeps the event id as its provider key. */
export const PUSH_LOCALES: readonly PushLocale[] = ['vi', 'en'];

type Copy = { heading: string; content: string };

/**
 * Audience-neutral on purpose: a room has N members, so nothing here says
 * "both of you", and nothing names the person or the room.
 */
const COPY: Record<PushKind, Record<PushLocale, Copy>> = {
  invite: {
    vi: { heading: 'Có thành viên mới', content: 'Một người vừa vào phòng của bạn.' },
    en: { heading: 'New member', content: 'Someone just joined your room.' },
  },
  preference_reminder: {
    vi: {
      heading: 'Có cập nhật sở thích',
      content: 'Một thành viên vừa chọn xong. Mở phòng để xem tiến độ.',
    },
    en: {
      heading: 'Preferences updated',
      content: 'A member just finished picking. Open the room to see progress.',
    },
  },
  plan_ready: {
    vi: { heading: 'Kế hoạch đã sẵn sàng', content: 'Mở GoGo để xem kế hoạch của phòng.' },
    en: { heading: 'Your plan is ready', content: "Open GoGo to see your room's plan." },
  },
  plan_changed: {
    vi: { heading: 'Kế hoạch có thay đổi', content: 'Kế hoạch của phòng vừa được cập nhật.' },
    en: { heading: 'Plan updated', content: "Your room's plan was just updated." },
  },
  date_reminder: {
    vi: { heading: 'Buổi đi chơi đã bắt đầu', content: 'Mở GoGo để xem lịch trình.' },
    en: { heading: 'Your outing has started', content: 'Open GoGo to see the itinerary.' },
  },
};

/** `users.locale` is free text in the schema; only its language decides. */
export function pushLocaleOf(locale: string | null | undefined): PushLocale {
  const language = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (PUSH_LOCALES as readonly string[]).includes(language)
    ? (language as PushLocale)
    : DEFAULT_PUSH_LOCALE;
}

/**
 * Headings and contents for one recipient locale.
 *
 * OneSignal picks among these keys by the *device* language and falls back to
 * `en`, which it requires. GoGo renders for the account's locale (spec §39), so
 * the recipient's copy fills both `en` and its own key: a Vietnamese account on
 * an English-language phone still reads Vietnamese, and an English account
 * reads English whatever the phone is set to.
 */
export function renderPushCopy(
  kind: PushKind,
  locale: PushLocale,
): Pick<UserNotification, 'headings' | 'contents'> {
  const { heading, content } = COPY[kind][locale];
  return {
    headings: { [locale]: heading, en: heading },
    contents: { [locale]: content, en: content },
  };
}

export type PushTarget = { entityType: 'room' | 'plan'; entityId: string };

/**
 * Kinds about the plan open the plan. The room lobby has no way to it, which
 * is how a tapped `plan_ready` used to leave people hunting for the plan.
 */
const PLAN_KINDS: ReadonlySet<PushKind> = new Set<PushKind>([
  'plan_ready',
  'plan_changed',
  'date_reminder',
]);

export function opensPlan(kind: PushKind): boolean {
  return PLAN_KINDS.has(kind);
}

/** A plan kind with no current plan (none yet, or archived) falls back to the room. */
export function pushTarget(
  kind: PushKind,
  roomId: string,
  currentPlanId: string | null,
): PushTarget {
  return opensPlan(kind) && currentPlanId
    ? { entityType: 'plan', entityId: currentPlanId }
    : { entityType: 'room', entityId: roomId };
}

/** The canonical link the app's DeepLinkRouter (Mobile #57) parses. */
export function pushRoute(target: PushTarget): string {
  return `gogo://${target.entityType}/${target.entityId}`;
}

export type PushEvent = { id: string; eventType: string };

export function renderPushData(input: {
  kind: PushKind;
  event: PushEvent;
  roomId: string;
  target: PushTarget;
}): Record<string, string> {
  return {
    type: input.kind,
    version: PUSH_PAYLOAD_VERSION,
    // The outbox event: the same for every recipient of one fan-out, which is
    // what lets the app drop a click it has already routed. Not the inbox row.
    notificationId: input.event.id,
    route: pushRoute(input.target),
    entityType: input.target.entityType,
    entityId: input.target.entityId,
    kind: input.kind,
    roomId: input.roomId,
    eventType: input.event.eventType,
  };
}

export function renderPushNotification(input: {
  kind: PushKind;
  locale: PushLocale;
  event: PushEvent;
  roomId: string;
  currentPlanId: string | null;
}): Pick<UserNotification, 'headings' | 'contents'> & { data: Record<string, string> } {
  const target = pushTarget(input.kind, input.roomId, input.currentPlanId);
  return {
    ...renderPushCopy(input.kind, input.locale),
    data: renderPushData({ kind: input.kind, event: input.event, roomId: input.roomId, target }),
  };
}

/**
 * The default locale keeps the bare event id — the key every earlier release
 * sent — so a retry that straddles the deploy replays at the provider instead
 * of pushing twice. Other locales derive their own key from it.
 */
export function pushIdempotencyKey(eventId: string, locale: PushLocale): string {
  return locale === DEFAULT_PUSH_LOCALE ? eventId : `${eventId}:${locale}`;
}
