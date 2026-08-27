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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';

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
    areaKey: text('area_key'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('places_status_idx').on(t.status),
    index('places_area_idx').on(t.areaKey),
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
    // Provider payload snapshot — retention bounded by provider license.
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

export const placeHours = pgTable(
  'place_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    // 0 = Sunday .. 6 = Saturday, local place timezone.
    dayOfWeek: smallint('day_of_week').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('place_media_place_idx').on(t.placeId)],
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
  centerLat: doublePrecision('center_lat').notNull(),
  centerLng: doublePrecision('center_lng').notNull(),
  radiusM: integer('radius_m').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});
