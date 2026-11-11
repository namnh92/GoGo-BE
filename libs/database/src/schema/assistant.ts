import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  date,
  check,
  index,
  foreignKey,
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
import { outboxEvents } from './platform';

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
    allowanceSource: text('allowance_source').notNull().default('daily'),
    billingPolicy: text('billing_policy'),
    billingEpoch: bigint('billing_epoch', { mode: 'bigint' }),
    costRevision: bigint('cost_revision', { mode: 'bigint' }).notNull().default(0n),
    dispatchClosedAt: timestamp('dispatch_closed_at', { withTimezone: true }),
    costFinalizedAt: timestamp('cost_finalized_at', { withTimezone: true }),
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
    check('assistant_usage_ledger_cost_revision_check', sql`${t.costRevision}>=0`),
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

/** #774: no expiry. Source ids intentionally survive source deletion and usage retention. */
export const assistantCreditAccounts = pgTable(
  'assistant_credit_accounts',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: integer('balance').notNull().default(0),
  },
  (t) => [check('assistant_credit_accounts_balance_check', sql`${t.balance} >= 0`)],
);

export const creditEvents = pgTable(
  'credit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    labels: jsonb('labels').notNull(),
    triggerEventType: text('trigger_event_type').notNull(),
    triggerSchemaVersion: integer('trigger_schema_version').notNull(),
    condition: jsonb('condition').notNull(),
    conditionVersion: integer('condition_version').notNull().default(1),
    audience: text('audience').$type<'individual' | 'group'>().notNull(),
    dedupScope: text('dedup_scope').notNull(),
    amount: integer('amount').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true })
      .notNull()
      .default(sql`'-infinity'`),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    status: text('status').$type<'draft' | 'active' | 'closed'>().notNull().default('draft'),
    closedReason: text('closed_reason'),
    maxPerUser: integer('max_per_user'),
    maxPerGroup: integer('max_per_group'),
    budgetTotal: integer('budget_total'),
    budgetUsed: integer('budget_used').notNull().default(0),
    createdByAdminId: uuid('created_by_admin_id'),
    closedByAdminId: uuid('closed_by_admin_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'credit_events_billing_keys_check',
      sql`key not in ('message_spent','assistant_usage','assistant_usage_adjustment')`,
    ),
    uniqueIndex('credit_events_key_key').on(t.key),
    uniqueIndex('credit_events_id_key_key').on(t.id, t.key),
  ],
);

export const assistantCreditLedger = pgTable(
  'assistant_credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    delta: integer('delta').notNull(),
    costRevision: bigint('cost_revision', { mode: 'bigint' }),
    reason: text('reason').notNull(),
    submissionId: uuid('submission_id'),
    venueIdentity: text('venue_identity'),
    usageLedgerId: uuid('usage_ledger_id'),
    creditEventId: uuid('credit_event_id'),
    entitlementKey: text('entitlement_key'),
    groupGrantId: uuid('group_grant_id'),
    groupSourceKey: text('group_source_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('assistant_credit_submission_unique')
      .on(t.submissionId)
      .where(sql`${t.reason} = 'submission_approved'`),
    uniqueIndex('assistant_credit_venue_unique')
      .on(t.venueIdentity)
      .where(sql`${t.reason} = 'submission_approved'`),
    uniqueIndex('assistant_credit_spend_unique')
      .on(t.usageLedgerId)
      .where(sql`${t.reason} = 'message_spent'`),
    uniqueIndex('assistant_credit_usage_revision_unique')
      .on(t.usageLedgerId, t.costRevision)
      .where(sql`${t.usageLedgerId} is not null and ${t.costRevision} is not null`),
    index('assistant_credit_user_history').on(t.userId, t.createdAt, t.id),
    index('assistant_credit_event_user').on(t.creditEventId, t.userId),
    index('assistant_credit_event_group').on(t.creditEventId, t.groupSourceKey, t.groupGrantId),
    index('assistant_credit_legacy_pending')
      .on(t.id)
      .where(sql`${t.reason}='submission_approved' and ${t.creditEventId} is null`),
    foreignKey({
      name: 'assistant_credit_event_reason_fk',
      columns: [t.creditEventId, t.reason],
      foreignColumns: [creditEvents.id, creditEvents.key],
    }),
    check(
      'assistant_credit_ledger_check',
      sql.raw(
        "\n (reason='submission_approved' AND delta IN (20,50,70) AND submission_id IS NOT NULL\n  AND venue_identity IS NOT NULL AND usage_ledger_id IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL AND cost_revision IS NULL\n  AND ((credit_event_id IS NULL AND entitlement_key IS NULL)\n    OR (credit_event_id='82900000-0000-4000-8000-000000000001' AND entitlement_key IS NOT NULL)))\n OR (reason='message_spent' AND delta<0 AND usage_ledger_id IS NOT NULL AND (cost_revision IS NULL OR cost_revision>0)\n  AND submission_id IS NULL AND venue_identity IS NULL AND credit_event_id IS NULL\n  AND entitlement_key IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL)\n OR (reason='assistant_usage_adjustment' AND delta<>0 AND usage_ledger_id IS NOT NULL AND cost_revision>0 AND cost_revision IS NOT NULL\n  AND submission_id IS NULL AND venue_identity IS NULL AND credit_event_id IS NULL\n  AND entitlement_key IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL)\n OR (reason NOT IN ('message_spent','assistant_usage','assistant_usage_adjustment') AND credit_event_id IS NOT NULL AND entitlement_key IS NOT NULL\n  AND delta>0 AND usage_ledger_id IS NULL AND cost_revision IS NULL)\n",
      ),
    ),
  ],
);

