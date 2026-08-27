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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { places } from './places';

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

export type MatchCandidate = {
  googlePlaceId: string;
  name: string;
  address: string;
  confidence: number;
  lat?: number;
  lng?: number;
};

export const placeIngestRows = pgTable(
  'place_ingest_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
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
    errors: jsonb('errors').$type<IngestMessage[]>().notNull().default([]),
    warnings: jsonb('warnings').$type<IngestMessage[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency anchor: a retried chunk updates rows, never duplicates them.
    uniqueIndex('place_ingest_rows_job_source_unique').on(t.jobId, t.sourceRowId),
    index('place_ingest_rows_status_idx').on(t.jobId, t.status),
    check(
      'place_ingest_rows_confidence_range',
      sql`${t.matchConfidence} is null or (${t.matchConfidence} >= 0 and ${t.matchConfidence} <= 1)`,
    ),
  ],
);

export const providerSourceStatus = pgEnum('provider_source_status', [
  'active',
  'moved',
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
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    refreshAfter: timestamp('refresh_after', { withTimezone: true }),
    attribution: jsonb('attribution').$type<Record<string, unknown>>().notNull().default({}),
    sourceStatus: providerSourceStatus('source_status').notNull().default('active'),
    /** Field tier the snapshot was fetched at (core | quality | detail). */
    fetchTier: text('fetch_tier').notNull().default('core'),
  },
  (t) => [
    uniqueIndex('place_provider_sources_provider_external_unique').on(t.provider, t.externalId),
    index('place_provider_sources_place_idx').on(t.placeId),
    index('place_provider_sources_refresh_idx').on(t.refreshAfter),
  ],
);

export const submissionStatus = pgEnum('place_submission_status', [
  'pending',
  'approved',
  'rejected',
  'merged',
]);

/** Mobile add-by-link proposals (FR-INGEST-010..012). */
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
