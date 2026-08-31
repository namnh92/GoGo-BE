import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { places } from './places';
import { users } from './identity';

/**
 * DB-008 — CMS RBAC/audit/config/collection schema.
 * audit_logs is append-only at the application layer: no update/delete path
 * exists in any repository, and CMS exposes read-only access (FR-CMS-008).
 */

export const adminRole = pgEnum('admin_role', ['editor', 'moderator', 'ops_admin', 'super_admin']);
export const adminStatus = pgEnum('admin_status', ['active', 'suspended']);

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    // Password auth only outside production; production requires SSO/MFA.
    passwordHash: text('password_hash'),
    ssoSubject: text('sso_subject'),
    /** Encrypted at rest: a database dump must not hand over the second factor. */
    mfaTotpSecretEnc: text('mfa_totp_secret_enc'),
    /** Enrolled but unproven; promoted only after a code from it verifies. */
    mfaTotpPendingEnc: text('mfa_totp_pending_enc'),
    /**
     * Highest TOTP step already consumed. Without it a code stays usable for
     * the whole of its 30-second window and an intercepted one can be
     * replayed inside it.
     */
    mfaTotpLastStep: bigint('mfa_totp_last_step', { mode: 'number' }),
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    /**
     * #248 — set when a `super_admin` issues a temporary password. A temporary
     * credential that is never replaced is worse than the lockout it fixed:
     * two people know it and only one is named in the audit trail. NULL means
     * nothing is owed; the guard refuses every other CMS route until it is.
     */
    mustChangePasswordAt: timestamp('must_change_password_at', { withTimezone: true }),
    displayName: text('display_name').notNull(),
    role: adminRole('role').notNull(),
    status: adminStatus('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_users_email_unique').on(t.email)],
);

/**
 * SEC-003 — one row per admin login.
 *
 * Separate from `auth_sessions` because that table references `users.id` and
 * admins live in `admin_users`; the model is otherwise the same as ADR-0003:
 * opaque refresh token stored only as a digest, single-use rotation, and reuse
 * of a superseded token revoking the whole family as a theft response.
 *
 * Before this existed the access token's `sid` was the admin id itself, so
 * there was nothing to log out of, nothing to revoke per device, and no way to
 * answer "where is this account signed in" — the question a compromised staff
 * account makes urgent.
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    rotatedFromId: uuid('rotated_from_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('admin_sessions_refresh_unique').on(t.refreshTokenHash),
    index('admin_sessions_admin_idx').on(t.adminId, t.createdAt),
    index('admin_sessions_family_idx').on(t.familyId),
  ],
);

export const auditActorType = pgEnum('audit_actor_type', ['admin', 'user', 'system']);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    // Before/after diff of the sensitive write; PII minimized at write time.
    diff: jsonb('diff'),
    requestId: text('request_id'),
    /**
     * Staff IP for admin actions only. It is PII, so user/guest actions never
     * populate it: the justification is staff accountability — telling "that
     * admin did it" apart from "that admin's account was taken over".
     */
    ipAddress: text('ip_address'),
    /**
     * SEC-002 — which rule authorized this write: `exact_role`, `rank_read`, or
     * `super_admin_bypass`. Only the last one means the request would have been
     * refused for any other role, and counting those answers whether the role
     * model matches the work rather than being routed around.
     */
    authorizationPath: text('authorization_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId, t.createdAt),
    index('audit_logs_actor_idx').on(t.actorType, t.actorId, t.createdAt),
  ],
);

export const rankingConfigStatus = pgEnum('ranking_config_status', [
  'draft',
  'approved',
  'active',
  'rolled_back',
]);

