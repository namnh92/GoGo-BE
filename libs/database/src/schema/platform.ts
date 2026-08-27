import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Platform tables: transactional outbox for domain events and idempotency
 * keys for retryable mutations (api-contract rules).
 */

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    // Pseudonymous actor id (users.analytics_id or hashed guest id).
    actorId: text('actor_id'),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    correlationId: text('correlation_id'),
    payloadSchemaVersion: integer('payload_schema_version').notNull().default(1),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** When this event may next be attempted; null means now. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /**
     * Set once attempts are exhausted. A dead-lettered event stops being
     * selected — and stops blocking everything behind it — while staying
     * inspectable. Deleting it would throw away the only record of the
     * failure.
     */
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [index('outbox_events_unpublished_idx').on(t.publishedAt, t.occurredAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    // Scoped per actor + endpoint so keys cannot collide across users.
    key: text('key').notNull().primaryKey(),
    actorId: text('actor_id').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idempotency_keys_expiry_idx').on(t.expiresAt)],
);

/**
 * BE-BFF-016 (#171) — what makes an upload key mean something.
 *
 * Check-in accepted `photoKeys` and `billPhotoKey` before any endpoint could
 * produce one. A presigned key on its own is an unowned string: without this
 * row, any member could attach any key, including another member's. The row
 * binds the key to the actor who asked for it, to a purpose, and to an expiry.
 */
export const mediaUploads = pgTable(
  'media_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storageKey: text('storage_key').notNull().unique(),
    /** Guests included: a guest checks in on its own room. */
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    purpose: text('purpose').notNull(),
    contentType: text('content_type').notNull(),
    contentLength: integer('content_length').notNull(),
    /**
     * `pending` → `attached`. Deliberately no `uploaded`: the API never sees
     * the bytes land, and recording a state it cannot observe would put a
     * claim in the data that nothing verifies.
     */
    status: text('status').notNull().default('pending'),
    attachedToType: text('attached_to_type'),
    attachedToId: text('attached_to_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
  },
  (t) => [index('media_uploads_actor_idx').on(t.actorId, t.status, t.expiresAt)],
);

/**
 * SE-006 (#36) — daily search aggregate.
 *
 * A day/term counter rather than one row per request: cheaper, and the more
 * private shape, because there is no actor on it to join a query back to a
 * person with. Raw per-request search logs are deliberately not kept.
 */
export const searchQueryDaily = pgTable(
  'search_query_daily',
  {
    day: date('day').notNull(),
    /** Truncated, never stored with an actor; hidden below a k-anonymity floor on read. */
    queryNormalized: text('query_normalized').notNull(),
    hasQuery: boolean('has_query').notNull(),
    searches: integer('searches').notNull().default(0),
    zeroResults: integer('zero_results').notNull().default(0),
    resultsSum: bigint('results_sum', { mode: 'number' }).notNull().default(0),
    latencyMsSum: bigint('latency_ms_sum', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.queryNormalized] }),
    index('search_query_daily_day_idx').on(t.day, t.zeroResults),
  ],
);
