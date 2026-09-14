import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { places } from './places';
import { plans } from './plans';

/**
 * DB-007 — saved/review/report/notification schema.
 * Ownership integrity: reviews belong to their author only; reports and
 * moderation decisions keep an auditable reason.
 */

export const savedTargetType = pgEnum('saved_target_type', ['place', 'plan']);

export const savedItems = pgTable(
  'saved_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: savedTargetType('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('saved_items_unique').on(t.userId, t.targetType, t.targetId)],
);

export const reviewStatus = pgEnum('review_status', [
  'pending',
  'published',
  'rejected',
  'removed',
  // SEC-001 emergency takedown. Separate from the moderator verdicts above:
  // this one means "taken down under time pressure, pending review".
  'hidden',
]);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id').references(() => places.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').references(() => plans.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    text: text('text'),
    status: reviewStatus('status').notNull().default('pending'),
    moderatedByAdminId: uuid('moderated_by_admin_id'),
    moderationReason: text('moderation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('reviews_rating_range', sql`${t.rating} between 1 and 5`),
    check(
      'reviews_one_target',
      sql`(${t.placeId} is not null)::int + (${t.planId} is not null)::int = 1`,
    ),
    index('reviews_place_idx').on(t.placeId, t.status),
    index('reviews_user_idx').on(t.userId),
  ],
);

export const reportTargetType = pgEnum('report_target_type', ['place', 'review', 'member']);
export const reportStatus = pgEnum('report_status', ['open', 'actioned', 'dismissed']);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterUserId: uuid('reporter_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reporterGuestSessionId: uuid('reporter_guest_session_id'),
    targetType: reportTargetType('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    note: text('note'),
    status: reportStatus('status').notNull().default('open'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reports_status_idx').on(t.status, t.createdAt)],
);

export const notificationKind = pgEnum('notification_kind', [
  'invite',
  'preference_reminder',
  'plan_ready',
  'plan_changed',
  'date_reminder',
  'moderation_update',
  /** BE-CMS-G4e (#226) — a CMS campaign, dispatched through the outbox. */
  'campaign',
]);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
    payload: jsonb('payload').notNull(),
    /**
     * The outbox event that produced this row. Delivery is at-least-once, so
     * without it a retry after a partial fan-out puts the same notification in
     * someone's inbox twice.
     */
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    /**
     * #193 — the delivery fact, separate from the inbox fact. Set when the
     * provider created a message for this recipient; null means a push is
     * still owed (never attempted, or the attempt failed before the provider
     * accepted it). The campaign dispatcher retries rows without it and skips
     * rows with it, which is what makes a reschedule after an outage safe.
     */
    pushSentAt: timestamp('push_sent_at', { withTimezone: true }),
    pushMessageId: text('push_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    // Delivery is at-least-once, so a retry has to be a no-op rather than a
    // second push. The column existed and was never unique.
    uniqueIndex('notifications_dedupe_unique')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

export const notificationChannel = pgEnum('notification_channel', ['push', 'email']);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull(),
    kind: notificationKind('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [uniqueIndex('notification_preferences_unique').on(t.userId, t.channel, t.kind)],
);

/**
 * NTF-BE-014 (#572), ADR-0025 — the one application-level push switch.
 *
 * No row means the person never chose, which is on — exactly what an account
 * without per-kind rows already meant. Once a row exists it alone decides
 * whether GoGo asks the provider to push to this account; the per-kind rows in
 * `notification_preferences` stay (rollback reads them, email keeps them) and no
 * longer gate push. The in-app inbox is written either way.
 *
 * An app preference and nothing more: not the OS permission on any device, not
 * a registered subscription, never evidence that anything was delivered.
 */
export const notificationSettings = pgTable(
  'notification_settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    pushEnabled: boolean('push_enabled').notNull(),
    /**
     * `explicit` — set through the switch; `migrated` — the 0064 backfill;
     * `legacy` — an older client turned one kind off, which turns push off.
     */
    source: text('source').$type<'explicit' | 'migrated' | 'legacy'>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('notification_settings_source', sql`${t.source} in ('explicit', 'migrated', 'legacy')`),
  ],
);

export const devicePlatform = pgEnum('device_platform', ['ios', 'android', 'web']);

/**
 * @deprecated NTF-BE-011 (#515) — nothing routes on this and nothing writes to
 * it. `PUT /me/device-tokens` was removed in contract 1.0.0-alpha.19; the
 * campaign audience now reads {@link pushSubscriptions}. The table is left in
 * place so account deletion keeps clearing the rows that already exist; a
 * separate migration drops it.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: devicePlatform('platform').notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('device_tokens_token_unique').on(t.token)],
);

/**
 * NTF-BE-011 (#515) — which of GoGo's users can be reached by a push, and on
 * what platform.
 *
 * Not a routing table and not a device registry (OneSignal spec §26,
 * ADR-0016): a push is addressed to `external_id = users.id` and the provider
 * owns the device list. This exists because a campaign has to resolve an
 * audience in one SQL predicate, and "can this person receive a push" is the
 * one part of that question the provider cannot be asked once per campaign.
 *
 * `subscriptionId` is OneSignal's id for a device's push subscription, and
 * every row was verified against the provider before it was written. It is not
 * an APNs or FCM token; nothing here is ever used as a send target.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: devicePlatform('platform').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last time the provider agreed this device is subscribed for this user. */
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Set when a confirmed logout proved the device is no longer subscribed for
     * this user. Kept rather than deleted so a device that signs back in is the
     * same row, and so the audience can be explained after the fact.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('push_subscriptions_subscription_unique').on(t.subscriptionId),
    index('push_subscriptions_live_idx')
      .on(t.userId, t.platform)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// ------------------------------------------------------- campaigns (#226)

export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
  'failed',
]);