/** #829 S1: DB ownership is independent of the evaluator pause flag. */
export const creditCutover = pgTable(
  'credit_cutover',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    mode: text('mode').$type<'sync' | 'evaluator'>().notNull().default('sync'),
    epoch: integer('epoch').notNull().default(0),
    firstActivatedAt: timestamp('first_activated_at', { withTimezone: true }),
  },
  (t) => [
    check('credit_cutover_singleton_check', sql`${t.singleton}`),
    check('credit_cutover_mode_check', sql`${t.mode} in ('sync', 'evaluator')`),
    check('credit_cutover_epoch_check', sql`${t.epoch} >= 0`),
    check(
      'credit_cutover_activation',
      sql`(${t.epoch} = 0 and ${t.firstActivatedAt} is null and ${t.mode} = 'sync') or (${t.epoch} > 0 and ${t.firstActivatedAt} is not null)`,
    ),
  ],
);

export const creditEntitlements = pgTable(
  'credit_entitlements',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => creditEvents.id),
    key: text('key').notNull(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => assistantCreditLedger.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_entitlements_event_key_unique').on(t.eventId, t.key),
    index('credit_entitlements_ledger').on(t.ledgerId),
  ],
);
export const creditEvaluations = pgTable(
  'credit_evaluations',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => outboxEvents.id, { onDelete: 'cascade' }),
    status: text('status').$type<'evaluated' | 'quarantined'>().notNull(),
    reason: text('reason'),
    grants: integer('grants').notNull().default(0),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credit_evaluations_event_unique').on(t.eventId)],
);

export const assistantCreditSpendControl = pgTable(
  'assistant_credit_spend_control',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    policyKey: text('policy_key').notNull().default('legacy_allowance_v1'),
    epoch: bigint('epoch', { mode: 'bigint' }).notNull().default(0n),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    boundVersion: text('bound_version'),
  },
  () => [
    check('assistant_credit_spend_control_singleton_check', sql.raw('singleton')),
    check(
      'assistant_credit_spend_control_policy_key_check',
      sql.raw("policy_key IN ('legacy_allowance_v1','free_then_actual_cost_v1')"),
    ),
    check('assistant_credit_spend_control_epoch_check', sql.raw('epoch>=0')),
    check(
      'assistant_credit_spend_control_check',
      sql.raw(
        "(policy_key='legacy_allowance_v1' AND epoch=0 AND activated_at IS NULL AND bound_version IS NULL)\n  OR (policy_key='free_then_actual_cost_v1' AND epoch>0 AND activated_at IS NOT NULL)",
      ),
    ),
  ],
);