/** FR-CMS-007 — versioned ranking/scoring weights with approval + rollback. */
export const rankingConfigs = pgTable(
  'ranking_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    weights: jsonb('weights').$type<Record<string, number>>().notNull(),
    // Allowed min/max per weight — engine rejects configs outside bounds.
    bounds: jsonb('bounds').$type<Record<string, { min: number; max: number }>>().notNull(),
    status: rankingConfigStatus('status').notNull().default('draft'),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    approvedByAdminId: uuid('approved_by_admin_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ranking_configs_key_version_unique').on(t.key, t.version),
    uniqueIndex('ranking_configs_key_active_unique')
      .on(t.key)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const featureFlagEnvironment = pgEnum('feature_flag_environment', [
  'all',
  'dev',
  'staging',
  'production',
]);
export const featureFlagPlatform = pgEnum('feature_flag_platform', [
  'all',
  'ios',
  'android',
  'web',
]);

/**
 * BE-CMS-G3 (#221) — application configuration, scoped.
 *
 * The value's type and its default live in code
 * (`libs/modules/shared/feature-flags.ts`), next to whatever reads the flag:
 * storing the type per row would let two rows for one key disagree, and the
 * reader has only one expectation. What is stored is what an operator sets —
 * which environment and which platform this row applies to. `(all, all)` is
 * the unscoped row every resolution falls back to.
 *
 * `enabled` is the boolean flag's value, unchanged: it is the column the kill
 * switches read, and an incident is the wrong time to discover it moved.
 * `payload` carries the typed value for every other kind.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    key: text('key').notNull(),
    environment: featureFlagEnvironment('environment').notNull().default('all'),
    platform: featureFlagPlatform('platform').notNull().default('all'),
    enabled: boolean('enabled').notNull().default(false),
    payload: jsonb('payload'),
    description: text('description'),
    updatedByAdminId: uuid('updated_by_admin_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.environment, t.platform] }),
    index('feature_flags_key_idx').on(t.key),
  ],
);

export const collectionStatus = pgEnum('collection_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);

export const collectionKind = pgEnum('collection_kind', ['collection', 'recommendation']);
/** Shared by every kind of editorial content; see `shared/audience.ts`. */
export const contentAudience = pgEnum('content_audience', ['couple', 'group', 'family', 'solo']);

/**
 * Editorial lists of places — curated collections and, per ADR-0009, the
 * targeted ones the console calls recommendations.
 *
 * One table because a recommendation *is* a collection that knows who it is
 * for: same ordered items, same schedule, same status machine. Splitting them
 * would fork editorial content across two stores that every later feature —
 * scheduling, a place-removal cascade, "which lists contain this place" —
 * would have to keep in agreement.
 */
export const contentCollections = pgTable(
  'content_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: collectionKind('kind').notNull().default('collection'),
    slug: text('slug').notNull(),
    locale: text('locale').notNull().default('vi'),
    title: text('title').notNull(),
    /** The editorial name. Never what a user reads; what an editor searches. */
    internalName: text('internal_name'),
    subtitle: text('subtitle'),
    description: text('description'),
    audience: contentAudience('audience'),
    /** Same vocabulary as `places.area_key`, so "city" is one concept. */
    areaKey: text('area_key'),
    /** Higher first, between recommendations competing for one surface. */
    priority: integer('priority').notNull().default(0),
    status: collectionStatus('status').notNull().default('draft'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('content_collections_slug_locale_unique').on(t.slug, t.locale),
    index('content_collections_kind_idx').on(t.kind, t.priority, t.createdAt, t.id),
  ],
);

/** Categories and vibes as stable taxonomy keys, never display labels. */
export const contentCollectionTaxonomies = pgTable(
  'content_collection_taxonomies',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => contentCollections.id, { onDelete: 'cascade' }),
    taxonomyId: uuid('taxonomy_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.taxonomyId] }),
    index('content_collection_taxonomies_taxonomy_idx').on(t.taxonomyId),
  ],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => contentCollections.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('collection_items_unique').on(t.collectionId, t.placeId)],
);

/**
 * SG-010 (#49) — experiment definitions.
 *
 * The assignment is computed from a hash rather than stored, so a room always
 * lands in the same variant and a lost row cannot silently reassign it. What
 * lives here is the definition — which is what makes the kill switch possible
 * — while the variant each run used is recorded on the run itself.
 */
