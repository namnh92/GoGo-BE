import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * DB-003 — identity/session/user schema.
 * Security invariants (ADR-0003): refresh tokens stored only as SHA-256 hashes
 * with a rotation family + revoke chain; no plaintext credentials anywhere.
 */

/**
 * #246 — `suspended` and `banned` both stop a login; what separates them is
 * whether the account is expected back. `deleted` is not a moderation outcome
 * at all: it is the privacy one, and the state that frees the address for
 * re-registration.
 */
export const userStatus = pgEnum('user_status', ['active', 'suspended', 'banned', 'deleted']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    locale: text('locale').notNull().default('vi'),
    status: userStatus('status').notNull().default('active'),
    // Pseudonymous identity used in analytics/events instead of the user id.
    analyticsId: uuid('analytics_id').notNull().defaultRandom(),
    /**
     * ADR-0022 — the profile's optional fields. `avatarKey` is the processed
     * object in the public bucket, never the original upload; the URL is
     * composed on the server. `homeAreaKey` is `service_areas.key`, with the
     * foreign key declared in migration 0061 rather than here: this file
     * cannot import `./places` without a cycle (`places` imports `users`).
     * `usualBudgetPerPerson` is integer minor units, a create-room default,
     * never a room constraint.
     */
    avatarKey: text('avatar_key'),
    homeAreaKey: text('home_area_key'),
    usualBudgetPerPerson: bigint('usual_budget_per_person', { mode: 'number' }),
    usualBudgetCurrency: char('usual_budget_currency', { length: 3 }).notNull().default('VND'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Unique only for live accounts so delete + re-register works.
    uniqueIndex('users_email_unique')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.status} <> 'deleted' and ${t.email} is not null`),
    check(
      'users_usual_budget_nonnegative',
      sql`${t.usualBudgetPerPerson} is null or ${t.usualBudgetPerPerson} >= 0`,
    ),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 hex of the opaque refresh token; the plaintext never persists.
    refreshTokenHash: text('refresh_token_hash').notNull(),
    // Rotation chain: reuse of a superseded token revokes the whole family.
    familyId: uuid('family_id').notNull(),
    rotatedFromId: uuid('rotated_from_id'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Coarse client fingerprint for abuse review — never raw IP.
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('auth_sessions_token_hash_unique').on(t.refreshTokenHash),
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_family_idx').on(t.familyId),
  ],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Hash of lowercased identifier — enumeration-safe abuse tracking.
    identifierHash: text('identifier_hash').notNull(),
    ipHash: text('ip_hash').notNull(),
    succeeded: boolean('succeeded').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('login_attempts_identifier_idx').on(t.identifierHash, t.createdAt),
    index('login_attempts_ip_idx').on(t.ipHash, t.createdAt),
  ],
);