/**
 * Only the audiences the backend can resolve from data it holds. `city`,
 * `app_version` and `custom_segment` from the mockup are deliberately absent:
 * nothing stores a user's city or their app version, and a campaign aimed at a
 * segment the server cannot compute reaches the wrong people — which is not
 * recoverable once sent.
 */
export const campaignAudience = pgEnum('campaign_audience', ['all', 'couple', 'group', 'platform']);

export const campaignDestination = pgEnum('campaign_destination', [
  'home',
  'place',
  'recommendation',
  'plan_template',
  'saved',
  'external_url',
]);

/**
 * BE-CMS-G4e (#226) — a campaign the CMS composes and a worker sends.
 *
 * Nothing here is dispatched from the request path. The API validates and
 * stores; the worker claims what is due, resolves the audience at send time
 * and hands each message to the provider adapter. A campaign sent by mistake
 * cannot be recalled, so the only thing that can start one is a row transition
 * something else picks up.
 */
export const notificationCampaigns = pgTable(
  'notification_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The editorial name; `title` is what lands on a lock screen. */
    name: text('name').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Key from POST /cms/uploads, purpose `campaign_image`. */
    imageKey: text('image_key'),
    ctaLabel: text('cta_label'),
    audienceType: campaignAudience('audience_type').notNull(),
    audienceFilter: jsonb('audience_filter').notNull().default({}),
    destinationType: campaignDestination('destination_type').notNull().default('home'),
    destinationValue: text('destination_value'),
    status: campaignStatus('status').notNull().default('draft'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Stamped when a send is scheduled and used to build each message's dedupe
     * key, so a worker retry cannot deliver twice while a genuine re-send after
     * a cancel still can.
     */
    dispatchKey: uuid('dispatch_key'),
    recipientCount: integer('recipient_count'),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    lastError: text('last_error'),
    /** A request the worker picks up; it never touches `status`. */
    testSendRequestedAt: timestamp('test_send_requested_at', { withTimezone: true }),
    testSendUserId: uuid('test_send_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    testSendCompletedAt: timestamp('test_send_completed_at', { withTimezone: true }),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    cancelledByAdminId: uuid('cancelled_by_admin_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_campaigns_name_unique').on(t.name),
    index('notification_campaigns_due_idx').on(t.scheduledAt),
    index('notification_campaigns_list_idx').on(t.createdAt, t.id),
  ],
);
