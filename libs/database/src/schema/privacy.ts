import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { privacyRequests } from './cms';

/** Raw bytes; node-postgres hands a `bytea` back as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * GoGo-BE#256, ADR-0031 — one secure export artifact's lifecycle.
 *
 * `pending → generating → ready → consumed`, with `expired`, `revoked` and
 * `failed` as the other terminal states. Cleanup is tracked beside the state,
 * not as a state of its own: an artifact is `expired` whether or not storage
 * has confirmed the bytes are gone, and `cleaned_at` is what says it has.
 */
export const privacyExportState = pgEnum('privacy_export_state', [
  'pending',
  'generating',
  'ready',
  'consumed',
  'expired',
  'revoked',
  'failed',
]);

export const privacyExportArtifacts = pgTable(
  'privacy_export_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** No cascade: accounts are soft-deleted, and the row must outlive the revocation. */
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id),
    /** The ledger row this artifact fulfils; the ledger keeps no artifact detail itself. */
    privacyRequestId: uuid('privacy_request_id').references(() => privacyRequests.id, {
      onDelete: 'set null',
    }),
    initiatorType: text('initiator_type').notNull(),
    initiatorId: uuid('initiator_id').notNull(),
    state: privacyExportState('state').notNull().default('pending'),
    /** `users.export_epoch` when requested; publication and redemption need it unchanged. */
    subjectEpoch: integer('subject_epoch').notNull(),
    /** Fencing token: every claim increments it, and only the current attempt may write. */
    attempt: integer('attempt').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    generationFailures: integer('generation_failures').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** Attempt-specific private object key, persisted before the upload starts. */
    objectKey: text('object_key'),
    formatVersion: smallint('format_version'),
    keyVersion: integer('key_version'),
    wrappedKey: bytea('wrapped_key'),
    wrapNonce: bytea('wrap_nonce'),
    wrapTag: bytea('wrap_tag'),
    plaintextBytes: integer('plaintext_bytes'),
    ciphertextBytes: integer('ciphertext_bytes'),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedSessionId: uuid('consumed_session_id'),
    transferCompletedAt: timestamp('transfer_completed_at', { withTimezone: true }),
    transferOutcome: text('transfer_outcome'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    cleanupDueAt: timestamp('cleanup_due_at', { withTimezone: true }),
    cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
    cleanupLastError: text('cleanup_last_error'),
    cleanupDeadAt: timestamp('cleanup_dead_at', { withTimezone: true }),
    cleanedAt: timestamp('cleaned_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('privacy_export_artifacts_initiator', sql`${t.initiatorType} in ('user', 'admin')`),
    check(
      'privacy_export_artifacts_ready_shape',
      sql`${t.state} <> 'ready' or (${t.objectKey} is not null and ${t.wrappedKey} is not null
        and ${t.expiresAt} is not null and ${t.readyAt} is not null)`,
    ),
    uniqueIndex('privacy_export_artifacts_one_active')
      .on(t.subjectUserId)
      .where(sql`${t.state} in ('pending', 'generating', 'ready')`),
    index('privacy_export_artifacts_subject_created_idx').on(t.subjectUserId, t.createdAt),
    index('privacy_export_artifacts_work_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.state} in ('pending', 'generating')`),
    index('privacy_export_artifacts_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'ready'`),
    index('privacy_export_artifacts_cleanup_idx')
      .on(t.cleanupDueAt)
      .where(
        sql`${t.cleanupDueAt} is not null and ${t.cleanedAt} is null and ${t.cleanupDeadAt} is null`,
      ),
  ],
);

/**
 * PR #677 F-04 — one durable deletion record per upload attempt, written before
 * the upload and removed only when that attempt is published. Every other
 * attempt's object is deleted once `delete_after` (past the upload's deadline)
 * has passed, so a late PUT cannot survive its record.
 */
export const privacyExportAttemptObjects = pgTable(
  'privacy_export_attempt_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id').notNull(),
    objectKey: text('object_key').notNull(),
    deleteAfter: timestamp('delete_after', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('privacy_export_attempt_objects_key_unique').on(t.objectKey),
    index('privacy_export_attempt_objects_due_idx')
      .on(t.deleteAfter)
      .where(sql`${t.deadAt} is null`),
  ],
);
