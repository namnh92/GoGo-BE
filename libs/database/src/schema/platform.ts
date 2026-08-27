import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
