import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * ADM-001 (#454) / ADR-0019 — versioned Vietnamese administrative units.
 *
 * Vietnam's hierarchy became two-level on 2025-07-01: province/municipality,
 * then ward/commune/special zone. District-level units are legacy history for
 * addresses that predate it, never current data.
 *
 * The shape that matters here is the business key. Codes are reused across
 * reorganisations — 2,212 of the 3,321 current commune codes name a different
 * unit than they did before 2025-07-01 — so identity is
 * `(dataset_version, code, effective_from)`, and a code read without knowing
 * which dataset produced it is ambiguous rather than merely stale. That is why
 * `places.administrativeDatasetVersion` exists beside the codes.
 */

export const administrativeUnitType = pgEnum('administrative_unit_type', [
  'PROVINCE',
  'MUNICIPALITY',
  'WARD',
  'COMMUNE',
  'SPECIAL_ZONE',
  /** Pre-2025-07-01 only. Excluded from every current-data read by default. */
  'LEGACY_DISTRICT',
]);

export const administrativeLevel = pgEnum('administrative_level', [
  'PROVINCE',
  'COMMUNE',
  'LEGACY_DISTRICT',
]);

/**
 * `FUTURE` exists because a decree is published before it takes effect. It is
 * never returned as current data; `effective_from` is what decides.
 */
export const administrativeUnitStatus = pgEnum('administrative_unit_status', [
  'ACTIVE',
  'INACTIVE',
  'FUTURE',
]);

export const administrativeDatasetStatus = pgEnum('administrative_dataset_status', [
  'STAGED',
  'VALIDATED',
  'REJECTED',
  'PUBLISHED',
  'ROLLED_BACK',
]);

export const administrativeChangeType = pgEnum('administrative_change_type', [
  'CREATED',
  'RENAMED',
  'MERGED',
  'SPLIT',
  'REASSIGNED',
  'DISSOLVED',
]);

/** `ambiguous` is the honest default for a SPLIT with no coordinate evidence. */
export const administrativeChangeResolution = pgEnum('administrative_change_resolution', [
  'resolved',
  'ambiguous',
]);

export const administrativeMappingStatus = pgEnum('administrative_mapping_status', [
  'UNMAPPED',
  'AUTO_MATCHED',
  'NEEDS_REVIEW',
  'VERIFIED',
  'REJECTED',
  'STALE',
]);

/**
 * How the claim was arrived at, not who typed it. `editor` is a person's own
 * assertion; the rest name the evidence the resolver used, in the priority
 * order of ADR-0019. `fuzzy_suggestion` can never accompany `VERIFIED`.
 */
export const administrativeMappingSource = pgEnum('administrative_mapping_source', [
  'editor',
  'trusted_code',
  'structured_components',
  'components_with_coordinates',
  'boundary_point_in_polygon',
  'exact_name',
  'change_mapping',
  'fuzzy_suggestion',
]);

export const administrativeQuarantineClass = pgEnum('administrative_quarantine_class', [
  'VALID_UNIQUE',
  'VALID_MERGE',
  /** Island districts that became đặc khu: a district-level source, not garbage. */
  'VALID_DISTRICT_TO_SPECIAL_ZONE',
  'DIVIDED_REQUIRES_REVIEW',
  'TARGET_NOT_FOUND',
  'SOURCE_NOT_FOUND',
  'MULTIPLE_TARGETS',
  'HIERARCHY_CONFLICT',
  'DUPLICATE',
  'INVALID',
]);

/**
 * A GoGo dataset is a combination of three independently pinned upstreams plus
 * GoGo's own reviewer overrides, so the identity of a published set is the
 * tuple — not any single source version. Changing any component produces a new
 * combined version that is validated and published like any other.
 */
/**
 * The reviewer columns below are plain `uuid` here rather than drizzle
 * `.references(() => adminUsers.id)`. The foreign keys are real and declared in
 * `migrations/0051_administrative-units.sql`; what is avoided is the import
 * cycle `places -> administrative -> cms -> places`, which would leave the
 * enums this file exports uninitialised at the moment `places.ts` evaluates
 * them. The database still refuses an unknown admin id; only the type-level
 * link is dropped.
 */
export const administrativeDatasetVersions = pgTable(
  'administrative_dataset_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    combinedDatasetVersion: text('combined_dataset_version').notNull(),
    combinedChecksum: text('combined_checksum').notNull(),
    currentSourceVersion: text('current_source_version').notNull(),
    historicalSourceVersion: text('historical_source_version'),
    mappingSourceCommit: text('mapping_source_commit'),
    /** Bumped by a reviewer decision, not by an upstream release. */
    overrideRevision: integer('override_revision').notNull().default(0),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    effectiveDate: date('effective_date').notNull(),
    status: administrativeDatasetStatus('status').notNull().default('STAGED'),
    validationReport: jsonb('validation_report'),
    diffSummary: jsonb('diff_summary'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('administrative_dataset_versions_version_unique').on(t.combinedDatasetVersion),
    // Re-importing byte-identical inputs must not mint a second version, and a
    // checksum already published must never be published again.
    uniqueIndex('administrative_dataset_versions_checksum_unique').on(t.combinedChecksum),
    // At most one PUBLISHED row. The API is not the only writer — the seed, an
    // import command and a psql session all reach this table — so the invariant
    // lives in an index, as migration 0050 argued for the super-admin singleton.
    uniqueIndex('administrative_dataset_versions_one_published')
      .on(t.status)
      .where(sql`${t.status} = 'PUBLISHED'`),
    index('administrative_dataset_versions_status_idx').on(t.status, t.importedAt.desc()),
  ],
);

export const administrativeUnits = pgTable(
  'administrative_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetVersionId: uuid('dataset_version_id')
      .notNull()
      .references(() => administrativeDatasetVersions.id, { onDelete: 'cascade' }),
    /** Official GSO code. Not unique on its own — see the file header. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    nameEn: text('name_en'),
    /**
     * Lowercased and unaccented by the importer, mirroring the
     * `places.name_normalized` convention so search compares in one space.
     */
    nameNormalized: text('name_normalized').notNull(),
    fullNameNormalized: text('full_name_normalized').notNull(),
    codeName: text('code_name'),
    unitType: administrativeUnitType('unit_type').notNull(),
    level: administrativeLevel('level').notNull(),
    /**
     * Province code for a commune or a legacy district; NULL for a province.
     * Not a foreign key: the parent may live in a different effective period,
     * and `(code, effective_from)` is not referenceable as one column.
     */
    parentCode: text('parent_code'),
    status: administrativeUnitStatus('status').notNull().default('ACTIVE'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    source: text('source').notNull(),
    sourceVersion: text('source_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('administrative_units_code_effective_unique').on(
      t.datasetVersionId,
      t.code,
      t.effectiveFrom,
    ),
    index('administrative_units_dataset_level_idx').on(t.datasetVersionId, t.level, t.status),
    index('administrative_units_parent_idx')
      .on(t.datasetVersionId, t.parentCode)
      .where(sql`${t.parentCode} is not null`),
    index('administrative_units_code_idx').on(t.code),
    check(
      'administrative_units_effective_range',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    // Deeper cycles are a validation gate (#457): a check cannot walk a graph.
    check(
      'administrative_units_not_own_parent',
      sql`${t.parentCode} is null or ${t.parentCode} <> ${t.code}`,
    ),
    check(
      'administrative_units_parent_by_level',
      sql`(${t.level} = 'PROVINCE' and ${t.parentCode} is null)
          or (${t.level} <> 'PROVINCE' and ${t.parentCode} is not null)`,
    ),
    // GIN trigram indexes live in the raw SQL migration: drizzle-kit cannot
    // express `gin_trgm_ops`, the same reason DB-009 gave for the place ones.
  ],
);

/**
 * Many-to-many by construction. One legacy unit may appear with several new
 * codes (SPLIT) and several legacy units may share one new code (MERGED) — the
 * pinned data holds 9,328 rows of the second kind collapsing into 3,041
 * targets, and 1,033 of the first across 471 sources. The row is the edge, and
 * neither side is unique.
 */
export const administrativeUnitChanges = pgTable(
  'administrative_unit_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetVersionId: uuid('dataset_version_id')
      .notNull()
      .references(() => administrativeDatasetVersions.id, { onDelete: 'cascade' }),
    /** NULL for CREATED: a unit that came from nothing has no predecessor. */
    oldCode: text('old_code'),
    /** NULL for DISSOLVED: a unit that went nowhere has no successor. */
    newCode: text('new_code'),
    changeType: administrativeChangeType('change_type').notNull(),
    effectiveDate: date('effective_date').notNull(),
    legalReference: text('legal_reference'),
    sourceVersion: text('source_version').notNull(),
    resolution: administrativeChangeResolution('resolution').notNull().default('resolved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('administrative_unit_changes_old_idx')
      .on(t.datasetVersionId, t.oldCode)
      .where(sql`${t.oldCode} is not null`),
    index('administrative_unit_changes_new_idx')
      .on(t.datasetVersionId, t.newCode)
      .where(sql`${t.newCode} is not null`),
    index('administrative_unit_changes_unresolved_idx')
      .on(t.datasetVersionId)
      .where(sql`${t.resolution} = 'ambiguous'`),
    check(
      'administrative_unit_changes_endpoints',
      sql`${t.oldCode} is not null or ${t.newCode} is not null`,
    ),
    // The COALESCE-based edge uniqueness lives in the SQL migration; drizzle-kit
    // cannot express a unique index over expressions.
  ],
);

/**
 * The change-mapping upstream is advisory, never authoritative current data.
 * Rows land here first; only structurally valid ones whose source and target
 * both resolve against the pinned snapshots are promoted to canonical changes.
 * The raw payload is kept verbatim so a reviewer sees what the source actually
 * said rather than GoGo's reading of it.
 */
export const administrativeMappingQuarantine = pgTable(
  'administrative_mapping_quarantine',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetVersionId: uuid('dataset_version_id')
      .notNull()
      .references(() => administrativeDatasetVersions.id, { onDelete: 'cascade' }),
    rawPayload: jsonb('raw_payload').notNull(),
    sourceProvenance: text('source_provenance').notNull(),
    upstreamFlags: jsonb('upstream_flags').$type<Record<string, unknown>>().notNull().default({}),
    oldCode: text('old_code'),
    newCode: text('new_code'),
    oldName: text('old_name'),
    newName: text('new_name'),
    classification: administrativeQuarantineClass('classification').notNull(),
    validationReason: text('validation_reason').notNull(),
    /**
     * What GoGo could offer instead. Empty for a genuinely undecidable row —
     * an empty list is a fact, and better than a fabricated suggestion.
     */
    suggestedCandidates: jsonb('suggested_candidates')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    affectedPlaceCount: integer('affected_place_count').notNull().default(0),
    reviewerDecision: text('reviewer_decision'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewerNotes: text('reviewer_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('administrative_mapping_quarantine_dataset_idx').on(t.datasetVersionId, t.classification),
    index('administrative_mapping_quarantine_pending_idx')
      .on(t.datasetVersionId)
      .where(sql`${t.reviewedAt} is null`),
  ],
);

/**
 * A reviewer correcting a mapping does not touch the pinned snapshot: the
 * snapshot is evidence of what the source said, and editing it would destroy
 * the only way to tell an upstream fact from a GoGo decision. The override is
 * a separate row that wins over the upstream mapping at resolve time, per the
 * precedence order in ADR-0019.
 */
export const administrativeUnitChangeOverrides = pgTable(
  'administrative_unit_change_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    oldCode: text('old_code').notNull(),
    newCode: text('new_code'),
    changeType: administrativeChangeType('change_type').notNull(),
    effectiveDate: date('effective_date').notNull(),
    legalReference: text('legal_reference'),
    reason: text('reason').notNull(),
    /** Which combined version the reviewer was looking at when they decided. */
    decidedAgainstVersion: text('decided_against_version').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    index('administrative_unit_change_overrides_old_idx')
      .on(t.oldCode)
      .where(sql`${t.revokedAt} is null`),
    // The live-uniqueness index uses COALESCE and lives in the SQL migration.
  ],
);
