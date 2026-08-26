import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * DB-004 — room/member/constraint/preference schema.
 * Invariants: rooms support N members; host/member is a server-side role;
 * constraints are versioned — editing produces a new version and marks
 * dependent scores/plans stale; guests are scoped to exactly one room.
 */

export const roomType = pgEnum('room_type', ['couple', 'group']);
export const roomStatus = pgEnum('room_status', [
  'draft',
  'collecting',
  'matching',
  'ready',
  'active',
  'completed',
  'cancelled',
  'expired',
]);
export const decisionMode = pgEnum('decision_mode', ['match', 'vote', 'host']);
export const budgetMode = pgEnum('budget_mode', ['total', 'per_person']);
export const memberRole = pgEnum('member_role', ['host', 'member']);
export const selectionStatus = pgEnum('selection_status', ['pending', 'in_progress', 'completed']);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Public share code — high entropy, no PII, expiring via expiresAt.
    code: text('code').notNull(),
    type: roomType('type').notNull(),
    status: roomStatus('status').notNull().default('draft'),
    decisionMode: decisionMode('decision_mode').notNull(),
    hostUserId: uuid('host_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    participantCount: integer('participant_count').notNull().default(2),
    // Bumped on every constraint edit; scores/plans referencing an older
    // version are stale by definition.
    constraintVersion: integer('constraint_version').notNull().default(1),
    title: text('title'),
    scheduledDate: timestamp('scheduled_date', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rooms_code_unique').on(t.code),
    index('rooms_host_idx').on(t.hostUserId),
    index('rooms_status_idx').on(t.status),
    check('rooms_participant_count_min', sql`${t.participantCount} >= 2`),
  ],
);

export const roomConstraints = pgTable(
  'room_constraints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // Exact origin has limited retention (privacy rule) — the privacy job
    // nulls originLat/Lng after the retention window, keeping originText.
    originText: text('origin_text'),
    originLat: doublePrecision('origin_lat'),
    originLng: doublePrecision('origin_lng'),
    areaKey: text('area_key'),
    radiusM: integer('radius_m'),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    budgetMode: budgetMode('budget_mode').notNull(),
    // Integer minor units; interpretation depends on budgetMode.
    budgetAmount: bigint('budget_amount', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('VND'),
    dietaryKeys: jsonb('dietary_keys').$type<string[]>().notNull().default([]),
    accessibilityKeys: jsonb('accessibility_keys').$type<string[]>().notNull().default([]),
    createdByMemberId: uuid('created_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_constraints_room_version_unique').on(t.roomId, t.version),
    check('room_constraints_budget_positive', sql`${t.budgetAmount} >= 0`),
    check(
      'room_constraints_time_order',
      sql`${t.startAt} is null or ${t.endAt} is null or ${t.startAt} < ${t.endAt}`,
    ),
  ],
);

export const guestSessions = pgTable(
  'guest_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    // SHA-256 of the guest bearer credential — plaintext never persists.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('guest_sessions_token_hash_unique').on(t.tokenHash),
    index('guest_sessions_room_idx').on(t.roomId),
  ],
);

export const roomMembers = pgTable(
  'room_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestSessionId: uuid('guest_session_id').references(() => guestSessions.id, {
      onDelete: 'cascade',
    }),
    role: memberRole('role').notNull().default('member'),
    displayName: text('display_name').notNull(),
    selectionStatus: selectionStatus('selection_status').notNull().default('pending'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedByMemberId: uuid('removed_by_member_id'),
  },
  (t) => [
    // Exactly one identity per membership row.
    check(
      'room_members_one_identity',
      sql`(${t.userId} is not null)::int + (${t.guestSessionId} is not null)::int = 1`,
    ),
    uniqueIndex('room_members_room_user_unique')
      .on(t.roomId, t.userId)
      .where(sql`${t.userId} is not null and ${t.removedAt} is null`),
    uniqueIndex('room_members_room_guest_unique')
      .on(t.roomId, t.guestSessionId)
      .where(sql`${t.guestSessionId} is not null and ${t.removedAt} is null`),
    index('room_members_room_idx').on(t.roomId),
  ],
);

export const roomInvites = pgTable(
  'room_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    // SHA-256 of the invite code — lookup by hash, plaintext shown once.
    codeHash: text('code_hash').notNull(),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_invites_code_hash_unique').on(t.codeHash),
    index('room_invites_room_idx').on(t.roomId),
  ],
);

export const preferenceSelections = pgTable(
  'preference_selections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => roomMembers.id, { onDelete: 'cascade' }),
    // Stable taxonomy keys grouped by kind, e.g. {"mood": ["chill"], ...}.
    selections: jsonb('selections').$type<Record<string, string[]>>().notNull().default({}),
    weights: jsonb('weights').$type<Record<string, number>>(),
    isDraft: boolean('is_draft').notNull().default(true),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Optimistic concurrency for autosave (BE-BFF-005).
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('preference_selections_member_unique').on(t.roomId, t.memberId)],
);

/** FR-ROOM-010/011 — host-suggested seed places on a room draft. */
export const roomSeedPlaces = pgTable(
  'room_seed_places',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id').notNull(),
    position: integer('position').notNull().default(0),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('room_seed_places_unique').on(t.roomId, t.placeId)],
);