export const experiments = pgTable('experiments', {
  key: text('key').primaryKey(),
  description: text('description'),
  /** Disabling sends every subject to control on the next request. */
  enabled: boolean('enabled').notNull().default(false),
  /** Variant name -> relative weight. */
  variants: jsonb('variants').notNull().$type<Record<string, number>>(),
  createdByAdminId: uuid('created_by_admin_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ------------------------------------------------------------ trust & safety

export const safetyRuleType = pgEnum('safety_rule_type', [
  'spam',
  'abusive_content',
  'blocked_words',
  'review_abuse',
  'user_abuse',
  'repeated_reports',
  'rate_limit',
]);
export const safetyRuleTrigger = pgEnum('safety_rule_trigger', [
  'review_created',
  'review_updated',
  'report_created',
  'checkin_created',
  'place_submitted',
  'user_registered',
]);
export const safetyRuleAction = pgEnum('safety_rule_action', [
  'flag_for_review',
  'auto_hide',
  'require_moderation',
  'suspend_user',
  'block_action',
]);
export const safetyRuleSeverity = pgEnum('safety_rule_severity', [
  'low',
  'medium',
  'high',
  'critical',
]);
export const safetyRuleStatus = pgEnum('safety_rule_status', ['draft', 'active', 'disabled']);

/**
 * BE-CMS-G4d (#225) — Trust & Safety rule definitions.
 *
 * `conditions` is jsonb, but the shape it may hold is closed and enumerated per
 * rule type in `cms/domain/safety-rule-conditions.ts` and validated on every
 * write. There is no expression language here and nothing is evaluated as
 * code: a free-form condition DSL is how a console write turns into remote
 * code execution.
 */
export const safetyRules = pgTable(
  'safety_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    ruleType: safetyRuleType('rule_type').notNull(),
    trigger: safetyRuleTrigger('trigger').notNull(),
    conditions: jsonb('conditions').notNull().default({}),
    action: safetyRuleAction('action').notNull(),
    severity: safetyRuleSeverity('severity').notNull().default('medium'),
    status: safetyRuleStatus('status').notNull().default('draft'),
    /** Lower runs first, so two matching rules resolve the same way every time. */
    priority: integer('priority').notNull().default(100),
    /** Stamped on every decision the rule causes, so a person can trace it. */
    reasonCode: text('reason_code').notNull(),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('safety_rules_name_unique').on(t.name),
    index('safety_rules_active_idx').on(t.trigger, t.priority, t.id),
    index('safety_rules_list_idx').on(t.createdAt, t.id),
  ],
);

// ------------------------------------------------------------------ banners

export const bannerPlacement = pgEnum('banner_placement', ['home_hero', 'home_secondary']);
export const bannerStatus = pgEnum('banner_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);
export const bannerDestination = pgEnum('banner_destination', [
  'none',
  'place',
  'recommendation',
  'plan_template',
  'campaign',
  'external_url',
]);

/**
 * BE-CMS-G4c (#224) — banners.
 *
 * `expired` is not a stored status. It is a fact about the clock, and a stored
 * copy would be wrong for as long as it took a job to notice — or forever, if
 * none ran. What a person controls is stored; expiry is computed on read, by
 * the server, so no client has to derive it.
 */
export const banners = pgTable(
  'banners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The editorial name; `title` is what a user reads on the banner. */
    name: text('name').notNull(),
    /** Mandatory: a banner is an image. Bound to this row on save. */
    imageKey: text('image_key').notNull(),
    title: text('title'),
    subtitle: text('subtitle'),
    ctaLabel: text('cta_label'),
    destinationType: bannerDestination('destination_type').notNull().default('none'),
    destinationValue: text('destination_value'),
    audience: contentAudience('audience'),
    placement: bannerPlacement('placement').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** Higher first, between banners competing for one placement. */
    priority: integer('priority').notNull().default(0),
    status: bannerStatus('status').notNull().default('draft'),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('banners_name_unique').on(t.name),
    index('banners_live_idx').on(t.placement, t.priority, t.id),
    index('banners_list_idx').on(t.createdAt, t.id),
  ],
);

// ---------------------------------------------------------------------------
// BE-CMS-G12 (#255) — the privacy-request compliance ledger.
//
// The audit log answers "who did what"; this answers "what requests did we
// receive, where are they, what is the deadline, how did they end". Neither
// stands in for the other. Full rationale: migration 0030 and ADR-0011.

export const privacyRequestType = pgEnum('privacy_request_type', [
  'export',
  'delete',
  'correction',
]);
export const privacyRequestSource = pgEnum('privacy_request_source', [
  'self_service',
  'support',
  'cms',
]);
export const privacyRequestStatus = pgEnum('privacy_request_status', [
  'open',
  'acknowledged',
  'in_progress',
  'closed',
]);
export const privacyRequestOutcome = pgEnum('privacy_request_outcome', [
  'completed',
  'no_account_found',
  'identity_not_verified',
  'rejected',
  'failed',
]);
export const privacySubjectType = pgEnum('privacy_subject_type', ['user', 'email', 'external']);
export const privacyIdentityStatus = pgEnum('privacy_identity_status', [
  'matched',
  'no_account_found',
  'unverified',
]);
export const privacyDeliveryMethod = pgEnum('privacy_delivery_method', [
  'in_app',
  'secure_download',
  'other',
]);

export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: privacyRequestType('type').notNull(),
    source: privacyRequestSource('source').notNull(),
    status: privacyRequestStatus('status').notNull().default('open'),
    outcome: privacyRequestOutcome('outcome'),

    subjectType: privacySubjectType('subject_type').notNull(),
    /**
     * No cascade: after the account is erased this row may deliberately be
     * the last record that the person existed (ADR-0011 §4).
     */
    userId: uuid('user_id').references(() => users.id),
    contactEmail: text('contact_email'),
    externalReference: text('external_reference'),
    identityStatus: privacyIdentityStatus('identity_status').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    ackDueAt: timestamp('ack_due_at', { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    fulfillmentDueAt: timestamp('fulfillment_due_at', { withTimezone: true }).notNull(),
    extendedDueAt: timestamp('extended_due_at', { withTimezone: true }),
    extensionReason: text('extension_reason'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    executedByAdminId: uuid('executed_by_admin_id').references(() => adminUsers.id),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    deliveryMethod: privacyDeliveryMethod('delivery_method'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    retentionAt: timestamp('retention_at', { withTimezone: true }),
    retentionHoldAt: timestamp('retention_hold_at', { withTimezone: true }),
    retentionHoldBy: uuid('retention_hold_by').references(() => adminUsers.id),
    retentionHoldReason: text('retention_hold_reason'),
    legalBasis: text('legal_basis'),
    reviewAt: timestamp('review_at', { withTimezone: true }),
    holdUntil: timestamp('hold_until', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => adminUsers.id),

    reasonCode: text('reason_code'),
    ticketReference: text('ticket_reference'),
    /** Short by design: a ticket id and a sentence, not a conversation. */
    operatorNote: varchar('operator_note', { length: 256 }),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'privacy_requests_subject_shape',
      sql`(${t.subjectType} = 'user' and ${t.userId} is not null)
        or (${t.subjectType} = 'email' and ${t.contactEmail} is not null)
        or (${t.subjectType} = 'external' and ${t.externalReference} is not null)`,
    ),
    check(
      'privacy_requests_closed_has_outcome',
      sql`(${t.status} = 'closed') = (${t.outcome} is not null)`,
    ),
    index('privacy_requests_status_idx').on(t.status, t.fulfillmentDueAt),
    index('privacy_requests_user_idx')
      .on(t.userId)
      .where(sql`${t.userId} is not null`),
    index('privacy_requests_retention_idx')
      .on(t.retentionAt)
      .where(sql`${t.retentionAt} is not null and ${t.retentionHoldAt} is null`),
  ],
);

/**
 * Long-term reporting that survives the hard delete. Integer counters only —
 * nothing joins back to a person, which is what lets these rows live forever.
 */
export const privacyMetricsMonthly = pgTable('privacy_metrics_monthly', {
  month: text('month').primaryKey(),
  deleteReceived: integer('delete_received').notNull().default(0),
  deleteCompleted: integer('delete_completed').notNull().default(0),
  deleteFailed: integer('delete_failed').notNull().default(0),
  exportReceived: integer('export_received').notNull().default(0),
  exportCompleted: integer('export_completed').notNull().default(0),
  exportFailed: integer('export_failed').notNull().default(0),
  correctionReceived: integer('correction_received').notNull().default(0),
  slaBreached: integer('sla_breached').notNull().default(0),
  noAccountFound: integer('no_account_found').notNull().default(0),
});
