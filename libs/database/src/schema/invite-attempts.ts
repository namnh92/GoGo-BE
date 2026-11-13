import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** I05: independent of the I03 room/invite schema. No user or room authority. */
export const inviteAttemptContexts = pgTable(
  'invite_attempt_contexts',
  {
    id: uuid('id').primaryKey(),
    proofHash: text('proof_hash').notNull().unique(),
    purpose: text('purpose').notNull().default('invite_attempts'),
    transport: text('transport').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    check('invite_attempt_purpose', sql`${t.purpose} = 'invite_attempts'`),
    check('invite_attempt_transport', sql`${t.transport} in ('MOBILE_HEADER', 'BROWSER_COOKIE')`),
    check('invite_attempt_ttl', sql`${t.expiresAt} = ${t.createdAt} + interval '48 hours'`),
    index('invite_attempt_contexts_expiry_idx').on(t.expiresAt),
  ],
);

export const inviteAttemptReplays = pgTable(
  'invite_attempt_replays',
  {
    key: text('key').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => inviteAttemptContexts.id),
    ciphertext: text('ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('invite_attempt_replays_expiry_idx').on(t.expiresAt)],
);

/** Shared bootstrap flood buckets only; never used as the CODE6 risk ledger. */
export const inviteBootstrapBuckets = pgTable(
  'invite_bootstrap_buckets',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('invite_bootstrap_buckets_expiry_idx').on(t.expiresAt)],
);
