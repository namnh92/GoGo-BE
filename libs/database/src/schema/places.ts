import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  doublePrecision,
  geometry,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { administrativeMappingSource, administrativeMappingStatus } from './administrative';

/**
 * DB-005 — place/source/hours/price/taxonomy/media schema.
 * Place facts (price/hours/availability) come only from verified sources —
 * provider, editor, or verified bill check-ins — never from AI output.
 */

export const taxonomyKind = pgEnum('taxonomy_kind', [
  'mood',
  'category',
  'setting',
  'dietary',
  'accessibility',
  'spending_style',
  'suitability',
  /** #171 — check-in vocabulary, owned by the CMS like every other kind. */
  'checkin_tag',
]);

export const taxonomies = pgTable(
  'taxonomies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: taxonomyKind('kind').notNull(),
    // Stable machine key — clients resolve labels via i18n, never store labels.
    key: text('key').notNull(),
    parentId: uuid('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('taxonomies_kind_key_unique').on(t.kind, t.key)],
);

export const taxonomyLabels = pgTable(
  'taxonomy_labels',
  {
    taxonomyId: uuid('taxonomy_id')
      .notNull()
      .references(() => taxonomies.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    label: text('label').notNull(),
  },
  (t) => [uniqueIndex('taxonomy_labels_unique').on(t.taxonomyId, t.locale)],
);

/** SE-001 — synonyms feed search normalization; managed in CMS (CMS-005). */
export const taxonomySynonyms = pgTable(
  'taxonomy_synonyms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxonomyId: uuid('taxonomy_id')
      .notNull()
      .references(() => taxonomies.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    locale: text('locale').notNull().default('vi'),
    weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1.0'),
  },
  (t) => [uniqueIndex('taxonomy_synonyms_unique').on(t.taxonomyId, t.term, t.locale)],
);

export const placeStatus = pgEnum('place_status', [
  'draft',
  'community_submitted',
  'review',
  'published',
  'suspended',
  'archived',
]);

export const places = pgTable(
  'places',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Lowercased, unaccented name maintained by trigger/app for trigram search.
    nameNormalized: text('name_normalized').notNull(),
    description: text('description'),
    status: placeStatus('status').notNull().default('draft'),
    geom: geometry('geom', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    addressText: text('address_text'),
    /**
     * BE-CMS-PE-001 (#425) — the **discovery** area: a curated bucket
     * (`hcm_q1`) shared with `rooms`, `plans`, `plan_templates`,
     * `content_recommendations` and `cms_banners`, and the key the CMS place
     * filter sends.
     *
     * Its vocabulary is `service_areas.key` — the catalog the community import
     * already checks a submitted place against, so "an area GoGo covers" and
     * "an area a place can be filed under" stay one list rather than two that
     * drift. Not a foreign key: rows predating the catalog carry keys it does
     * not list, and the picker shows an unknown key rather than losing it.
     *
     * Deliberately NOT the postal address. A place can sit in Bình Thạnh and
     * belong to the "Thảo Điền" discovery area, and an address with no
     * district is still a valid address — which is why `city`/`district`
     * below are separate free-text fields and not derived from this key.
     */
    areaKey: text('area_key'),
    /**
     * Administrative address, kept apart from `area_key` for that reason.
     * Free-text names rather than codes: Vietnam's administrative units are
     * reorganised, editors need to type one the catalog does not carry, and
     * inventing a code for it would put a key in the data that resolves to
     * nothing (#425).
     */
    city: text('city'),
    district: text('district'),
    phone: text('phone'),
    website: text('website'),
    rating: numeric('rating', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count').notNull().default(0),
    priceLevel: smallint('price_level'),
    avgVisitMinutes: integer('avg_visit_minutes'),
    // Suitability facts for couple/group audiences, sourced from taxonomy +
    // editorial curation (SE-010). Stored as stable keys with 0..1 scores.
    suitability: jsonb('suitability').$type<Record<string, number>>(),
    isLodging: boolean('is_lodging').notNull().default(false),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.50'),
    freshnessCheckedAt: timestamp('freshness_checked_at', { withTimezone: true }),
    curatedRank: integer('curated_rank'),
    /**
     * ADM-001 (#454) / ADR-0019 — the administrative address as **codes**,
     * beside the free-text names above rather than instead of them.
     *
     * ADR-0016 decided `city`/`district` stay free text because an editor must
     * be able to type a unit the catalog does not carry, and because a minted
     * code would resolve to nothing. ADR-0019 supersedes only the second half:
     * a code taken from the official directory resolves to a row GoGo can show,
     * search and version. `city`, `district` and `address_text` are unchanged,
     * still writable, and never rewritten by a dataset publication — they are
     * the evidence of what a provider or a person actually wrote.
     *
     * `administrativeDatasetVersion` is not bookkeeping. 2,212 of the 3,321
     * current commune codes named a *different* unit before 2025-07-01, so a
     * code read without knowing which dataset produced it resolves to a
     * confidently wrong commune. Every read of these codes is qualified by it.
     */
    provinceCode: text('province_code'),
    communeCode: text('commune_code'),
    /** Pre-2025-07-01 evidence. Never part of the current hierarchy. */
    legacyDistrictCode: text('legacy_district_code'),
    administrativeMappingStatus: administrativeMappingStatus('administrative_mapping_status')
      .notNull()
      .default('UNMAPPED'),
    administrativeMappingSource: administrativeMappingSource('administrative_mapping_source'),
    /**
     * Written only where it is computed deterministically. A resolver path that
     * cannot produce a number leaves it NULL rather than inventing 0.5.
     */
    administrativeMappingConfidence: numeric('administrative_mapping_confidence', {
      precision: 3,
      scale: 2,
    }),
    administrativeDatasetVersion: text('administrative_dataset_version'),
    /**
     * Which boundary set produced a point-in-polygon claim (GoGo-BE#464). Kept
     * apart from the dataset version because the same units can be published
     * against a newer boundary release, and "which polygons said so" is the
     * question a reviewer asks when a match looks wrong.
     */
    administrativeBoundaryVersion: text('administrative_boundary_version'),
    administrativeMappedAt: timestamp('administrative_mapped_at', { withTimezone: true }),
    administrativeMappedBy: uuid('administrative_mapped_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('places_status_idx').on(t.status),
    index('places_area_idx').on(t.areaKey),
    index('places_administrative_status_idx')
      .on(t.administrativeMappingStatus)
      .where(sql`${t.administrativeMappingStatus} <> 'UNMAPPED'`),
    index('places_commune_code_idx')
      .on(t.communeCode)
      .where(sql`${t.communeCode} is not null`),
    index('places_province_code_idx')
      .on(t.provinceCode)
      .where(sql`${t.provinceCode} is not null`),
    check(
      'places_administrative_confidence_range',
      sql`${t.administrativeMappingConfidence} is null
          or (${t.administrativeMappingConfidence} >= 0
              and ${t.administrativeMappingConfidence} <= 1)`,
    ),
    // A mapped place must say which dataset mapped it; UNMAPPED carries nothing,
    // which is why this keys on the status rather than on the code.
    check(
      'places_administrative_version_present',
      sql`${t.administrativeMappingStatus} = 'UNMAPPED'
          or ${t.administrativeDatasetVersion} is not null`,
    ),
    // A point-in-polygon claim that cannot say which polygons it came from is
    // not reproducible, and reproducibility is the whole basis on which
    // GoGo-BE#464 classified these codes as GoGo's own facts.
    check(
      'places_administrative_boundary_version_present',
      sql`${t.administrativeMappingSource} is distinct from 'boundary_point_in_polygon'
          or ${t.administrativeBoundaryVersion} is not null`,
    ),
    // GiST geo index + trigram/FTS indexes live in the raw SQL migration
    // (DB-009) because drizzle-kit cannot express them.
  ],
);

export const placeTaxonomies = pgTable(
  'place_taxonomies',
  {
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    taxonomyId: uuid('taxonomy_id')
      .notNull()
      .references(() => taxonomies.id, { onDelete: 'cascade' }),
    weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1.0'),
  },
  (t) => [
    uniqueIndex('place_taxonomies_unique').on(t.placeId, t.taxonomyId),
    index('place_taxonomies_taxonomy_idx').on(t.taxonomyId),
  ],
);

/**
 * `google` is retired from writers by PR1 (#334): Google provenance lives in
 * `place_provider_sources`. The value stays in the enum because historical
 * rows still carry it and this migration copies rather than drops.
 */
export const placeSourceProvider = pgEnum('place_source_provider', [
  'google',
  'manual',
  'community',
]);

export const placeSources = pgTable(
  'place_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    provider: placeSourceProvider('provider').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url'),
    attribution: text('attribution'),
    /**
     * Retired (ADR-0006 §9.4 R1, migration 0033). This held the whole Google
     * Details payload; nothing ever read it and no purge existed. Writers are
     * gone and existing values are nulled — the columns are dropped a release
     * later, once no deployed code names them.
     */
    raw: jsonb('raw'),
    rawUpdatedAt: timestamp('raw_updated_at', { withTimezone: true }),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Dedup anchor: one canonical place per provider record (FR-CMS-004).
    uniqueIndex('place_sources_provider_external_unique').on(t.provider, t.externalId),
    index('place_sources_place_idx').on(t.placeId),
  ],
);

export const hoursSource = pgEnum('hours_source', ['provider', 'editor']);

/**
 * BE-CMS-PE-001 (#425) — what a `place_hours` row asserts about its day.
 *
 * `interval` is a span and carries minutes; a day may hold several of them
 * (a lunch service and a dinner service are two rows, not one long one).
 * `closed` and `open_24h` carry no minutes and are the only row for their day.
 *
 * "Open around the clock" needed its own value because the minute columns
 * cannot express it: the check constraint stops at 1439, so 24:00 has no
 * encoding, and `00:00–23:59` would quietly shut the place for a minute every
 * night. **Unknown is the absence of a row** — the fourth state is not in this
 * enum on purpose, because "we have no data" is not something a row asserts.
 */
export const hoursEntryKind = pgEnum('hours_entry_kind', ['interval', 'closed', 'open_24h']);

export const placeHours = pgTable(
  'place_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    // 0 = Sunday .. 6 = Saturday, local place timezone.
    dayOfWeek: smallint('day_of_week').notNull(),
    entryKind: hoursEntryKind('entry_kind').notNull().default('interval'),
    openMinute: integer('open_minute').notNull(),
    closeMinute: integer('close_minute').notNull(),
    isOvernight: boolean('is_overnight').notNull().default(false),
    source: hoursSource('source').notNull().default('provider'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (t) => [
    index('place_hours_place_idx').on(t.placeId),
    check('place_hours_day_range', sql`${t.dayOfWeek} between 0 and 6`),
    check(
      'place_hours_minute_range',
      sql`${t.openMinute} between 0 and 1439 and ${t.closeMinute} between 0 and 1439`,
    ),
    // A `closed` / `open_24h` row makes a claim about the whole day, so it
    // must not also carry minutes that something downstream might read as a
    // span. Pinned at zero rather than nullable: the columns are NOT NULL and
    // every existing reader dereferences them.
    check(
      'place_hours_kind_minutes',
      sql`${t.entryKind} = 'interval' or (${t.openMinute} = 0 and ${t.closeMinute} = 0 and ${t.isOvernight} = false)`,
    ),
  ],
);

export const priceUnit = pgEnum('price_unit', ['per_person', 'per_item', 'per_hour', 'per_night']);
export const priceSource = pgEnum('price_source', ['provider', 'editor', 'bill_checkin']);

export const placePrices = pgTable(
  'place_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    priceMin: bigint('price_min', { mode: 'number' }).notNull(),
    priceMax: bigint('price_max', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('VND'),
    unit: priceUnit('unit').notNull().default('per_person'),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.50'),
    source: priceSource('source').notNull().default('editor'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('place_prices_place_idx').on(t.placeId),
    check('place_prices_range', sql`${t.priceMin} >= 0 and ${t.priceMax} >= ${t.priceMin}`),
  ],
);

/**
 * ADR-0007 — cached travel legs between two catalog places.
 *
 * Durable rather than a Redis TTL because these pairs are fixed geometry: two
 * catalog points, identical for every user and every room, and reusable until
 * one of the places moves. That is what makes routing affordable here — unlike
 * a ride-hailing matrix, most legs GoGo asks for have been asked before. The
 * origin→first-stop leg starts from a user-supplied point and is *not* cached
 * here; it belongs in Redis with a short TTL.
 */
export const travelLegs = pgTable(
  'travel_legs',
  {
    fromPlaceId: uuid('from_place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    toPlaceId: uuid('to_place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('drive'),
    /** Hour-of-day bucket; only meaningful once traffic-aware routing is on. */
    timeBucket: smallint('time_bucket').notNull().default(0),
    minutes: integer('minutes').notNull(),
    distanceM: integer('distance_m').notNull(),
    provider: text('provider').notNull().default('google_routes'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('travel_legs_pair_unique').on(t.fromPlaceId, t.toPlaceId, t.mode, t.timeBucket),
    index('travel_legs_from_idx').on(t.fromPlaceId),
  ],
);

/**
 * BE-CMS-PE-001 (#425) — who a value came from. Declared here rather than
 * beside `place_field_provenance` because `place_media.source_type` (#191) uses
 * the same vocabulary and is defined first.
 */
export const fieldSourceType = pgEnum('field_source_type', [
  'editorial',
  'provider',
  'community',
  'google_derived',
]);

export const moderationStatus = pgEnum('moderation_status', ['pending', 'approved', 'rejected']);

export const placeMedia = pgTable(
  'place_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    sortOrder: integer('sort_order').notNull().default(0),
    moderation: moderationStatus('moderation').notNull().default('pending'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** BE-CMS-M1 (#191) — editorial text under the image. */
    caption: text('caption'),
    /**
     * Provider terms travel with a provider photo (FR-INGEST-014). Losing it
     * the moment an editor reorders the list is the failure this prevents.
     */
    attribution: text('attribution'),
    /** One per place — enforced by a partial unique index, not by convention. */
    isCover: boolean('is_cover').notNull().default(false),
    /** Same vocabulary as `place_field_provenance`: who the image came from. */
    sourceType: fieldSourceType('source_type').notNull().default('editorial'),
    /** A moderation decision with no recorded reason is not auditable. */
    moderationReason: text('moderation_reason'),
    moderatedBy: uuid('moderated_by'),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    /**
     * The `media_uploads` row this key came from, so a detach can tell
     * "still referenced elsewhere" from "orphaned".
     */
    mediaUploadId: uuid('media_upload_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('place_media_place_idx').on(t.placeId),
    uniqueIndex('place_media_cover_unique')
      .on(t.placeId)
      .where(sql`${t.isCover}`),
  ],
);

/**
 * BE-CMS-PE-001 (#425) — where one *field* of a place came from.
 *
 * `place_sources` records that a place is linked to a Google record;
 * `place_provider_sources` records the liveness of that link. Neither says who
 * wrote the phone number, and that is the question a provider refresh has to
 * answer before it overwrites anything: an editor who rang the restaurant and
 * typed what they heard owns that value, and a later provider fetch must not
 * silently replace it.
 *
 * One row per (place, field). Absent means nobody has claimed the field, which
 * is the state every place starts in — the table is not backfilled, because
 * inventing provenance for values whose origin nothing recorded would be the
 * same lie it exists to prevent.
 *
 * `source_reference` is what the claim points at: a provider record id for
 * `provider`, a submission id for `community`, null for `editorial` (the actor
 * is the reference, and it is in `actor_id`).
 *
 * Per GOGO_PRODUCT_DATA_ARCHITECTURE.md an editor re-typing what Google shows
 * does not make the value GoGo-owned — `google_derived` is reserved for a
 * value applied from a provider preview, and is a distinct source type from
 * `editorial` precisely so the difference survives.
 */
export const placeFieldProvenance = pgTable(
  'place_field_provenance',
  {
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** Column name in `places`, snake_case: `phone`, `website`, `city`. */
    field: text('field').notNull(),
    sourceType: fieldSourceType('source_type').notNull(),
    sourceReference: text('source_reference'),
    /** Admin who made the claim, when it was a person. */
    actorId: uuid('actor_id'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.placeId, t.field] }),
    index('place_field_provenance_place_idx').on(t.placeId),
  ],
);

export const placeImportStatus = pgEnum('place_import_status', ['pending', 'verified', 'rejected']);

/** BE-BFF-013 / FR-PLACE-001..006 — community place import via Google Maps link. */
export const placeImports = pgTable(
  'place_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    submittedByGuestSessionId: uuid('submitted_by_guest_session_id'),
    roomId: uuid('room_id'),
    url: text('url').notNull(),
    providerPlaceId: text('provider_place_id'),
    status: placeImportStatus('status').notNull().default('pending'),
    // NOT_FOUND | INSUFFICIENT_REVIEWS | LOW_RATING | OUT_OF_AREA | CLOSED |
    // INVALID_URL | PROVIDER_ERROR
    reasonCode: text('reason_code'),
    /**
     * @deprecated #348 — no longer written, and never read.
     *
     * Held a Google Details extract (name, address, lat/lng, rating, rating
     * count, attribution) with no reader, no TTL and no purge job, which SST
     * §14.3 does not allow for the coordinates in it. Migration 0036 nulls
     * every row; the writer is gone from `place-import.service.ts`.
     *
     * The column survives one release so a rollback to the previous
     * deployment still finds it, then is dropped (ADR-0006 §9.4 R5). Do not
     * write to it, and do not read it — a value here can only be a row that
     * predates the purge.
     */
    providerSnapshot: jsonb('provider_snapshot'),
    resultPlaceId: uuid('result_place_id').references(() => places.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('place_imports_status_idx').on(t.status),
    index('place_imports_submitter_idx').on(t.submittedByUserId),
  ],
);

/** Static fallback list for area autocomplete (FR-PLACE-007). */
export const serviceAreas = pgTable('service_areas', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  /**
   * BE-CMS-PE-001 (#425) — the city this area sits in, so a picker can group
   * "Quận 1" under "TP.HCM" instead of asking an editor to read it out of the
   * name string. Nullable: an area that is itself a city has none.
   */
  city: text('city'),
  centerLat: doublePrecision('center_lat').notNull(),
  centerLng: doublePrecision('center_lng').notNull(),
  radiusM: integer('radius_m').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});
