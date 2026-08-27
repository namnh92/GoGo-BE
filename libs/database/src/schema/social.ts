import { sql } from 'drizzle-orm';
import {
  boolean,
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
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

export const devicePlatform = pgEnum('device_platform', ['ios', 'android', 'web']);

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
