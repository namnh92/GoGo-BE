import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { adminUsers } from './cms';

/**
 * GoGo-BE#713 — GoGo AI assistant (ADR-0036, `docs/assistant.md`).
 *
 * Personal data keyed by `user_id`: hard-deleted by the user, by retention
 * (90 days after `last_message_at`) and by account erasure. Cards keep ids
 * only — no copy of place facts (CLAUDE.md: no new persistent Google
 * content); facts are re-read from verified data whenever a message is read.
 */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** User-set, or derived from the first message. Never model text. */
    title: text('title'),
    contextKind: text('context_kind').$type<'place' | 'plan'>(),
    contextId: uuid('context_id'),
    messageCount: integer('message_count').notNull().default(0),
    preview: text('preview'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assistant_conversations_user_recent_idx').on(t.userId, t.lastMessageAt, t.id),
    index('assistant_conversations_retention_idx').on(t.lastMessageAt),
    check(
      'assistant_conversations_context_ck',
      sql`(${t.contextKind} is null and ${t.contextId} is null) or (${t.contextKind} in ('place', 'plan') and ${t.contextId} is not null)`,
    ),
  ],
);

export type AssistantMessageStatusDb =
  'streaming' | 'complete' | 'stopped' | 'fallback' | 'failed' | 'truncated';

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    status: text('status').$type<AssistantMessageStatusDb>().notNull(),
    text: text('text').notNull().default(''),
    locale: text('locale').$type<'vi' | 'en'>(),
    contextKind: text('context_kind').$type<'place' | 'plan'>(),
    contextId: uuid('context_id'),
    /** `[{kind:'place',placeId}|{kind:'plan',planId,roomId}]` — ids only. */
    cards: jsonb('cards')
      .notNull()
      .default(sql`'[]'::jsonb`),
    followUps: jsonb('follow_ups')
      .notNull()
      .default(sql`'[]'::jsonb`),
    notice: jsonb('notice'),
    error: jsonb('error'),
    /** SSE frames folded in at the terminal state, for exact replay. */
    frames: jsonb('frames'),
    /**
     * Operational facts of the turn: intent decision summary, fallback reason,
     * pinned guide versions, models, latencies. Never prompts or completions.
     */
    trace: jsonb('trace'),
    /** Generation lease: the API process running this turn. */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('assistant_messages_conversation_recent_idx').on(t.conversationId, t.createdAt, t.id),
    // One reply at a time per conversation, held by the database.
    uniqueIndex('assistant_messages_one_streaming_uq')
      .on(t.conversationId)
      .where(sql`${t.status} = 'streaming'`),
    index('assistant_messages_streaming_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'streaming'`),
    check('assistant_messages_role_ck', sql`${t.role} in ('user', 'assistant')`),
    check(
      'assistant_messages_status_ck',
      sql`${t.status} in ('streaming', 'complete', 'stopped', 'fallback', 'failed', 'truncated')`,
    ),
  ],
);

/** Sources a reply cited. Titles come from the guide version, never the model. */
export const assistantMessageSources = pgTable(
  'assistant_message_sources',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => assistantMessages.id, { onDelete: 'cascade' }),
    index: integer('idx').notNull(),
    kind: text('kind').$type<'guide_document' | 'place_data'>().notNull(),
    documentId: uuid('document_id'),
    versionId: uuid('version_id'),
    slug: text('slug'),
    title: text('title').notNull(),
    description: text('description'),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.index] })],
);

export type AssistantProposalStatusDb =
  'pending' | 'confirming' | 'confirmed' | 'dismissed' | 'expired';

export const assistantProposals = pgTable(
  'assistant_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => assistantMessages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** `confirming` is internal (a confirm in flight); it reads as `pending`. */
    status: text('status').$type<AssistantProposalStatusDb>().notNull().default('pending'),
    values: jsonb('values').notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  },
  (t) => [
    index('assistant_proposals_message_idx').on(t.messageId),
    check(
      'assistant_proposals_status_ck',
      sql`${t.status} in ('pending', 'confirming', 'confirmed', 'dismissed', 'expired')`,
    ),
  ],
);

