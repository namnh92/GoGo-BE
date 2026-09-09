import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { places } from './places';
import { administrativeMappingStatus } from './administrative';

/**
 * PI-BE-002 — place ingestion (GOGO_PLACE_INGESTION_SPEC §8).
 * Shared by CMS bulk import and Mobile add-by-link: same jobs/rows tables,
 * same provider-source linking, same duplicate rules.
 */

export const ingestSourceType = pgEnum('ingest_source_type', [
  'csv',
  'xlsx',
  'google_sheet',
  'mobile_link',
]);

export const ingestJobStatus = pgEnum('ingest_job_status', [
  'uploaded',
  'validating',
  'processing',
  'review_required',
  'completed',
  'partial_success',
  'failed',
  'cancelled',
  'paused_provider_quota',
]);

export const ingestJobMode = pgEnum('ingest_job_mode', [
  'dry_run',
  'create_drafts',
  'publish_approved',
  // Re-sync a sheet onto places that already exist: provider facts refresh from
  // Google, editorial fields come from the sheet (ADR-0006 §8).
  'update_existing',
]);

export const placeIngestJobs = pgTable(
  'place_ingest_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: ingestSourceType('source_type').notNull(),
    sourceFileName: text('source_file_name'),
    /** Hash of the file/sheet content — half of the idempotency key. */
    sourceChecksum: text('source_checksum'),
    status: ingestJobStatus('status').notNull().default('uploaded'),
    mode: ingestJobMode('mode').notNull().default('dry_run'),
    defaultCity: text('default_city'),
    /** Column mapping chosen in the wizard (raw header → canonical field). */
    mapping: jsonb('mapping').$type<Record<string, string>>(),
    /**
     * Header diagnostics from parse time, as `tabName:value`. Stored rather
     * than returned once: the wizard navigates to the job detail immediately
     * after creating, so anything living only on the create response is lost
     * before anyone can read it.
     */
    unmappedHeaders: jsonb('unmapped_headers').$type<string[]>().notNull().default([]),
    missingRequiredColumns: jsonb('missing_required_columns')
      .$type<string[]>()
      .notNull()
      .default([]),
    totalRows: integer('total_rows').notNull().default(0),
    processedRows: integer('processed_rows').notNull().default(0),
    successRows: integer('success_rows').notNull().default(0),
    warningRows: integer('warning_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    createdByAdminId: uuid('created_by_admin_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('place_ingest_jobs_status_idx').on(t.status, t.createdAt),
    // Re-uploading the same file in the same mode reuses the job instead of
    // duplicating work (FR-INGEST-008).
    uniqueIndex('place_ingest_jobs_checksum_unique')
      .on(t.sourceChecksum, t.mode)
      .where(sql`${t.sourceChecksum} is not null`),
  ],
);

export const ingestRowStatus = pgEnum('ingest_row_status', [
  'pending',
  'validation_failed',
  'resolving',
  'unresolved',
  'needs_confirmation',
  'duplicate',
  'ready',
  'imported',
  'failed',
]);

export type IngestMessage = { code: string; field?: string; message: string };

/**
 * A branch the resolver surfaced, for a moderator to choose between.
 *
 * No coordinates. They were stored here until #347 and never read back:
 * `confirmCandidate` uses `googlePlaceId` as an allowlist and then re-resolves
 * live, distance scoring runs on the provider response still in memory
 * (`MatchTarget`, which does carry them), and the CMS drawer renders none of
 * it. Google Maps Platform SST §14.3 caps Places coordinates at 30 consecutive
 * days, and the cheapest way to honour a retention limit on data nobody uses
 * is not to hold it — no expiry job can fail if the value never exists.
 */
export type MatchCandidate = {
  googlePlaceId: string;
  name: string;
  address: string;
  confidence: number;
};

/**
 * ADM-009 (#462) — why a row was, or was not, published.
 *
 * NULL means the row never asked to be. A new imported place has never been
 * verified by anybody, so its publication is deferred rather than performed,
 * and a result that called those rows "published" would be lying to whoever
 * ran the import.
 */
export const ingestPublicationOutcome = pgEnum('ingest_publication_outcome', [
  'published',
  'deferred_mapping_unverified',
  'deferred_mapping_invalid',
  'deferred_no_active_dataset',
]);

