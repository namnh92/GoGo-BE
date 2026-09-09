import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * PROF-BE-001 (#531) — the profile's private side and the media cleanup
 * queue. ADR-0022. The profile columns themselves sit on `users`; this file
 * holds what hangs off them.
 */

/**
 * Private interests, keyed by taxonomy kind exactly like a room member's
 * `preference_selections` (`{"mood": ["chill"]}`) and validated by the same
 * check. One row per user: PATCH upserts it, DELETE /me cascades it away.
 * Nothing in a room reads this row; it is a default the client offers when a
 * room's own preferences are still empty.
 */
export const userProfilePreferences = pgTable('user_profile_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  selections: jsonb('selections').$type<Record<string, string[]>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An object that must disappear, recorded in the same transaction as the
 * change that made it unreferenced — a replaced avatar, a removed one, a
 * failed attachment's original, an erased account's picture. The worker
 * retries the delete with the outbox backoff and dead-letters after six
 * attempts; a row is deleted once the object is gone.
 *
 * A best-effort delete that forgets its failures leaves orphans nobody can
 * count. This table is what makes "every avatar object is either referenced or
 * scheduled for deletion" a true sentence.
 */
export const mediaCleanupQueue = pgTable(
  'media_cleanup_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    reason: text('reason').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('media_cleanup_queue_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.failedAt} is null`),
    // The same object enqueued twice (a replace racing a delete) is one job,
    // not two. Partial so a dead-lettered row never blocks a fresh attempt.
    uniqueIndex('media_cleanup_queue_object_unique')
      .on(t.bucket, t.objectKey)
      .where(sql`${t.failedAt} is null`),
  ],
);