export const assistantCreditTurns = pgTable(
  'assistant_credit_turns',
  {
    usageLedgerId: uuid('usage_ledger_id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    messageId: uuid('message_id'),
    conversationId: uuid('conversation_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    freeDay: date('free_day'),
    policyKey: text('policy_key').notNull(),
    policyEpoch: bigint('policy_epoch', { mode: 'bigint' }).notNull(),
    fundingSource: text('funding_source').notNull(),
    reservedCeiling: integer('reserved_ceiling').notNull(),
    heldCredits: integer('held_credits').notNull(),
    appliedCredits: integer('applied_credits').notNull(),
    boundVersion: text('bound_version'),
    costRevision: bigint('cost_revision', { mode: 'bigint' }).notNull().default(0n),
    appliedCostRevision: bigint('applied_cost_revision', { mode: 'bigint' }).notNull().default(0n),
    state: text('state').notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    nextReconcileAt: timestamp('next_reconcile_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    retryCount: integer('retry_count').notNull().default(0),
    recoveryAttempts: integer('recovery_attempts').notNull().default(0),
    recoveryNextAt: timestamp('recovery_next_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'assistant_credit_turns_policy_key_check',
      sql.raw("policy_key IN ('legacy_allowance_v1','free_then_actual_cost_v1')"),
    ),
    check(
      'assistant_credit_turns_recovery_attempts_check',
      sql.raw('recovery_attempts BETWEEN 0 AND 5'),
    ),
    check('assistant_credit_turns_policy_epoch_check', sql.raw('policy_epoch>=0')),
    check(
      'assistant_credit_turns_funding_source_check',
      sql.raw("funding_source IN ('free','credit')"),
    ),
    check('assistant_credit_turns_reserved_ceiling_check', sql.raw('reserved_ceiling>=0')),
    check('assistant_credit_turns_held_credits_check', sql.raw('held_credits>=0')),
    check('assistant_credit_turns_applied_credits_check', sql.raw('applied_credits>=0')),
    check('assistant_credit_turns_cost_revision_check', sql.raw('cost_revision>=0')),
    check(
      'assistant_credit_turns_applied_cost_revision_check',
      sql.raw('applied_cost_revision>=0 AND applied_cost_revision<=cost_revision'),
    ),
    check(
      'assistant_credit_turns_state_values_check',
      sql.raw("state IN ('pending','reconciling','settled','quarantined','erased')"),
    ),
    check('assistant_credit_turns_retry_count_check', sql.raw('retry_count>=0')),
    check(
      'assistant_credit_turns_funding_check',
      sql.raw(
        "\n  (funding_source='free' AND free_day IS NOT NULL AND reserved_ceiling=0 AND held_credits=0 AND applied_credits=0 AND bound_version IS NULL)\n  OR (funding_source='credit' AND free_day IS NULL AND reserved_ceiling>=1 AND bound_version IS NOT NULL AND applied_credits<=reserved_ceiling)",
      ),
    ),
    check(
      'assistant_credit_turns_state_check',
      sql.raw(
        "\n  (state='erased' AND user_id IS NULL AND message_id IS NULL AND conversation_id IS NULL AND held_credits=0)\n  OR (funding_source='free' AND state='settled' AND finalized_at IS NOT NULL)\n  OR (funding_source='credit' AND (\n   (state IN ('pending','reconciling','quarantined') AND finalized_at IS NULL AND applied_credits::bigint+held_credits=reserved_ceiling)\n   OR (state IN ('settled','quarantined') AND finalized_at IS NOT NULL AND held_credits=0)))",
      ),
    ),
    index('assistant_credit_turns_held')
      .on(t.userId)
      .where(sql`${t.heldCredits}>0`),
    index('assistant_credit_turns_reconcile').on(t.state, t.nextReconcileAt),
    index('assistant_credit_turns_conversation').on(
      t.userId,
      t.conversationId,
      t.acceptedAt,
      t.usageLedgerId,
    ),
  ],
);

export const assistantUsageCalls = pgTable(
  'assistant_usage_calls',
  {
    usageLedgerId: uuid('usage_ledger_id').notNull(),
    callIndex: integer('call_index').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dispatchState: text('dispatch_state').notNull().default('intent'),
    correlationId: uuid('correlation_id'),
    providerRequestId: text('provider_request_id'),
    providerGenerationId: text('provider_generation_id'),
    directCostUsd: numeric('direct_cost_usd'),
    upstreamCostUsd: numeric('upstream_cost_usd'),
    feeCostUsd: numeric('fee_cost_usd'),
    receiptFingerprint: text('receipt_fingerprint'),
    receiptRevision: bigint('receipt_revision', { mode: 'bigint' }),
    costState: text('cost_state').notNull().default('unknown'),
    finalityPolicy: text('finality_policy'),
    billableCostUsd: numeric('billable_cost_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'assistant_usage_calls_billable_cost_usd_check',
      sql.raw("billable_cost_usd>=0 AND billable_cost_usd<'Infinity'::numeric"),
    ),
    check('assistant_usage_calls_call_index_check', sql.raw('call_index>=0')),
    check(
      'assistant_usage_calls_dispatch_state_check',
      sql.raw("dispatch_state IN ('intent','dispatched','ambiguous','closed')"),
    ),
    check(
      'assistant_usage_calls_direct_cost_usd_check',
      sql.raw("direct_cost_usd>=0 AND direct_cost_usd<'Infinity'::numeric"),
    ),
    check(
      'assistant_usage_calls_upstream_cost_usd_check',
      sql.raw("upstream_cost_usd>=0 AND upstream_cost_usd<'Infinity'::numeric"),
    ),
    check(
      'assistant_usage_calls_fee_cost_usd_check',
      sql.raw("fee_cost_usd>=0 AND fee_cost_usd<'Infinity'::numeric"),
    ),
    check('assistant_usage_calls_receipt_revision_check', sql.raw('receipt_revision>0')),
    check(
      'assistant_usage_calls_cost_state_check',
      sql.raw("cost_state IN ('unknown','complete','final','quarantined')"),
    ),
    primaryKey({ columns: [t.usageLedgerId, t.callIndex] }),
    uniqueIndex('assistant_usage_calls_receipt_unique')
      .on(t.provider, t.usageLedgerId, t.callIndex, t.receiptFingerprint)
      .where(sql`${t.receiptFingerprint} is not null`),
  ],
);

export const assistantUsageReceipts = pgTable(
  'assistant_usage_receipts',
  {
    usageLedgerId: uuid('usage_ledger_id').notNull(),
    callIndex: integer('call_index').notNull(),
    receiptRevision: bigint('receipt_revision', { mode: 'bigint' }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    directCostUsd: numeric('direct_cost_usd').notNull(),
    upstreamCostUsd: numeric('upstream_cost_usd').notNull(),
    feeCostUsd: numeric('fee_cost_usd').notNull(),
    final: boolean('final').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.usageLedgerId, t.callIndex, t.fingerprint] }),
    check('assistant_usage_receipts_call_index_check', sql.raw('call_index>=0')),
    check(
      'assistant_usage_receipts_direct_cost_usd_check',
      sql.raw("direct_cost_usd>=0 AND direct_cost_usd<'Infinity'::numeric"),
    ),
    check(
      'assistant_usage_receipts_upstream_cost_usd_check',
      sql.raw("upstream_cost_usd>=0 AND upstream_cost_usd<'Infinity'::numeric"),
    ),
    check(
      'assistant_usage_receipts_fee_cost_usd_check',
      sql.raw("fee_cost_usd>=0 AND fee_cost_usd<'Infinity'::numeric"),
    ),
    check('assistant_usage_receipts_receipt_revision_check', sql.raw('receipt_revision>0')),
  ],
);
export const assistantCreditBoundArtifacts = pgTable(
  'assistant_credit_bound_artifacts',
  {
    version: text('version').primaryKey(),
    environment: text('environment').notNull(),
    boundUsd: numeric('bound_usd').notNull(),
    description: jsonb('description').notNull(),
    validatedAt: timestamp('validated_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  () => [
    check(
      'assistant_credit_bound_artifacts_environment_check',
      sql.raw("environment IN ('dev','staging','production')"),
    ),
    check(
      'assistant_credit_bound_artifacts_bound_usd_check',
      sql.raw("bound_usd>0 AND bound_usd<'Infinity'::numeric"),
    ),
    check('assistant_credit_bound_artifacts_check', sql.raw('expires_at>validated_at')),
  ],
);

export const assistantCreditBillingIncidents = pgTable(
  'assistant_credit_billing_incidents',
  {
    usageLedgerId: uuid('usage_ledger_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.usageLedgerId, t.reason] }),
    check(
      'assistant_credit_billing_incidents_reason_check',
      sql.raw(
        "reason IN ('invalid_cost','receipt_conflict','bound_or_finality','account_invariant','receipt_missing')",
      ),
    ),
  ],
);