export const placeIngestRows = pgTable(
  'place_ingest_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** ADM-009: set only on rows whose mode asked for publication. */
    publicationOutcome: ingestPublicationOutcome('publication_outcome'),
    jobId: uuid('job_id')
      .notNull()
      .references(() => placeIngestJobs.id, { onDelete: 'cascade' }),
    sourceRowId: text('source_row_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    rawInput: jsonb('raw_input').notNull(),
    normalizedInput: jsonb('normalized_input'),
    resolvedGooglePlaceId: text('resolved_google_place_id'),
    matchedPlaceId: uuid('matched_place_id').references(() => places.id, {
      onDelete: 'set null',
    }),
    matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
    matchReasons: jsonb('match_reasons').$type<string[]>().notNull().default([]),
    candidates: jsonb('candidates').$type<MatchCandidate[]>().notNull().default([]),
    status: ingestRowStatus('status').notNull().default('pending'),
    /**
     * ADM-017 — what this row would be mapped to, computed from the geometry
     * the provider returned and stored so the review screen can show it.
     *
     * A preview, not a decision: nothing here has been verified by anybody, and
     * the commit re-resolves against the geometry it actually writes. Null is
     * the ordinary state — a row that has not resolved yet has no point to
     * classify. The dataset version travels with the codes because a code is
     * not an identity across releases.
     */
    administrativeProvinceCode: text('administrative_province_code'),
    administrativeCommuneCode: text('administrative_commune_code'),
    administrativeMappingStatus: administrativeMappingStatus('administrative_mapping_status'),
    administrativeDatasetVersion: text('administrative_dataset_version'),
    errors: jsonb('errors').$type<IngestMessage[]>().notNull().default([]),
    warnings: jsonb('warnings').$type<IngestMessage[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency anchor: a retried chunk updates rows, never duplicates them.
    uniqueIndex('place_ingest_rows_job_source_unique').on(t.jobId, t.sourceRowId),
    index('place_ingest_rows_status_idx').on(t.jobId, t.status),
    // ADM-017 — "how many rows in this job need a person" is the count an
    // operator asks for first.
    index('place_ingest_rows_administrative_status_idx')
      .on(t.jobId, t.administrativeMappingStatus)
      .where(sql`${t.administrativeMappingStatus} is not null`),
    check(
      'place_ingest_rows_confidence_range',
      sql`${t.matchConfidence} is null or (${t.matchConfidence} >= 0 and ${t.matchConfidence} <= 1)`,
    ),
  ],
);

export const providerSourceStatus = pgEnum('provider_source_status', [
  'active',
  'moved',
  // Business is shut for now and expected back — a provider fact, kept apart
  // from `places.status`, which records what GoGo decided about the place.
  'temporarily_closed',
  'closed',
  'unknown',
]);

/**
 * Provider snapshot per canonical place: raw aggregates stay separate from the
 * derived score (ADR-0006 §5) and every row carries freshness + attribution.
 */
export const placeProviderSources = pgTable(
  'place_provider_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('google_places'),
    externalId: text('external_id').notNull(),
    providerUri: text('provider_uri'),
    rating: numeric('rating', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count'),
    /** Bayesian-shrunk 0..100 score; never overwrites the raw aggregates. */
    derivedScore: numeric('derived_score', { precision: 5, scale: 2 }),
    priceLevel: integer('price_level'),
    /** Provider's primary category at fetch time — the identity-change signal. */
    primaryType: text('primary_type'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    refreshAfter: timestamp('refresh_after', { withTimezone: true }),
    attribution: jsonb('attribution').$type<Record<string, unknown>>().notNull().default({}),
    sourceStatus: providerSourceStatus('source_status').notNull().default('active'),
    /** Field tier the snapshot was fetched at (core | quality | detail). */
    fetchTier: text('fetch_tier').notNull().default('core'),
    /**
     * PR7 (#340) — what the liveness refresh needs to run and to stop.
     *
     * `refreshAfter` above says *when*; these say *in what order*, *how many
     * times it has failed*, *when it was last asked* and *where the provider
     * says the place went*. `movedToExternalId` is a Place ID, the one Google
     * value SST §3 permits storing indefinitely — a liveness answer carries
     * nothing else, which is why refresh can add no other provider content.
     */
    refreshPriority: smallint('refresh_priority').notNull().default(0),
    refreshAttempts: smallint('refresh_attempts').notNull().default(0),
    transientFailures: smallint('transient_failures').notNull().default(0),
    lastRefreshAttemptAt: timestamp('last_refresh_attempt_at', { withTimezone: true }),
    lastRefreshErrorCode: text('last_refresh_error_code'),
    movedToExternalId: text('moved_to_external_id'),
  },
  (t) => [
    uniqueIndex('place_provider_sources_provider_external_unique').on(t.provider, t.externalId),
    index('place_provider_sources_place_idx').on(t.placeId),
    // Partial and composite, matching the due query's ORDER BY exactly. Dormant
    // and moved rows carry `refresh_after IS NULL` and are excluded, so a
    // growing set of rows the job will never ask about does not grow the index
    // it reads every tick (#340).
    index('place_provider_sources_refresh_due_idx')
      .on(t.refreshPriority.desc(), t.refreshAfter.asc())
      .where(sql`${t.refreshAfter} is not null`),
  ],
);

/**
 * PR1 (#334) — the same Google Place ID pointing at two different GoGo places.
 *
 * The provenance unification copies `place_sources(provider='google')` into
 * this module's canonical table. Where an external ID is already taken by a
 * different place, neither row is a safe one to overwrite: one of them is a
 * duplicate place, and which one is canonical is an editorial decision about
 * catalogue content, not something a backfill can infer. Both are kept and
 * the pair is queued here, the same way `PlaceDedupService` returns
 * `MERGE_CANDIDATE` rather than merging on its own.
 *
 * This is a review queue, not a third identity table: nothing resolves a
 * Google Place ID through it, and it holds no provider content beyond the ID
 * itself (ADR-0006 §9.3, "allowed, indefinite").
 */
export const placeIdentityConflicts = pgTable(
  'place_identity_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    /** The place the canonical table already links this external ID to. */
    canonicalPlaceId: uuid('canonical_place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** The place the legacy row links it to. Never silently discarded. */
    legacyPlaceId: uuid('legacy_place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
  },
  (t) => [
    uniqueIndex('place_identity_conflicts_unique').on(t.provider, t.externalId, t.legacyPlaceId),
    index('place_identity_conflicts_open_idx').on(t.detectedAt),
  ],
);

export const submissionStatus = pgEnum('place_submission_status', [
  'pending',
  'approved',
  'rejected',
  'merged',
]);

/** Mobile add-by-link proposals (FR-INGEST-010..012). */
/**
 * PI-BE-031 (#528) — the GoGo-owned fields a reviewer may supplement before
 * approving a contribution.
 *
 * Deliberately the Place editor's own vocabulary and nothing beyond it: this
 * is the same edit, made a step earlier, so a field that is not writable on a
 * Place is not writable here either. Provider facts (rating, review count,
 * opening hours) are absent by construction — they are the provider's and are
 * never typed by a person.
 *
 * `undefined`/absent means "the reviewer said nothing about this field", which
 * is different from `null` ("clear it"). Approval reads it that way.
 */
export type SubmissionReviewDraft = {
  name?: string | undefined;
  description?: string | null | undefined;
  addressText?: string | null | undefined;
  phone?: string | null | undefined;
  website?: string | null | undefined;
  avgVisitMinutes?: number | null | undefined;
  /** Audience fit, the same 0..1 record the place row carries. */
  suitability?: Record<string, number> | undefined;
  /** Category, moods and every other taxonomy chip, as ids. */
  taxonomyIds?: string[] | undefined;
  isLodging?: boolean | undefined;
  curatedRank?: number | null | undefined;
  /** Editorial price, in integer minor units — replaces nothing the user sent. */
  priceMin?: number | null | undefined;
  priceMax?: number | null | undefined;
  priceUnit?: string | null | undefined;
};

export const placeSubmissions = pgTable(
  'place_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    googlePlaceId: text('google_place_id').notNull(),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    submittedByGuestSessionId: uuid('submitted_by_guest_session_id'),
    roomId: uuid('room_id'),
    categoryKey: text('category_key'),
    priceMin: bigint('price_min', { mode: 'number' }),
    priceMax: bigint('price_max', { mode: 'number' }),
    priceUnit: text('price_unit'),
    vibeKeys: jsonb('vibe_keys').$type<string[]>().notNull().default([]),
    note: text('note'),
    status: submissionStatus('status').notNull().default('pending'),
    /** Same link from many users bumps this instead of creating drafts. */
    submissionCount: integer('submission_count').notNull().default(1),
    resultPlaceId: uuid('result_place_id').references(() => places.id, { onDelete: 'set null' }),
    decidedByAdminId: uuid('decided_by_admin_id'),
    decisionReason: text('decision_reason'),
    /**
     * PI-BE-031 — the reviewer's edits to the GoGo-owned fields, kept apart
     * from the contributor's own input above so neither erases the other.
     * A draft: saving it decides nothing and creates no place. Holds no
     * provider content.
     */
    reviewDraft: jsonb('review_draft').$type<SubmissionReviewDraft>(),
    reviewedByAdminId: uuid('reviewed_by_admin_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Moves on every review save and every decision — the concurrency token. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    // One pending proposal per provider place — dedupe by construction.
    uniqueIndex('place_submissions_pending_unique')
      .on(t.googlePlaceId)
      .where(sql`${t.status} = 'pending'`),
    index('place_submissions_status_idx').on(t.status, t.createdAt),
  ],
);