export const assistantFeedback = pgTable(
  'assistant_feedback',
  {
    messageId: uuid('message_id')
      .primaryKey()
      .references(() => assistantMessages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: text('rating').$type<'up' | 'down'>().notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assistant_feedback_queue_idx').on(t.createdAt, t.messageId),
    check('assistant_feedback_rating_ck', sql`${t.rating} in ('up', 'down')`),
  ],
);

/**
 * One row per accepted send: the daily / burst allowance and the environment
 * spend ceiling are read from here, so deleting a conversation neither refunds
 * the allowance nor hides spend. Costs are as reported by the provider; `null`
 * is unknown, never 0. Erasure nulls `user_id` (the money record stays,
 * without a person); rows are purged after 400 days.
 */
export const assistantUsageLedger = pgTable(
  'assistant_usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    messageId: uuid('message_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: text('status').notNull().default('accepted'),
    jevCalls: integer('jev_calls').notNull().default(0),
    jevModel: text('jev_model'),
    jevInputTokens: integer('jev_input_tokens'),
    jevOutputTokens: integer('jev_output_tokens'),
    /** OpenRouter direct inference, billed to OpenRouter credits. */
    jevCostUsd: numeric('jev_cost_usd', { precision: 14, scale: 8 }),
    haikuCalls: integer('haiku_calls').notNull().default(0),
    haikuModel: text('haiku_model'),
    haikuInputTokens: integer('haiku_input_tokens'),
    haikuOutputTokens: integer('haiku_output_tokens'),
    /** Anthropic BYOK upstream inference cost as OpenRouter reports it — Anthropic's bill. */
    haikuUpstreamCostUsd: numeric('haiku_upstream_cost_usd', { precision: 14, scale: 8 }),
    /** What OpenRouter itself charged for the Haiku call (BYOK fee); 0 within the allowance. */
    haikuOpenrouterCostUsd: numeric('haiku_openrouter_cost_usd', { precision: 14, scale: 8 }),
    /** `false` = OpenRouter did NOT route through the Anthropic BYOK key. */
    haikuIsByok: boolean('haiku_is_byok'),
  },
  (t) => [
    index('assistant_usage_ledger_user_idx').on(t.userId, t.acceptedAt),
    index('assistant_usage_ledger_accepted_idx').on(t.acceptedAt),
  ],
);

/** CMS "GoGo guide" source documents (GoGo-CMS#249). */
export const assistantDocuments = pgTable(
  'assistant_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    locale: text('locale').$type<'vi' | 'en'>().notNull(),
    status: text('status').$type<'draft' | 'published' | 'unpublished'>().notNull(),
    publishedVersionId: uuid('published_version_id'),
    draftVersionId: uuid('draft_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('assistant_documents_slug_locale_uq').on(t.slug, t.locale),
    index('assistant_documents_updated_idx').on(t.updatedAt, t.id),
  ],
);

export type AssistantDocumentVersionState =
  'draft' | 'published' | 'superseded' | 'withdrawn' | 'discarded';

/**
 * Append-only history: a published version is immutable, so what the assistant
 * cited can always be read back. `search_vector` (migration-only, generated
 * from `search_text`) backs retrieval over published versions.
 */
export const assistantDocumentVersions = pgTable(
  'assistant_document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => assistantDocuments.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    state: text('state').$type<AssistantDocumentVersionState>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull(),
    bodySha256: text('body_sha256').notNull(),
    revision: integer('revision').notNull().default(1),
    /** Diacritic-folded title + description + body, written by the app. */
    searchText: text('search_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    publishReason: text('publish_reason'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: uuid('withdrawn_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    withdrawReason: text('withdraw_reason'),
  },
  (t) => [
    uniqueIndex('assistant_document_versions_number_uq').on(t.documentId, t.number),
    index('assistant_document_versions_doc_idx').on(t.documentId, t.number),
  ],
);

/**
 * GoGo-BE#717 A-R-08 — messages an erasure deleted whose live frame buffer
 * (Redis, up to an hour) must still be dropped. Drained by the assistant
 * reaper on every API instance. Ids only.
 */
export const assistantBufferPurges = pgTable('assistant_buffer_purges', {
  messageId: uuid('message_id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
