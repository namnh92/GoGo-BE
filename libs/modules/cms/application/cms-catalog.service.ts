import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { PlaceDedupService } from '../../ingestion/application/place-dedup.service';
import { PlaceResolverService } from '../../ingestion/application/place-resolver.service';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { AppError } from '../../shared/app-error';
import { invalidateTravelOnMove } from '../../shared/place-relocation';
import { APP_CONFIG, type MediaConfig, type ProvenanceConfig } from '../../shared/config';
import { GOOGLE_PROVIDER, googleProvenanceRows } from '../../shared/google-provenance';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { writeOutbox } from '../../shared/outbox';
import { assertPlaceApprovable } from '../../administrative/application/place-approval';
import {
  AdministrativeResolverService,
  type PersistResult,
} from '../../administrative/application/administrative-resolver.service';
import {
  activeDataset,
  assertCurrentPair,
  currentUnit,
  requireActiveDataset,
  unitNames,
  type DatasetRef,
  type Executor,
} from '../../administrative/application/unit-lookup';
import { placeAdministrativeSummary } from '../../administrative/application/place-administrative-summary';
import type { MappingMethod, MappingStatus } from '../../administrative/domain/mapping-status';
import {
  contradictsStoredMapping,
  editPolicyFor,
  isMaterialForMapping,
} from '../../administrative/domain/edit-impact';
import { validateWeek, type HoursEntry, type HoursEntryKind } from '../domain/place-hours';
import { normalizePhone, normalizeWebsite } from '../domain/place-contact';
import { publicCatalogueUrl } from '../../shared/media-url';

type PlaceStatus = (typeof schema.places.$inferSelect)['status'];

/** FR-CMS-002 — place status workflow. */
const PLACE_TRANSITIONS: Record<PlaceStatus, PlaceStatus[]> = {
  draft: ['review', 'archived'],
  community_submitted: ['review', 'published', 'archived'],
  review: ['published', 'draft', 'archived'],
  published: ['suspended', 'archived'],
  suspended: ['published', 'archived'],
  archived: [],
};

/**
 * BE-CMS-PE-001 (#425) — `null` means *clear this field*, `undefined` means
 * *leave it alone*. The distinction is the contract: the console could
 * previously never empty a value it had filled, because an empty input arrived
 * as `undefined` and was skipped.
 */
export type PlaceEditInput = {
  name?: string | undefined;
  description?: string | null | undefined;
  addressText?: string | null | undefined;
  areaKey?: string | null | undefined;
  /**
   * ADR-0016 — legacy free text. Kept because an editor must be able to write
   * an address a catalog does not carry, and because existing rows hold it.
   * It is **not** the administrative identity and never selects a code:
   * `provinceCode`/`communeCode` below are, and the resolver reads this only as
   * one piece of evidence among five.
   */
  city?: string | null | undefined;
  /**
   * Legacy only. District-level units were dissolved on 2025-07-01, so nothing
   * current is expressed here; the column survives for rows that already carry
   * it and as historical name evidence for the resolver (ADM-016).
   */
  district?: string | null | undefined;
  /**
   * ADM-016 / ADR-0019 — the canonical administrative address, as codes.
   *
   * They travel as a pair or not at all: a province without a commune is not an
   * address, and a commune without the province it belongs to is a code with no
   * hierarchy to check it against. Both are validated against the dataset that
   * is published at commit time, and both reach the mapping through the
   * resolver's `trusted_code` evidence — there is no path that writes a code
   * straight onto the row without adjudication.
   */
  provinceCode?: string | null | undefined;
  communeCode?: string | null | undefined;
  phone?: string | null | undefined;
  website?: string | null | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  avgVisitMinutes?: number | null | undefined;
  suitability?: Record<string, number> | undefined;
  isLodging?: boolean | undefined;
  curatedRank?: number | null | undefined;
  taxonomyIds?: string[] | undefined;
  /**
   * The `updatedAt` the editor's form was loaded from. When it no longer
   * matches, somebody else has written since — the save is refused instead of
   * silently winning (api-contract: optimistic concurrency).
   */
  expectedUpdatedAt?: string | undefined;
};

/**
 * Creating differs from editing in two ways, and both are deliberate.
 *
 * `name` and a coordinate are required: a place with no name is not a record
 * anyone can act on, and one with no position cannot be searched, routed to, or
 * checked for duplicates — the three things the catalogue exists for. There is
 * no `expectedUpdatedAt` because there is nothing yet to be stale against.
 */
export type PlaceCreateInput = Omit<
  PlaceEditInput,
  'name' | 'lat' | 'lng' | 'expectedUpdatedAt'
> & {
  name: string;
  lat: number;
  lng: number;
  /** The editor has seen the near-duplicates and says this is a different place. */
  allowDuplicate?: boolean | undefined;
  /**
   * #465 — the Google record this place is the GoGo copy of, from the preceding
   * `POST /cms/places/resolve-link`. Identity only: it becomes a `place_sources`
   * row, which is what puts the place inside provider dedup and makes a later
   * refresh possible at all. ADR-0006 §9.3 permits storing the id indefinitely.
   */
  googlePlaceId?: string | undefined;
  /**
   * Which fields still hold the value the resolution filled in — the ones the
   * editor looked at and left alone. They are recorded `google_derived`, not
   * `editorial`, because that is what happened.
   *
   * The client is the only thing that knows this: the server holds no snapshot
   * of the preview to diff against, deliberately (ADR-0006 §9.5 — no
   * cross-request provider content). An editor who retypes a name over the top
   * of Google's owns it, and the console drops the field from this list when
   * they do.
   */
  googleDerivedFields?: readonly GoogleDerivableField[] | undefined;
};

/**
 * Fields whose origin `place_field_provenance` records. Kept as a list rather
 * than "every column" because provenance is only meaningful where a provider
 * and an editor could both plausibly have written the value.
 */
export const PROVENANCE_FIELDS = [
  'name',
  'description',
  'address_text',
  'area_key',
  'city',
  'district',
  'phone',
  'website',
  /**
   * #465 — the position, and the reason add-by-link exists. A coordinate is
   * exactly the kind of value both a provider and an editor could plausibly
   * have written, and the difference between "Google says this is where it is"
   * and "someone typed 10.7769, 106.7009" is the difference between a pin on
   * the door and a pin on the next street.
   */
  'geom',
] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

/**
 * Input field name to the column its provenance is recorded against.
 *
 * `lat` and `lng` are two halves of one column, so both map to `geom` and the
 * callers de-duplicate — `place_field_provenance` is keyed on
 * (place_id, field), and inserting the pair twice would violate it.
 */
const PROVENANCE_COLUMN: Record<string, ProvenanceField> = {
  name: 'name',
  description: 'description',
  addressText: 'address_text',
  areaKey: 'area_key',
  city: 'city',
  district: 'district',
  phone: 'phone',
  website: 'website',
  lat: 'geom',
  lng: 'geom',
};

/**
 * The fields a Google Maps resolution can legitimately fill.
 *
 * Deliberately short. `POST /cms/places/resolve-link` returns a rating and a
 * review count too, and neither is here: per GOGO_PRODUCT_DATA_ARCHITECTURE.md
 * §2 canonical name/address/geo are GoGo-owned and persist, while Google
 * rating/review/photo/hours are "No by default". The preview shows them so an
 * editor can tell two branches of one chain apart; nothing writes them.
 */
export const GOOGLE_DERIVABLE_FIELDS = ['name', 'addressText', 'lat', 'lng'] as const;
export type GoogleDerivableField = (typeof GOOGLE_DERIVABLE_FIELDS)[number];

export type HoursWriteEntry = HoursEntry & { source?: 'provider' | 'editor' | undefined };

export const PLACE_SORTS = ['updated_at', 'created_at', 'name', 'confidence'] as const;
export type PlaceSort = (typeof PLACE_SORTS)[number];

export const PLACE_SOURCES = ['google', 'community', 'manual'] as const;
export type PlaceSource = (typeof PLACE_SOURCES)[number];

/**
 * Keyset paging needs a NOT NULL sort column — a null would break the tuple
 * comparison and silently drop rows. `nullable` is asserted, not assumed.
 * `name` sorts on the normalized column so ordering does not depend on the
 * database collation.
 */
const SORTABLE: Record<PlaceSort, { column: SQL; nullable: boolean; cast: SQL }> = {
  // `cast` matters: the cursor travels as text, and comparing a timestamptz
  // column against untyped text makes Postgres pick the wrong operator.
  updated_at: { column: sql`p.updated_at`, nullable: false, cast: sql`::timestamptz` },
  created_at: { column: sql`p.created_at`, nullable: false, cast: sql`::timestamptz` },
  name: { column: sql`p.name_normalized`, nullable: false, cast: sql`::text` },
  confidence: { column: sql`p.confidence`, nullable: false, cast: sql`::numeric` },
};

/**
 * ADM-018 — which side of the canonical hierarchy a place sits on.
 *
 * `grouped` is a place that can honestly appear under a province and a
 * commune; `review` is everything else. There is no third value, because a
 * place is either placeable in the current hierarchy or it is not, and the
 * reason it is not belongs in the summary's breakdown rather than in a filter
 * the console would have to enumerate.
 */
export const ADMINISTRATIVE_STATES = ['grouped', 'review'] as const;
export type AdministrativeState = (typeof ADMINISTRATIVE_STATES)[number];

/**
 * ADM-018 — the predicates `GET /cms/places` and the hierarchy counts share.
 *
 * One type, because a count that does not reconcile with the list it claims to
 * describe is worse than no count: an editor who clicks "Phường Bến Thành · 10"
 * and gets eight rows has been told something false about the catalogue. The
 * two callers build their SQL from the same function, so they cannot drift.
 */
export type PlaceFilter = {
  status?: PlaceStatus | undefined;
  q?: string | undefined;
  areaKey?: string | undefined;
  category?: string | undefined;
  source?: PlaceSource | undefined;
  staleBefore?: Date | undefined;
  provinceCode?: string | undefined;
  communeCode?: string | undefined;
  administrativeState?: AdministrativeState | undefined;
};

export type PlaceListQuery = PlaceFilter & {
  sort: PlaceSort;
  direction: 'asc' | 'desc';
  limit: number;
  cursor?: string | undefined;
};

export type PlaceListItem = {
  id: string;
  name: string;
  status: string;
  areaKey?: string | undefined;
  rating?: number | undefined;
  confidence: number;
  freshnessCheckedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
  /**
   * ADM-018 — the canonical address as stored, so the list, the detail and the
   * forms all name a place's province and commune the same way. Names travel
   * beside the codes because a row showing `79` tells an editor nothing.
   */
  provinceCode?: string | undefined;
  provinceName?: string | undefined;
  communeCode?: string | undefined;
  communeName?: string | undefined;
  administrativeMappingStatus: MappingStatus;
};

export type PlaceListPage = { items: PlaceListItem[]; nextCursor: string | null };

/**
 * ADM-018 — one level of the canonical hierarchy, with its counts.
 *
 * `totals.grouped + totals.review` is every place the filters select, and each
 * half maps to a real list query: `administrativeState=grouped` and
 * `administrativeState=review` with the same filters. That is the property
 * that makes a number on screen something an editor can click through to and
 * check, rather than something they have to believe.
 */
export type AdministrativeSummary = {
  /** The dataset the codes and names were read from. Null: none published. */
  datasetVersion: string | null;
  level: 'province' | 'commune';
  /** The province whose communes these are; null at province level. */
  province: { code: string; name: string } | null;
  units: {
    code: string;
    /** Null when the dataset has no name for a stored code — never invented. */
    name: string | null;
    placeCount: number;
    /**
     * Places filed against this province whose mapping cannot enter the
     * hierarchy. A **subset** of `totals.review`, never part of `placeCount`,
     * and null on a commune row — a place under review has no commune anyone
     * should trust it under.
     */
    reviewCount: number | null;
  }[];
  totals: { grouped: number; review: number };
  review: {
    byStatus: {
      UNMAPPED: number;
      NEEDS_REVIEW: number;
      REJECTED: number;
      STALE: number;
      /**
       * `AUTO_MATCHED` or `VERIFIED`, but against a commune that is no longer
       * current or no longer sits under the stored province. The status alone
       * cannot say this, and reporting it as `AUTO_MATCHED` would claim the
       * mapping is fine while the place is uncountable.
       */
      INVALID_HIERARCHY: number;
    };
  };
};

/**
 * ADM-018 — a place that may appear beneath a province and a commune.
 *
 * Four conditions, and every one of them has to hold at read time rather than
 * at write time. A mapping is a claim about a dataset, and the dataset moves:
 * a commune is dissolved, a code is reassigned to a unit under a different
 * province, a place is rejected by a reviewer. A row that was groupable last
 * month is not therefore groupable now, and counting it as if it were is how a
 * console shows a province total nobody can reproduce.
 *
 *   1. both codes present — a province without a commune is not an address,
 *      and a commune without its province has no hierarchy to be checked in;
 *   2. the commune is current in the active dataset;
 *   3. its parent is the province the place stores — two codes that are each
 *      valid and do not belong together are worse than one missing code;
 *   4. the mapping is `AUTO_MATCHED` or `VERIFIED`. `NEEDS_REVIEW` means the
 *      evidence disagreed with itself, `STALE` means the dataset moved under
 *      it, `REJECTED` means a person said no. None of those is a location.
 *
 * `AUTO_MATCHED` groups but still does not publish: `approvalBlock` is
 * untouched and a machine's answer is still not a moderator's.
 */
function groupablePredicate(datasetVersionId: string): SQL {
  return sql`(
    p.administrative_mapping_status in ('AUTO_MATCHED', 'VERIFIED')
    and p.province_code is not null
    and p.commune_code is not null
    and exists (
      select 1 from administrative_units c
      where c.dataset_version_id = ${datasetVersionId}::uuid
        and c.level = 'COMMUNE' and c.status = 'ACTIVE' and c.effective_to is null
        and c.code = p.commune_code and c.parent_code = p.province_code
    )
    and exists (
      select 1 from administrative_units pr
      where pr.dataset_version_id = ${datasetVersionId}::uuid
        and pr.level = 'PROVINCE' and pr.status = 'ACTIVE' and pr.effective_to is null
        and pr.code = p.province_code
    )
  )`;
}

/**
 * The stored province code, but only where it names a province that exists now.
 *
 * This is what lets a review bucket be reported under a province without
 * pretending the mapping is usable: a place whose commune is `NEEDS_REVIEW`
 * but whose province is a real current unit can be shown to the person who
 * looks after that province. A code that names nothing current cannot, and
 * those stay in the global bucket.
 */
function attributableProvincePredicate(datasetVersionId: string): SQL {
  return sql`(
    p.province_code is not null
    and exists (
      select 1 from administrative_units pr
      where pr.dataset_version_id = ${datasetVersionId}::uuid
        and pr.level = 'PROVINCE' and pr.status = 'ACTIVE' and pr.effective_to is null
        and pr.code = p.province_code
    )
  )`;
}

/**
 * Driver rows for the detail read. `db.execute` returns whatever the parser
 * hands back, so numerics arrive as strings and timestamps as Date or string —
 * normalized on the way out rather than assumed.
 */
type PlaceDetailRow = {
  id: string;
  name: string;
  description: string | null;
  status: PlaceStatus;
  address_text: string | null;
  area_key: string | null;
  city: string | null;
  district: string | null;
  province_code: string | null;
  commune_code: string | null;
  administrative_mapping_status: MappingStatus;
  administrative_mapping_source: MappingMethod | null;
  administrative_dataset_version: string | null;
  // Raw SQL: the driver hands this back as a string, not a Date.
  administrative_mapped_at: Date | string | null;
  lat: number | string | null;
  lng: number | string | null;
  phone: string | null;
  website: string | null;
  rating: string | null;
  rating_count: number;
  price_level: number | null;
  avg_visit_minutes: number | null;
  suitability: Record<string, number> | null;
  is_lodging: boolean;
  confidence: string;
  curated_rank: number | null;
  freshness_checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  provenance: PlaceProvenanceRow[] | null;
};

type PlaceHoursRow = {
  day_of_week: number;
  entry_kind: HoursEntryKind;
  open_minute: number;
  close_minute: number;
  is_overnight: boolean;
  source: string;
  verified_at: Date | string | null;
};

type PlacePriceRow = {
  id: string;
  price_min: string | number;
  price_max: string | number;
  currency: string;
  unit: string;
  source: string;
  confidence: string;
  verified_at: Date | string | null;
  created_at: Date | string;
};

type PlaceSourceRow = {
  id: string;
  provider: string;
  external_id: string;
  url: string | null;
  attribution: string | null;
  fetched_at: Date | string | null;
};

type PlaceMediaRow = {
  id: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  sort_order: number;
  moderation: string;
  moderation_reason: string | null;
  caption: string | null;
  attribution: string | null;
  is_cover: boolean;
  source_type: string;
  created_at: Date | string;
};

type PlaceProvenanceRow = {
  field: string;
  source_type: string;
  source_reference: string | null;
  verified_at: Date | string | null;
};

/** Column name → the name the public contract uses for the same field. */
const API_FIELD_OF: Record<string, string> = {
  name: 'name',
  description: 'description',
  address_text: 'addressText',
  area_key: 'areaKey',
  city: 'city',
  district: 'district',
  phone: 'phone',
  website: 'website',
};

type PlaceListRow = {
  id: string;
  name: string;
  status: string;
  area_key: string | null;
  rating: string | null;
  confidence: string;
  province_code: string | null;
  commune_code: string | null;
  administrative_mapping_status: MappingStatus;
  // `db.execute` returns driver rows: timestamps may arrive as Date or as the
  // raw string, depending on the parser in play. Normalize instead of assuming.
  freshness_checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  sort_value: string | number | Date;
};

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * "Where did this place come from" — derived from the links that exist, not
 * from `created_by`, so a place keeps its provenance when staff change.
 */
function sourcePredicate(source: PlaceSource): SQL {
  const linkedToProvider = sql`(
    exists (
      select 1 from place_provider_sources ps
      where ps.place_id = p.id and ps.provider = ${GOOGLE_PROVIDER}
    )
    or exists (select 1 from place_sources s where s.place_id = p.id and s.provider = 'google')
  )`;
  const fromCommunity = sql`exists (
    select 1 from place_submissions sub where sub.result_place_id = p.id
  )`;
  if (source === 'community') return fromCommunity;
  if (source === 'google') return sql`${linkedToProvider} and not ${fromCommunity}`;
  return sql`not ${linkedToProvider} and not ${fromCommunity}`;
}

/**
 * Optimistic concurrency (api-contract). The console sends the `updatedAt` its
 * form was loaded from; a mismatch means somebody saved in between, and the
 * write is refused with the current value so the UI can show what it would
 * have overwritten instead of overwriting it.
 *
 * Omitting the field skips the check, which keeps the endpoint usable from a
 * script and from a client that predates this contract.
 */
export function assertNotStale(current: Date, expected?: string | undefined): void {
  if (expected === undefined) return;
  const parsed = new Date(expected);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', [
      { field: 'expectedUpdatedAt', code: 'invalid_datetime', message: 'Không phải thời điểm ISO' },
    ]);
  }
  if (parsed.getTime() !== current.getTime()) {
    throw AppError.conflict(
      'PLACE_MODIFIED',
      'This place changed after the form was loaded',
      // The current value, so the console can diff rather than guess.
      [{ field: 'updatedAt', code: 'stale', message: current.toISOString() }],
    );
  }
}

export function encodePlaceCursor(value: string | number | Date, id: string): string {
  const raw = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(JSON.stringify([raw, id])).toString('base64url');
}

export function decodePlaceCursor(cursor: string): { value: string; id: string } {
  try {
    const [value, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad');
    return { value, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

/** CMS-002/003/004 — canonical place editing, sources/hours/prices, dedup. */
@Injectable()
export class CmsCatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    /**
     * #465 — identity lookups for add-by-link. Reused rather than reimplemented
     * because `resolveGoogleIdentity` reads both `place_provider_sources` and
     * the legacy `place_sources`, and a second copy of that query would drift
     * away from the one dedup enforces.
     */
    private readonly dedup: PlaceDedupService,
    /**
     * ADM-016 — the one path that turns a coordinate into an administrative
     * identity. Injected rather than reimplemented for the same reason `dedup`
     * is: the evidence order, the transition matrix and the reviewer-owned rule
     * are all in there, and a second copy would be a second answer.
     */
    private readonly resolver: AdministrativeResolverService,
    /**
     * PI-BE-021 — the one Details fetch a place created from a link is worth.
     *
     * Injected rather than reimplemented for the third time: `resolveByProviderId`
     * already carries the tier decision, the operational-vs-answered error split
     * (#279) and the request counters the cost dashboards read.
     */
    private readonly providerResolver: PlaceResolverService,
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: ProvenanceConfig & Partial<MediaConfig>,
    /** ADM-010 (#463): approval decisions are counted by their closed reason. */
    @Optional() @Inject(METRICS) private readonly metrics?: MetricsPort,
  ) {}

  /** Default on: off is the state that serves ingestion places unattributed. */
  private get unifiedProvenance(): boolean {
    return this.config?.PROVENANCE_UNIFIED_READS ?? true;
  }

  /**
   * #191 — where a media object is readable, or null when media hosting is not
   * configured in this environment. Mirrors `CmsPlaceMediaService.readUrl`; an
   * honest null beats a URL that would 404, and the console can tell the two
   * apart.
   */
  private mediaUrl(key: string): string | null {
    return publicCatalogueUrl(this.config?.MEDIA_PUBLIC_BASE_URL, key);
  }

  private async audit(adminId: string, action: string, resourceId: string, diff?: unknown) {
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'place',
      resourceId,
      diff,
    });
  }

  /**
   * BE-IMP-001/002 — CMS place list.
   *
   * Keyset (cursor) pagination, not offset: the catalog is written to while
   * editors browse it — a background import shifts rows between requests, and
   * offset would then repeat or skip them. The cursor carries the sort value
   * plus the id so the traversal stays stable no matter what is inserted.
   *
   * Search runs on `name_normalized`, the column the trigram index is built
   * on. Querying `name` instead both missed the index and gave different
   * results from the consumer-facing search on identical data.
   */
  async listPlaces(query: PlaceListQuery): Promise<PlaceListPage> {
    const { column, nullable, cast } = SORTABLE[query.sort];
    if (nullable) throw new Error(`sort column ${query.sort} must be NOT NULL for keyset paging`);
    const descending = query.direction === 'desc';

    const dataset = await activeDataset(this.db);

    /**
     * ADM-018 — a commune filter is checked against the province it was sent
     * with, before a row is read.
     *
     * Two codes that are each real and do not belong together return nothing,
     * and nothing is indistinguishable from "this commune is empty". The
     * refusal names the field, so the console can point at the box rather than
     * leave an editor staring at an empty table wondering which half is wrong.
     */
    if (query.communeCode) {
      if (!query.provinceCode) {
        throw AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', [
          {
            field: 'provinceCode',
            code: 'required',
            message: 'bắt buộc khi lọc theo phường/xã',
          },
        ]);
      }
      await assertCurrentPair(this.db, await requireActiveDataset(this.db), {
        provinceCode: query.provinceCode,
        communeCode: query.communeCode,
      });
    }

    const where = this.placePredicates(query, dataset);

    if (query.cursor) {
      const { value, id } = decodePlaceCursor(query.cursor);
      const bound = sql`${value}${cast}`;
      where.push(
        descending
          ? sql`(${column}, p.id) < (${bound}, ${id}::uuid)`
          : sql`(${column}, p.id) > (${bound}, ${id}::uuid)`,
      );
    }

    const condition = where.length > 0 ? sql.join(where, sql` and `) : sql`true`;
    const order = descending ? sql`${column} desc, p.id desc` : sql`${column} asc, p.id asc`;

    // limit + 1 so `nextCursor` means "there is more", not "maybe more".
    const rows = await this.db.execute(sql`
      select p.id, p.name, p.status, p.area_key, p.rating, p.confidence,
             p.province_code, p.commune_code, p.administrative_mapping_status,
             p.freshness_checked_at, p.created_at, p.updated_at,
             ${column} as sort_value
      from places p
      where ${condition}
      order by ${order}
      limit ${query.limit + 1}
    `);

    const page = rows.rows as PlaceListRow[];
    const items = page.slice(0, query.limit);
    const last = items[items.length - 1];

    /**
     * ADM-018 — one lookup for the whole page, not one per row.
     *
     * A list of fifty places spans a handful of distinct units, so this is a
     * single indexed query over at most a hundred codes. Resolving a name per
     * row would be the N+1 the list endpoint was built to avoid.
     */
    const names = dataset
      ? await unitNames(
          this.db,
          dataset.id,
          items.flatMap((p) => [p.province_code ?? '', p.commune_code ?? '']),
        )
      : new Map<string, string>();

    return {
      items: items.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        areaKey: p.area_key ?? undefined,
        rating: p.rating !== null ? Number(p.rating) : undefined,
        confidence: Number(p.confidence),
        freshnessCheckedAt: toIso(p.freshness_checked_at),
        createdAt: toIso(p.created_at)!,
        updatedAt: toIso(p.updated_at)!,
        provinceCode: p.province_code ?? undefined,
        provinceName: p.province_code
          ? (names.get(`PROVINCE:${p.province_code}`) ?? undefined)
          : undefined,
        communeCode: p.commune_code ?? undefined,
        communeName: p.commune_code
          ? (names.get(`COMMUNE:${p.commune_code}`) ?? undefined)
          : undefined,
        administrativeMappingStatus: p.administrative_mapping_status,
      })),
      nextCursor:
        page.length > query.limit && last ? encodePlaceCursor(last.sort_value, last.id) : null,
    };
  }

  /**
   * ADM-018 — every `where` clause the list and the counts agree on.
   *
   * Two things here are new rather than moved.
   *
   * **Archived is excluded unless it is asked for.** The list had no default
   * status filter at all, so an archived place — including the fourteen the DEV
   * smoke left behind — appeared in the ordinary catalogue and in anything that
   * counted it. "Archived" is the closest thing this schema has to a soft
   * delete; a deleted place inflating a commune's total is exactly the count
   * nobody can reconcile. Asking for `status=archived` still returns them,
   * which is the one place they belong.
   *
   * **The administrative filters mean the canonical codes and only those.**
   * `city`, `district`, `address_text` and `area_key` are free text or a
   * curated bucket; none of them is an administrative claim, and none of them
   * may move a place between provinces. `provinceCode`/`communeCode` compare
   * stored codes, and `administrativeState` decides whether the place also has
   * to be placeable in the current hierarchy.
   */
  private placePredicates(filter: PlaceFilter, dataset: DatasetRef | null): SQL[] {
    const where: SQL[] = [];

    if (filter.status) where.push(sql`p.status = ${filter.status}`);
    else where.push(sql`p.status <> 'archived'`);

    if (filter.areaKey) where.push(sql`p.area_key = ${filter.areaKey}`);

    if (filter.q) {
      // Already lower/unaccented on both sides, so LIKE is enough — and it is
      // what `places_name_trgm_idx` (gin_trgm_ops) can actually serve.
      const needle = `%${normalizeVietnamese(filter.q)}%`;
      where.push(sql`p.name_normalized like ${needle}`);
    }

    if (filter.category) {
      where.push(sql`exists (
        select 1 from place_taxonomies pt
        join taxonomies t on t.id = pt.taxonomy_id
        where pt.place_id = p.id and t.kind = 'category' and t.key = ${filter.category}
      )`);
    }

    if (filter.source) where.push(sourcePredicate(filter.source));

    if (filter.staleBefore) {
      // Never checked counts as stale — that is the case an editor most wants.
      where.push(
        sql`(p.freshness_checked_at is null or p.freshness_checked_at < ${filter.staleBefore})`,
      );
    }

    if (filter.provinceCode) where.push(sql`p.province_code = ${filter.provinceCode}`);
    if (filter.communeCode) where.push(sql`p.commune_code = ${filter.communeCode}`);

    if (filter.administrativeState) {
      if (!dataset) {
        /**
         * No published dataset means nothing can be checked against one, so
         * nothing is groupable — and saying "no places" to a `grouped` filter
         * is the truthful answer rather than an error. `review` is then every
         * place, which is also true: none of them has a hierarchy that can be
         * verified.
         */
        if (filter.administrativeState === 'grouped') where.push(sql`false`);
      } else {
        const groupable = groupablePredicate(dataset.id);
        where.push(filter.administrativeState === 'grouped' ? groupable : sql`not ${groupable}`);
      }
    }

    return where;
  }

  /**
   * ADM-018 — the canonical Province → Commune hierarchy, with the number of
   * places under each unit.
   *
   * One level per call, because that is how it is read: the console shows
   * provinces, an editor opens one, and the communes of that province arrive.
   * Returning the whole tree would be 34 provinces and 3,321 communes to render
   * a screen that shows one of them.
   *
   * Only units that hold at least one place are listed. The catalogue's
   * hierarchy is what this describes, not the country's — the dataset screen is
   * where every unit lives, and a page of provinces reading `0` would bury the
   * three that matter.
   *
   * Counting rules, all of which the tests pin:
   *
   *   - a place is counted **once**, under exactly one commune, and only when
   *     it is groupable (see `groupablePredicate`);
   *   - a province's total is the sum of its communes' totals, because both
   *     come from the same predicate over the same rows;
   *   - everything else is `review`, split by why. A review row whose stored
   *     province is a current unit is reported against that province as well,
   *     which is a **subset** of `review.total` and never added to `placeCount`;
   *   - archived places are outside all of it unless `status=archived` asked
   *     for them, and every other filter applies exactly as it does to the list.
   *
   * Two queries per level and no N+1: one `group by` over `places`, and one
   * batched name lookup for the codes that came back.
   */
  async administrativeSummary(
    filter: PlaceFilter & { provinceCode?: string | undefined },
  ): Promise<AdministrativeSummary> {
    const dataset = await activeDataset(this.db);

    /**
     * A province the caller named has to exist before anything is counted
     * under it. Answering with empty communes would read as "this province has
     * no places", which is a different fact from "there is no such province".
     */
    let province: { code: string; name: string } | null = null;
    if (filter.provinceCode) {
      const unit = dataset
        ? await currentUnit(this.db, dataset.id, filter.provinceCode, 'PROVINCE')
        : null;
      if (!unit) {
        throw AppError.badRequest('ADMINISTRATIVE_UNIT_NOT_CURRENT', 'Không có tỉnh/thành này', [
          {
            field: 'provinceCode',
            code: 'not_current',
            message: filter.provinceCode,
          },
        ]);
      }
      province = { code: unit.code, name: unit.fullName };
    }

    // The filters the caller sent, minus the administrative ones: this endpoint
    // computes both sides of that split rather than being told one of them.
    const base = {
      ...filter,
      provinceCode: undefined,
      communeCode: undefined,
      administrativeState: undefined,
    };
    const scope = (extra: SQL[]) => {
      const where = [...this.placePredicates(base, dataset), ...extra];
      return sql.join(where, sql` and `);
    };

    const level = province ? ('commune' as const) : ('province' as const);
    const groupable = dataset ? groupablePredicate(dataset.id) : sql`false`;
    const inProvince = province ? [sql`p.province_code = ${province.code}`] : [];

    const unitColumn = level === 'commune' ? sql`p.commune_code` : sql`p.province_code`;
    const counted = await this.db.execute(sql`
      select ${unitColumn} as code, count(*)::int as place_count
      from places p
      where ${scope([groupable, ...inProvince])}
      group by ${unitColumn}
    `);
    const rows = counted.rows as { code: string; place_count: number }[];

    /**
     * Review, and where it can honestly be filed.
     *
     * `bucket` names the four mapping statuses that are not groupable plus
     * `INVALID_HIERARCHY`, which is the case a status alone cannot express: a
     * place `AUTO_MATCHED` against a commune that has since been dissolved, or
     * whose parent is no longer the province the place stores. Reporting that
     * as `AUTO_MATCHED` would say the mapping is fine and the count is wrong.
     */
    const reviewed = await this.db.execute(sql`
      select
        case
          when p.administrative_mapping_status in ('UNMAPPED','NEEDS_REVIEW','REJECTED','STALE')
            then p.administrative_mapping_status::text
          else 'INVALID_HIERARCHY'
        end as bucket,
        case
          when ${dataset ? attributableProvincePredicate(dataset.id) : sql`false`}
            then p.province_code
          else null
        end as province_code,
        count(*)::int as n
      from places p
      where ${scope([sql`not ${groupable}`, ...inProvince])}
      group by 1, 2
    `);
    const reviewRows = reviewed.rows as {
      bucket: string;
      province_code: string | null;
      n: number;
    }[];

    const names = dataset
      ? await unitNames(
          this.db,
          dataset.id,
          rows.map((r) => r.code),
        )
      : new Map<string, string>();

    const reviewByProvince = new Map<string, number>();
    const byStatus: Record<string, number> = {};
    let reviewTotal = 0;
    for (const row of reviewRows) {
      byStatus[row.bucket] = (byStatus[row.bucket] ?? 0) + row.n;
      reviewTotal += row.n;
      if (row.province_code) {
        reviewByProvince.set(
          row.province_code,
          (reviewByProvince.get(row.province_code) ?? 0) + row.n,
        );
      }
    }

    const levelKey = level === 'commune' ? 'COMMUNE' : 'PROVINCE';
    const units = rows
      .map((row) => ({
        code: row.code,
        name: names.get(`${levelKey}:${row.code}`) ?? null,
        placeCount: row.place_count,
        // A commune row carries no review count: a place whose mapping is under
        // review has no commune anyone should trust it under.
        reviewCount: level === 'province' ? (reviewByProvince.get(row.code) ?? 0) : null,
      }))
      .sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code, 'vi'));

    /**
     * Province rows only list units that hold a groupable place, so a province
     * whose every place is under review would otherwise vanish along with its
     * review count. It is added back with `placeCount: 0`, which is the honest
     * shape: nothing grouped here yet, and this much waiting.
     */
    if (level === 'province') {
      const listed = new Set(units.map((u) => u.code));
      for (const [code, count] of reviewByProvince) {
        if (listed.has(code)) continue;
        units.push({
          code,
          name: names.get(`PROVINCE:${code}`) ?? null,
          placeCount: 0,
          reviewCount: count,
        });
      }
      // The names for provinces that arrived only through the review bucket
      // were not in the first lookup; resolve them in one more batched read.
      const missing = units.filter((u) => u.name === null).map((u) => u.code);
      if (dataset && missing.length > 0) {
        const extra = await unitNames(this.db, dataset.id, missing);
        for (const unit of units) {
          if (unit.name === null) unit.name = extra.get(`PROVINCE:${unit.code}`) ?? null;
        }
      }
      units.sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code, 'vi'));
    }

    return {
      datasetVersion: dataset?.combinedDatasetVersion ?? null,
      level,
      province,
      units,
      totals: {
        grouped: rows.reduce((sum, row) => sum + row.place_count, 0),
        review: reviewTotal,
      },
      review: {
        byStatus: {
          UNMAPPED: byStatus.UNMAPPED ?? 0,
          NEEDS_REVIEW: byStatus.NEEDS_REVIEW ?? 0,
          REJECTED: byStatus.REJECTED ?? 0,
          STALE: byStatus.STALE ?? 0,
          INVALID_HIERARCHY: byStatus.INVALID_HIERARCHY ?? 0,
        },
      },
    };
  }

  /**
   * BE-IMP-009 — the record the CMS place editor loads.
   *
   * Everything `updatePlace` accepts, plus the facts rendered around the form.
   * The list endpoint is not a substitute: it is a keyset-paged index and
   * carries none of this on purpose.
   *
   * Ratings stay apart. `places.rating` is the provider's figure and GoGo's is
   * derived from published reviews; averaging them would produce a number that
   * describes neither, and FR-INGEST-006 requires them stored and shown
   * separately. The composite/Bayesian score that spec also describes is not
   * computed anywhere yet, so it is absent rather than faked.
   */
  async getPlace(placeId: string) {
    const [row] = (
      await this.db.execute(sql`
        select p.id, p.name, p.description, p.status, p.address_text, p.area_key,
               p.city, p.district,
               -- ADM-016: the canonical administrative identity, as stored.
               p.province_code, p.commune_code, p.administrative_mapping_status,
               p.administrative_mapping_source, p.administrative_dataset_version,
               p.administrative_mapped_at,
               ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
               p.phone, p.website, p.rating, p.rating_count, p.price_level,
               p.avg_visit_minutes, p.suitability, p.is_lodging, p.confidence,
               p.curated_rank, p.freshness_checked_at, p.created_at, p.updated_at,
               -- #425 — per-field origin, read here rather than as an eighth
               -- parallel query: DB_POOL_MAX defaults to 10 and this endpoint
               -- already checks out six connections at once, so one more turned
               -- a busy moment into a connect timeout. It is a handful of rows
               -- on the same key, so it costs nothing to carry along.
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'field', fp.field, 'source_type', fp.source_type,
                   'source_reference', fp.source_reference,
                   'verified_at', fp.verified_at))
                 from place_field_provenance fp where fp.place_id = p.id
               ), '[]'::jsonb) as provenance
        from places p
        where p.id = ${placeId}::uuid
      `)
    ).rows as PlaceDetailRow[];
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    const [taxonomies, hours, prices, sources, media, gogo] = await Promise.all([
      this.db.execute(sql`
        select t.id, t.kind, t.key
        from place_taxonomies pt
        join taxonomies t on t.id = pt.taxonomy_id
        where pt.place_id = ${placeId}::uuid
        order by t.kind, t.key
      `),
      this.db.execute(sql`
        select day_of_week, entry_kind, open_minute, close_minute, is_overnight, source, verified_at
        from place_hours where place_id = ${placeId}::uuid
        order by day_of_week, entry_kind, open_minute
      `),
      this.db.execute(sql`
        select id, price_min, price_max, currency, unit, source, confidence, verified_at, created_at
        from place_prices where place_id = ${placeId}::uuid
        order by created_at desc
      `),
      // #334: both provenance tables, deduped — see `googleProvenanceRows`.
      this.db.execute(sql`
        select * from (${googleProvenanceRows(sql`${placeId}::uuid`, this.unifiedProvenance)}) src
        order by src.fetched_at desc nulls last
      `),
      this.db.execute(sql`
        select id, storage_key, width, height, sort_order, moderation,
               moderation_reason, caption, attribution, is_cover, source_type,
               created_at
        from place_media where place_id = ${placeId}::uuid
        -- #191: the cover leads, then the editor's order.
        order by is_cover desc, sort_order, created_at
      `),
      this.db.execute(sql`
        select round(avg(rating)::numeric, 2) as rating, count(*)::int as count
        from reviews where place_id = ${placeId}::uuid and status = 'published'
      `),
    ]);

    const gogoRow = gogo.rows[0] as { rating: string | null; count: number } | undefined;

    /**
     * ADM-016 — run after the parallel block, not inside it.
     *
     * `DB_POOL_MAX` defaults to 10 and the `Promise.all` above already checks
     * out six connections; adding a seventh turned a busy moment into a connect
     * timeout once already (#425). This is two indexed queries and no resolver
     * work, so it costs less in series than it would in parallel.
     */
    const administrative = await placeAdministrativeSummary(this.db, {
      administrativeMappingStatus: row.administrative_mapping_status,
      provinceCode: row.province_code,
      communeCode: row.commune_code,
      administrativeMappingSource: row.administrative_mapping_source,
      administrativeDatasetVersion: row.administrative_dataset_version,
      administrativeMappedAt: row.administrative_mapped_at,
    });

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      addressText: row.address_text,
      areaKey: row.area_key,
      /**
       * ADR-0016 — legacy free text, returned as it was written. It is not the
       * administrative identity (`administrative` below is), and the console
       * must not render it as a current unit: `district` in particular names a
       * level that was dissolved on 2025-07-01.
       */
      city: row.city,
      district: row.district,
      /** ADM-016 — the two current levels, their names and why publishing is blocked. */
      administrative,
      lat: row.lat !== null ? Number(row.lat) : undefined,
      lng: row.lng !== null ? Number(row.lng) : undefined,
      phone: row.phone,
      website: row.website,
      avgVisitMinutes: row.avg_visit_minutes,
      suitability: row.suitability ?? {},
      isLodging: row.is_lodging,
      curatedRank: row.curated_rank,
      confidence: Number(row.confidence),
      priceLevel: row.price_level,
      ratings: {
        provider: {
          rating: row.rating !== null ? Number(row.rating) : undefined,
          count: row.rating_count,
        },
        gogo: {
          rating: gogoRow?.rating != null ? Number(gogoRow.rating) : undefined,
          count: gogoRow?.count ?? 0,
        },
      },
      taxonomyIds: taxonomies.rows.map((t) => (t as { id: string }).id),
      // Keys travel alongside the ids so a client can label a chip without a
      // second round trip, and still writes back ids.
      taxonomyKeys: taxonomies.rows.map((t) => (t as { key: string }).key),
      hours: hours.rows.map((h) => {
        const r = h as PlaceHoursRow;
        return {
          dayOfWeek: r.day_of_week,
          kind: r.entry_kind,
          openMinute: r.open_minute,
          closeMinute: r.close_minute,
          isOvernight: r.is_overnight,
          source: r.source,
          verifiedAt: toIso(r.verified_at),
        };
      }),
      prices: prices.rows.map((pr) => {
        const r = pr as PlacePriceRow;
        return {
          id: r.id,
          priceMin: Number(r.price_min),
          priceMax: Number(r.price_max),
          currency: r.currency,
          unit: r.unit,
          source: r.source,
          confidence: Number(r.confidence),
          verifiedAt: toIso(r.verified_at),
          createdAt: toIso(r.created_at),
        };
      }),
      sources: sources.rows.map((sr) => {
        const r = sr as PlaceSourceRow;
        return {
          id: r.id,
          provider: r.provider,
          externalId: r.external_id,
          url: r.url,
          // Provider facts carry attribution and a fetch time (FR-INGEST-014).
          attribution: r.attribution,
          fetchedAt: toIso(r.fetched_at),
        };
      }),
      media: media.rows.map((m) => {
        const r = m as PlaceMediaRow;
        return {
          id: r.id,
          storageKey: r.storage_key,
          /**
           * #191 — the console could list a key and never show the picture.
           * Deciding on a photo without seeing it is not moderation. Null when
           * media hosting is not configured here, which the console renders as
           * "not available in this environment" rather than a broken image.
           */
          url: this.mediaUrl(r.storage_key),
          width: r.width,
          height: r.height,
          sortOrder: r.sort_order,
          moderation: r.moderation,
          moderationReason: r.moderation_reason,
          caption: r.caption,
          // FR-INGEST-014: a provider photo keeps its terms even after an
          // editor has reordered the list it sits in.
          attribution: r.attribution,
          isCover: r.is_cover,
          sourceType: r.source_type,
          createdAt: toIso(r.created_at),
        };
      }),
      /**
       * Per-field origin, keyed by the API's field name rather than the
       * column's, so the console does not have to know the schema. A field
       * missing from this map has no recorded origin — which the UI must say
       * in words rather than defaulting it to "GoGo".
       */
      provenance: Object.fromEntries(
        (row.provenance ?? []).map((pv) => {
          const r = pv as PlaceProvenanceRow;
          return [
            API_FIELD_OF[r.field] ?? r.field,
            {
              sourceType: r.source_type,
              sourceReference: r.source_reference,
              verifiedAt: toIso(r.verified_at),
            },
          ];
        }),
      ),
      freshnessCheckedAt: toIso(row.freshness_checked_at),
      createdAt: toIso(row.created_at)!,
      updatedAt: toIso(row.updated_at)!,
    };
  }

  /**
   * BE-CMS-PE-001 (#425) — the editor's save.
   *
   * Three things happen here that did not before: a stale form is refused
   * rather than allowed to win, contact values are normalized before they are
   * stored, and every field the editor wrote gets an origin recorded against
   * it. The last one is what makes a later provider refresh safe: it can see
   * that a human owns this phone number and leave it alone.
   */
  /**
   * GoGo-BE#452 — the third way a place can enter the catalogue.
   *
   * There were two before, and neither is a person typing what they know:
   * bulk import resolves rows against a provider, and a community submission
   * arrives from the app for review. An editor holding a menu and a phone
   * number had nowhere to put it, so the CMS shipped its "Thêm địa điểm"
   * button visibly disabled (GoGo-CMS#128).
   *
   * Created as `draft`, never `published`: entering the catalogue and being
   * visible are separate decisions, and the existing status workflow already
   * owns the second one.
   *
   * Nothing here touches provider data. Every field is the editor's own claim
   * and is recorded `editorial`, the same as a typed edit — copying a value off
   * a provider preview does not transfer ownership
   * (`GOGO_PRODUCT_DATA_ARCHITECTURE.md`).
   */
  async createPlace(adminId: string, input: PlaceCreateInput) {
    const contact = this.normalizeContact(input);

    /**
     * #465 — identity beats similarity. When the editor arrived by link, the
     * catalogue already knows whether that Google record belongs to a place,
     * and answering "you already have this, here it is" is both cheaper and
     * more useful than the fuzzy 150 m / 0.5-similarity answer below, which
     * would miss it outright for a place that moved or was renamed.
     *
     * `allowDuplicate` does not open this gate. Two GoGo places may legitimately
     * share a name and a street corner; they may not share one Google record —
     * `place_sources_provider_external_unique` would reject the second insert
     * anyway, and a 409 naming the existing place beats a constraint violation.
     */
    if (input.googlePlaceId !== undefined) {
      const identity = await this.dedup.resolveGoogleIdentity(input.googlePlaceId);
      if (identity.kind === 'CONFLICT') {
        throw AppError.conflict(
          'PLACE_IDENTITY_CONFLICT',
          'Google ID này đang bị hai địa điểm cùng nhận — cần gộp trước khi thêm mới',
          identity.placeIds.map((id) => ({
            field: 'googlePlaceId',
            code: 'conflict',
            message: id,
          })),
        );
      }
      if (identity.kind !== 'NONE') {
        throw AppError.conflict(
          'PLACE_ALREADY_LINKED',
          'GoGo đã có địa điểm gắn với link Google này',
          [{ field: 'googlePlaceId', code: 'already_linked', message: identity.placeId }],
        );
      }
    }

    /**
     * Same rule the duplicate queue uses — 150 m apart and a name similarity
     * over 0.5 — applied before the row exists rather than after. A near-copy
     * of a place already in the catalogue is the failure mode of manual entry,
     * and finding it later means merging two histories instead of one.
     *
     * `allowDuplicate` is how an editor says "I looked, they are different
     * places": two cafés of the same chain on one street are real.
     */
    if (!input.allowDuplicate) {
      const normalized = normalizeVietnamese(input.name);
      const { rows } = await this.db.execute(sql`
        select id, name, status,
          similarity(name_normalized, ${normalized}) as name_similarity,
          ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography) as distance_m
        from places
        where status <> 'archived'
          and ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography, 150)
          and similarity(name_normalized, ${normalized}) > 0.5
        order by name_similarity desc
        limit 5
      `);
      if (rows.length > 0) {
        throw AppError.conflict(
          'PLACE_DUPLICATE_SUSPECTED',
          'Địa điểm này có thể đã có trong danh mục',
          rows.map((row) => ({
            field: 'name',
            code: 'duplicate_candidate',
            message: `${String(row.name)} (${Math.round(Number(row.distance_m))}m)`,
          })),
        );
      }
    }

    // `lat` and `lng` both name `geom`, so the pair collapses to one row.
    const claimed = [
      ...new Set(
        Object.keys(input)
          .filter((key) => PROVENANCE_COLUMN[key] !== undefined)
          .map((key) => PROVENANCE_COLUMN[key]!),
      ),
    ];
    const derived = new Set(
      input.googlePlaceId === undefined
        ? []
        : (input.googleDerivedFields ?? []).map((key) => PROVENANCE_COLUMN[key]!),
    );

    const codes = {
      provinceCode: input.provinceCode ?? null,
      communeCode: input.communeCode ?? null,
    };
    const codesAsserted = codes.provinceCode !== null || codes.communeCode !== null;

    /**
     * PI-BE-021 — the provider facts, fetched **before** the transaction opens.
     *
     * A place created from a link used to store its Google id and nothing else,
     * so `GET /cms/places/{id}` came back with no rating, no review count, no
     * opening hours and no canonical Google link — the exact facts the editor
     * had just been shown in the preview, missing from the row that preview
     * created.
     *
     * They are fetched here rather than carried from the resolve because
     * ADR-0006 §9.5 forbids the server holding provider content across
     * requests: there is no snapshot to replay, deliberately. This is the same
     * argument, and the same code path, as `createDraftFromSubmission` — the
     * approve step re-verifies for the identical reason.
     *
     * Outside the transaction so that a slow or unreachable provider cannot
     * hold a write lock on `places` open, and `null` on failure so that Google
     * being down costs the editor the enrichment rather than the whole form.
     */
    const provider =
      input.googlePlaceId === undefined
        ? null
        : await this.providerSnapshot(input.googlePlaceId, input.areaKey ?? null);

    let mappingWrite: PersistResult | null = null;
    const created = await this.db.transaction(async (tx) => {
      /**
       * ADM-016 — validated against the dataset that is published *now*, inside
       * the transaction that stores the codes.
       *
       * Two different answers when there is no published dataset, and the
       * difference is whether the request claimed anything. An editor who chose
       * a province and a commune is asserting a fact, and there is nothing to
       * check it against, so the honest answer is 503 rather than storing an
       * unvalidated claim. An editor who chose neither is not asserting
       * anything — the place is created `UNMAPPED`, which already blocks
       * publication, and a fresh environment keeps working.
       */
      const dataset: DatasetRef | null = codesAsserted
        ? await requireActiveDataset(tx)
        : await activeDataset(tx);
      if (codesAsserted) await assertCurrentPair(tx, dataset!, codes);

      const [place] = await tx
        .insert(schema.places)
        .values({
          name: input.name,
          // The database trigger owns this column; every other writer passes
          // the same placeholder rather than normalising twice.
          nameNormalized: 'set-by-trigger',
          status: 'draft',
          geom: { x: input.lng, y: input.lat },
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
          ...(input.areaKey !== undefined ? { areaKey: input.areaKey } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.district !== undefined ? { district: input.district } : {}),
          ...(contact.phone !== undefined ? { phone: contact.phone } : {}),
          ...(contact.website !== undefined ? { website: contact.website } : {}),
          ...(input.avgVisitMinutes !== undefined
            ? { avgVisitMinutes: input.avgVisitMinutes }
            : {}),
          ...(input.suitability !== undefined ? { suitability: input.suitability } : {}),
          ...(input.isLodging !== undefined ? { isLodging: input.isLodging } : {}),
          ...(input.curatedRank !== undefined ? { curatedRank: input.curatedRank } : {}),
          /**
           * PI-BE-021 — provider aggregates, written as the provider's own
           * figures and nothing else.
           *
           * `places.rating` has always meant "the provider's rating"; the
           * console renders it beside GoGo's own and never averages the two
           * (FR-INGEST-006). Storing it here does not make it a GoGo fact —
           * `GOGO_PRODUCT_DATA_ARCHITECTURE.md` is explicit that copying never
           * transfers ownership — and nothing in the recommendation pipeline
           * reads it as one. See `docs/adr/0020-*`.
           *
           * An editor cannot type these: they come from the provider answer
           * this request made, not from the request body, so there is no path
           * by which a person's number is stored wearing Google's attribution.
           */
          ...(provider
            ? {
                rating:
                  provider.details.rating !== null ? provider.details.rating.toFixed(2) : null,
                ratingCount: provider.details.ratingCount,
                priceLevel: provider.details.priceLevel,
                freshnessCheckedAt: new Date(),
              }
            : {}),
        })
        .returning();

      /**
       * PI-BE-021 — the week, in GoGo's representation.
       *
       * `entry_kind` is left at its `interval` default: the adapter only ever
       * produces spans, and inventing `closed` for a day Google did not
       * mention would assert a fact nobody supplied. A day with no period
       * simply has no row, which is what "unknown is the absence of a row"
       * means on this table.
       */
      if (provider && provider.details.hours.length > 0) {
        await tx.insert(schema.placeHours).values(
          provider.details.hours.map((h) => ({
            placeId: place!.id,
            dayOfWeek: h.dayOfWeek,
            openMinute: h.openMinute,
            closeMinute: h.closeMinute,
            isOvernight: h.isOvernight,
            source: 'provider' as const,
            verifiedAt: new Date(),
          })),
        );
      }

      if (input.taxonomyIds && input.taxonomyIds.length > 0) {
        await tx
          .insert(schema.placeTaxonomies)
          .values(input.taxonomyIds.map((taxonomyId) => ({ placeId: place!.id, taxonomyId })))
          .onConflictDoNothing();
      }

      /**
       * The link is what puts the place inside provider dedup. Written in the
       * same transaction as the row it identifies, so a failure after the
       * insert cannot leave a place claiming a Google id nothing recorded — or
       * a `place_sources` row pointing at a place that does not exist.
       */
      if (input.googlePlaceId !== undefined) {
        await tx.insert(schema.placeSources).values({
          placeId: place!.id,
          provider: 'google',
          externalId: input.googlePlaceId,
        });
      }

      /**
       * A value the editor typed is their own claim and is recorded
       * `editorial` — including one they read off the preview and retyped,
       * because GOGO_PRODUCT_DATA_ARCHITECTURE.md is explicit that copying does
       * not transfer ownership. A value *applied* from the preview and left
       * alone is `google_derived`, which is the case this enum member was
       * reserved for, and it carries the Google id as its reference so a later
       * refresh knows which fields it may overwrite without arguing with a
       * person.
       */
      if (claimed.length > 0) {
        await tx.insert(schema.placeFieldProvenance).values(
          claimed.map((field) => {
            const fromGoogle = derived.has(field);
            return {
              placeId: place!.id,
              field,
              sourceType: fromGoogle ? ('google_derived' as const) : ('editorial' as const),
              sourceReference: fromGoogle ? input.googlePlaceId! : null,
              actorId: adminId,
            };
          }),
        );
      }

      /**
       * The mapping is written in the transaction that wrote the place.
       *
       * The editor's codes go in as `trustedCodes`, which is evidence and not
       * an instruction: they are weighed against the geometry the same request
       * supplied, and two sources naming different communes produce
       * `NEEDS_REVIEW` rather than whichever one the code happened to trust. A
       * place with no codes still resolves — from its own position — which is
       * how a place created by hand stops being invisible to the queue.
       */
      if (dataset) {
        const resolution = await this.resolver.resolvePlaceWithin(tx, place!.id, {
          ...(codesAsserted ? { trustedCodes: codes } : {}),
        });
        mappingWrite = await this.resolver.persistWithin(tx, resolution, {
          actor: { id: adminId, type: 'admin' },
        });
      }

      await writeOutbox(tx, {
        eventType: 'place.created',
        resourceType: 'place',
        resourceId: place!.id,
        payload: {
          status: 'draft',
          origin: input.googlePlaceId !== undefined ? 'cms_link' : 'cms_manual',
        },
      });

      return place!;
    });

    // Counted only now: the write is real once the transaction that made it
    // has committed.
    if (mappingWrite) this.resolver.countPersist(mappingWrite);

    /**
     * PI-BE-021 — the canonical Google link, the aggregates and the fetch tier,
     * on the row that owns provider provenance.
     *
     * After the transaction, not inside it: `upsertProviderSource` writes
     * through the pool and keys on `(provider, external_id)`, so running it in
     * the transaction would either need a second executor or a signature change
     * across every caller. A failure here leaves a place that holds its Google
     * identity (`place_sources`, written in the transaction) without the
     * provider snapshot — which is exactly the state every place created before
     * this change is in, and the refresh job repairs it.
     *
     * `provider_uri` is what makes Place Detail able to open the place in
     * Google Maps: it is the URI Google published, never the short link the
     * editor pasted.
     */
    if (provider) {
      await this.dedup.upsertProviderSource({
        placeId: created.id,
        details: provider.details,
        derivedScore: provider.score,
        fetchTier: provider.details.fetchTier,
      });
    }

    await this.audit(adminId, 'place.created', created.id, {
      name: created.name,
      status: created.status,
      claimedFields: claimed,
      allowDuplicate: input.allowDuplicate === true,
      ...(input.googlePlaceId !== undefined
        ? {
            googlePlaceId: input.googlePlaceId,
            googleDerivedFields: [...derived],
            // Whether the row carries provider facts, and why not when it does
            // not. An audit line that only said "created from a link" could not
            // tell a missing rating from a provider outage.
            providerSnapshot: provider ? 'applied' : 'absent',
          }
        : {}),
    });

    return this.getPlace(created.id);
  }

  /**
   * PI-BE-021 — one `quality` Details call for a place being created from a
   * link, or `null` and a reason.
   *
   * `quality` because that is the tier whose mask carries the fields this
   * write needs — `rating`, `userRatingCount`, `regularOpeningHours`,
   * `priceLevel` — and because it is the tier the preview the editor just saw
   * was fetched at. Asking for `core` here would store a place whose rating
   * the console had already shown and the row does not have.
   *
   * **Nothing throws.** Three failures are possible and all of them mean the
   * same thing to the editor: the place is created, without provider facts.
   *
   *   - the provider is down, misconfigured or out of quota — losing a
   *     completed form to Google's availability is a worse answer than a row
   *     that the refresh job will fill in later;
   *   - Google has never heard of the id;
   *   - Google answered about a *different* id, because the place moved or was
   *     merged (#334). That answer describes a different Place ID than the one
   *     `place_sources` is about to store, and writing it would file one
   *     place's rating under another's identity. It is dropped and counted;
   *     `PlaceRefreshService` owns relocation.
   *
   * Each outcome is counted separately, because "no rating on this place" and
   * "Google was unreachable for an hour" look identical in the data and are
   * not the same operational fact.
   */
  private async providerSnapshot(
    googlePlaceId: string,
    areaKey: string | null,
  ): Promise<{ details: ResolvedProviderPlace; score: number } | null> {
    const count = (result: string) =>
      this.metrics?.increment('cms_place_create_provider_enrichment_total', { result });
    let outcome;
    try {
      outcome = await this.providerResolver.resolveByProviderId(googlePlaceId, 'quality');
    } catch {
      count('unavailable');
      return null;
    }
    if (outcome.status !== 'RESOLVED') {
      count(outcome.status === 'UNRESOLVED' ? 'not_found' : 'undecided');
      return null;
    }
    if (outcome.details.providerPlaceId !== googlePlaceId) {
      count('moved');
      return null;
    }
    const score = await this.providerResolver.scoreFor(outcome.details, areaKey, null);
    count('applied');
    return { details: outcome.details, score };
  }

  /**
   * Phone and website are stored normalised, and a bad one is reported against
   * its own field so the console can point at the box rather than raise a
   * toast. Shared by create and update because a value typed into either form
   * has to end up in the same shape.
   */
  private normalizeContact(input: {
    phone?: string | null | undefined;
    website?: string | null | undefined;
  }): { phone?: string | null | undefined; website?: string | null | undefined } {
    const fieldErrors: { field: string; code: string; message: string }[] = [];
    const out: { phone?: string | null; website?: string | null } = {};

    if (input.phone !== undefined) {
      if (input.phone === null) out.phone = null;
      else {
        const result = normalizePhone(input.phone);
        if (result.ok) out.phone = result.value;
        else fieldErrors.push(result.issue);
      }
    }
    if (input.website !== undefined) {
      if (input.website === null) out.website = null;
      else {
        const result = normalizeWebsite(input.website);
        if (result.ok) out.website = result.value;
        else fieldErrors.push(result.issue);
      }
    }
    if (fieldErrors.length > 0) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', fieldErrors);
    }
    return out;
  }

  async updatePlace(adminId: string, placeId: string, input: PlaceEditInput) {
    const [before] = await this.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!before) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    assertNotStale(before.updatedAt, input.expectedUpdatedAt);

    // `lat` and `lng` both name `geom`, so the pair collapses to one row.
    const claimed = [
      ...new Set(
        Object.keys(input)
          .filter((key) => PROVENANCE_COLUMN[key] !== undefined)
          .map((key) => PROVENANCE_COLUMN[key]!),
      ),
    ];

    const { phone, website } = this.normalizeContact(input);

    /**
     * ADM-016 — what the edit says about the administrative identity.
     *
     * The pair is read as a pair: an absent key means "leave it alone", so the
     * stored value stands in for it. That is what makes a console sending only
     * `communeCode` a cross-province error rather than a silent half-write.
     */
    const codesAsserted = input.provinceCode !== undefined || input.communeCode !== undefined;
    const codes = {
      provinceCode:
        input.provinceCode !== undefined ? (input.provinceCode ?? null) : before.provinceCode,
      communeCode:
        input.communeCode !== undefined ? (input.communeCode ?? null) : before.communeCode,
    };
    const geometryMoved =
      input.lat !== undefined &&
      input.lng !== undefined &&
      (before.geom === null || before.geom.x !== input.lng || before.geom.y !== input.lat);
    // ADR-0019 §7b — `city` and `district` are not resolver inputs any more, so
    // editing them cannot change the answer and must not buy a re-resolve.
    const material = isMaterialForMapping({ geometryMoved, codesAsserted });
    let mappingWrite: PersistResult | null = null;

    /**
     * One transaction for the whole save.
     *
     * Four writes make up an edit — the travel-cache invalidation, the row
     * itself, the taxonomy links, the provenance claims — and before this they
     * ran independently. A failure between any two left a place whose
     * taxonomies had been deleted and not re-inserted, or whose new phone
     * number carried no record of who wrote it, with nothing to say so.
     *
     * `invalidateTravelOnMove` takes a `Pick<Db, 'execute'>`, so it joins the
     * transaction rather than deleting cached legs for a move that then rolls
     * back.
     */
    const after = await this.db.transaction(async (tx) => {
      // #339 — an editor dragging a pin across town invalidates every cached
      // travel time to and from this place, and every live plan built on them.
      // Measured before the write, because afterwards there is nothing to
      // measure against.
      if (input.lat !== undefined && input.lng !== undefined) {
        await invalidateTravelOnMove(tx, placeId, { lat: input.lat, lng: input.lng });
      }

      // Re-read inside the transaction that will store them: a dataset can
      // publish between the console loading the form and this running.
      const dataset: DatasetRef | null = codesAsserted
        ? await requireActiveDataset(tx)
        : await activeDataset(tx);
      if (codesAsserted) await assertCurrentPair(tx, dataset!, codes);

      const [row] = await tx
        .update(schema.places)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
          ...(input.areaKey !== undefined ? { areaKey: input.areaKey } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.district !== undefined ? { district: input.district } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(website !== undefined ? { website } : {}),
          ...(input.lat !== undefined && input.lng !== undefined
            ? { geom: { x: input.lng, y: input.lat } }
            : {}),
          ...(input.avgVisitMinutes !== undefined
            ? { avgVisitMinutes: input.avgVisitMinutes }
            : {}),
          ...(input.suitability !== undefined ? { suitability: input.suitability } : {}),
          ...(input.isLodging !== undefined ? { isLodging: input.isLodging } : {}),
          ...(input.curatedRank !== undefined ? { curatedRank: input.curatedRank } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.places.id, placeId))
        .returning();

      if (input.taxonomyIds) {
        await tx.delete(schema.placeTaxonomies).where(eq(schema.placeTaxonomies.placeId, placeId));
        if (input.taxonomyIds.length > 0) {
          await tx
            .insert(schema.placeTaxonomies)
            .values(input.taxonomyIds.map((taxonomyId) => ({ placeId, taxonomyId })))
            .onConflictDoNothing();
        }
      }

      /**
       * A value typed into this form is the editor's own claim, so it is
       * recorded `editorial` — including a value they read off a provider
       * preview and retyped. GOGO_PRODUCT_DATA_ARCHITECTURE.md is explicit that
       * copying does not transfer ownership, which is why applying a field
       * *from* a preview is a separate, currently-blocked path that writes
       * `google_derived` instead. This endpoint never sets that.
       */

      if (claimed.length > 0) {
        await tx
          .insert(schema.placeFieldProvenance)
          .values(
            claimed.map((field) => ({
              placeId,
              field,
              sourceType: 'editorial' as const,
              sourceReference: null,
              actorId: adminId,
            })),
          )
          .onConflictDoUpdate({
            target: [schema.placeFieldProvenance.placeId, schema.placeFieldProvenance.field],
            set: {
              sourceType: sql`'editorial'::field_source_type`,
              sourceReference: sql`null`,
              actorId: adminId,
              verifiedAt: sql`now()`,
              updatedAt: sql`now()`,
            },
          });
      }

      if (material && dataset) {
        mappingWrite = await this.settleMapping(tx, adminId, before, row!, {
          codes,
          codesAsserted,
        });
      }

      return row!;
    });

    if (mappingWrite) this.resolver.countPersist(mappingWrite);

    // FR-CMS-008: before/after diff of the sensitive write.
    await this.audit(adminId, 'place.updated', placeId, {
      before: { name: before.name, status: before.status },
      changed: Object.keys(input).filter((key) => key !== 'expectedUpdatedAt'),
      claimedFields: claimed,
    });
    return { id: after.id, status: after.status, updatedAt: after.updatedAt.toISOString() };
  }

  /**
   * ADM-016 / ADR-0019 §7 — what this edit does to the mapping the place
   * already carries.
   *
   * Three outcomes, decided by `editPolicyFor`, and the reason they are three
   * is that editing a place is not moderating it. An editor who drags a pin has
   * not ruled on an administrative question — but they can make somebody else's
   * ruling untrue, and a published place claiming a commune it is no longer in
   * is the failure this exists to prevent.
   *
   * Every branch runs in the caller's transaction, against the row the update
   * has already written.
   */
  private async settleMapping(
    tx: Executor,
    adminId: string,
    before: typeof schema.places.$inferSelect,
    after: typeof schema.places.$inferSelect,
    selection: {
      codes: { provinceCode: string | null; communeCode: string | null };
      codesAsserted: boolean;
    },
  ): Promise<PersistResult | null> {
    const policy = editPolicyFor(before.administrativeMappingStatus);
    const trusted = selection.codesAsserted ? { trustedCodes: selection.codes } : {};

    // A rejection is a judgement that this place should not carry this mapping.
    // An edit is not an appeal against it; the rematch in moderation is.
    if (policy === 'PROTECTED') return null;

    if (policy === 'RESOLVE') {
      const resolution = await this.resolver.resolvePlaceWithin(tx, after.id, trusted);
      return this.resolver.persistWithin(tx, resolution, {
        actor: { id: adminId, type: 'admin' },
      });
    }

    /**
     * `VERIFIED`. The stored mapping is a person's decision, so it is never
     * re-pointed here — but it can be contradicted, and the resolver has to be
     * asked without being told what the answer already is.
     *
     * `NO_MAPPING` is what does that: `adjudicate` answers `REVIEWER_OWNED` and
     * weighs nothing at all when it is handed a verified current state, which
     * is exactly right for a write path and useless for a question. Passing a
     * blank current state asks the machine what it would say about this place if
     * nobody had ever decided — the only form of the question that can
     * contradict anything.
     */
    const machine = await this.resolver.resolveGeometry(
      {
        subjectId: after.id,
        geometry: after.geom ? { lng: after.geom.x, lat: after.geom.y } : null,
      },
      { executor: tx, ...trusted },
    );
    if (
      contradictsStoredMapping(
        { provinceCode: before.provinceCode, communeCode: before.communeCode },
        machine,
      )
    ) {
      await this.resolver.markStaleWithin(tx, after.id, {
        reason: 'PLACE_EDITED_AWAY_FROM_VERIFIED_MAPPING',
        actor: { id: adminId, type: 'admin' },
        proposal: machine,
      });
    }
    return null;
  }

  /**
   * ADM-009 (#462) / ADR-0019 §7 — the authoritative place state transition,
   * and therefore where the approval policy lives.
   *
   * It is one transaction now, and it was not before. Publishing a place is the
   * moment its administrative mapping has to be true, and a policy checked
   * before the transaction is a policy a concurrent dataset publication, a
   * mapping rejection or another reviewer can invalidate between the check and
   * the write. So the place is locked, the mapping is re-read, the *active*
   * dataset is re-read, and the commune is re-resolved against it — all inside
   * the transaction that flips the status.
   *
   * The gate applies to every transition **into** `published`, including
   * `suspended → published`: restoring a place to the catalogue is publishing
   * it, and a mapping that went stale while it was suspended is exactly the
   * case worth catching.
   */
  async transitionPlace(adminId: string, placeId: string, to: PlaceStatus) {
    const from = await this.db.transaction(async (tx) => {
      const [place] = await tx
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, placeId))
        .limit(1)
        .for('update');
      if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
      if (!PLACE_TRANSITIONS[place.status].includes(to)) {
        throw AppError.conflict(
          'INVALID_PLACE_TRANSITION',
          `${place.status} → ${to} is not allowed`,
        );
      }
      // ADM-009 (#462): the shared invariant, not a copy of it. Three modules
      // publish places and a policy written twice is a policy that drifts.
      if (to === 'published') await assertPlaceApprovable(tx, place, this.metrics);

      await tx
        .update(schema.places)
        .set({ status: to, updatedAt: sql`now()` })
        .where(eq(schema.places.id, placeId));
      return place.status;
    });
    await this.audit(adminId, 'place.status_changed', placeId, { from, to });
    return { id: placeId, status: to };
  }

  /**
   * CMS-003 / #425 — replace the week.
   *
   * Still a whole-week replace: a partial update would need a row identity the
   * editor does not have, and "these are this place's hours" is the statement
   * the console is actually making. What changed is what a row may say — a day
   * can now be `closed` or `open_24h` rather than encoding both as an absence
   * — and who is credited for it.
   *
   * Provenance is not assumed. A row the editor declares `provider` stays
   * provider-sourced and keeps the fetch time of the row it replaces, because
   * confirming what Google said is not the same as having checked it
   * (GOGO_PRODUCT_DATA_ARCHITECTURE.md). Only editor rows stamp `verified_at`,
   * and the place's freshness clock moves only when at least one exists —
   * otherwise re-saving a provider week would look like a verification nobody
   * performed.
   */
  async setHours(
    adminId: string,
    placeId: string,
    hours: HoursWriteEntry[],
    expectedUpdatedAt?: string,
  ) {
    const [place] = await this.db
      .select({ id: schema.places.id, updatedAt: schema.places.updatedAt })
      .from(schema.places)
      .where(eq(schema.places.id, placeId))
      .limit(1);
    if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    assertNotStale(place.updatedAt, expectedUpdatedAt);

    const issues = validateWeek(hours);
    if (issues.length > 0) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', issues);
    }

    const existing = await this.db
      .select()
      .from(schema.placeHours)
      .where(eq(schema.placeHours.placeId, placeId));
    const verifiedBefore = new Map(
      existing.map((row) => [
        `${row.dayOfWeek}|${row.entryKind}|${row.openMinute}|${row.closeMinute}|${row.isOvernight}`,
        row.verifiedAt,
      ]),
    );

    const now = new Date();
    const rows = hours.map((h) => {
      const source = h.source ?? 'editor';
      const key = `${h.dayOfWeek}|${h.kind}|${h.openMinute}|${h.closeMinute}|${h.isOvernight}`;
      return {
        placeId,
        dayOfWeek: h.dayOfWeek,
        entryKind: h.kind,
        openMinute: h.openMinute,
        closeMinute: h.closeMinute,
        isOvernight: h.isOvernight,
        source,
        // A carried-over provider row keeps its fetch time; a provider row
        // that is new here has never been verified by anything GoGo saw.
        verifiedAt: source === 'editor' ? now : (verifiedBefore.get(key) ?? null),
      };
    });
    const editorRows = rows.filter((row) => row.source === 'editor').length;

    await this.db.transaction(async (tx) => {
      await tx.delete(schema.placeHours).where(eq(schema.placeHours.placeId, placeId));
      if (rows.length > 0) await tx.insert(schema.placeHours).values(rows);
      await tx
        .update(schema.places)
        .set({
          ...(editorRows > 0 ? { freshnessCheckedAt: sql`now()` } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.places.id, placeId));
    });
    await this.audit(adminId, 'place.hours_set', placeId, {
      count: rows.length,
      editorRows,
      days: [...new Set(rows.map((row) => row.dayOfWeek))].sort((a, b) => a - b),
    });
    return { updated: true, verified: editorRows > 0 };
  }

  /**
   * BE-CMS-PE-001 (#425) — the `areaKey` vocabulary, with the count of places
   * already filed under each.
   *
   * The count is what makes the list usable rather than merely correct: an
   * editor picking an area wants to know whether they are joining 40 places or
   * inventing a category of one, and a key with zero places is the first sign
   * the catalog and the catalogue have drifted.
   *
   * Keys **not** in `service_areas` but present on places are returned too,
   * flagged `known: false`. They exist — `places.area_key` has never been a
   * foreign key — and hiding them would make a place's own value vanish from
   * the picker that is supposed to show it.
   */
  async listAreas(query: {
    q?: string | undefined;
    city?: string | undefined;
    includeInactive?: boolean | undefined;
  }) {
    const needle = query.q?.trim() ? normalizeVietnamese(query.q.trim()) : null;
    const rows = await this.db.execute(sql`
      with counted as (
        select area_key, count(*)::int as place_count
        from places where area_key is not null group by area_key
      )
      select
        coalesce(sa.key, c.area_key) as key,
        sa.name,
        sa.city,
        sa.is_active,
        sa.sort_order,
        sa.center_lat, sa.center_lng, sa.radius_m,
        coalesce(c.place_count, 0) as place_count,
        (sa.key is not null) as known
      from service_areas sa
      full outer join counted c on c.area_key = sa.key
      where (${query.city ?? null}::text is null or sa.city = ${query.city ?? null})
        and (${query.includeInactive === true} or sa.is_active is not false)
      order by known desc, sa.sort_order nulls last, coalesce(sa.name, c.area_key)
    `);

    type AreaRow = {
      key: string;
      name: string | null;
      city: string | null;
      is_active: boolean | null;
      sort_order: number | null;
      center_lat: number | string | null;
      center_lng: number | string | null;
      radius_m: number | null;
      place_count: number;
      known: boolean;
    };

    const items = (rows.rows as AreaRow[])
      .map((r) => ({
        key: r.key,
        // An unknown key has no curated name; the key itself is the only label
        // that exists, and inventing one would put a display string in data.
        name: r.name,
        city: r.city,
        isActive: r.is_active ?? false,
        known: r.known,
        placeCount: r.place_count,
        centerLat: r.center_lat !== null ? Number(r.center_lat) : null,
        centerLng: r.center_lng !== null ? Number(r.center_lng) : null,
        radiusM: r.radius_m,
      }))
      // Filtered in memory rather than SQL: matching an editor typing "quan 1"
      // against "Quận 1, TP.HCM" needs the same Vietnamese normalization
      // search uses, and that lives in TypeScript.
      .filter((item) =>
        needle === null
          ? true
          : normalizeVietnamese(`${item.name ?? ''} ${item.key}`).includes(needle),
      );

    return { items };
  }

  /** CMS-003 — add a verified price observation. */
  async addPrice(
    adminId: string,
    placeId: string,
    input: {
      priceMin: number;
      priceMax: number;
      unit: 'per_person' | 'per_item' | 'per_hour' | 'per_night';
    },
  ) {
    await this.db.insert(schema.placePrices).values({
      placeId,
      priceMin: input.priceMin,
      priceMax: input.priceMax,
      currency: 'VND',
      unit: input.unit,
      confidence: '0.90',
      source: 'editor',
      verifiedAt: new Date(),
    });
    await this.audit(adminId, 'place.price_added', placeId, input);
    return { added: true };
  }

  async touchFreshness(adminId: string, placeId: string) {
    await this.db
      .update(schema.places)
      .set({ freshnessCheckedAt: sql`now()`, confidence: '0.90', updatedAt: sql`now()` })
      .where(eq(schema.places.id, placeId));
    await this.audit(adminId, 'place.freshness_verified', placeId);
    return { verified: true };
  }

  /** CMS-003 — stale queue: places whose facts haven't been checked recently. */
  async staleQueue(days: number, limit: number) {
    const rows = await this.db.execute(sql`
      select id, name, status, freshness_checked_at
      from places
      where status = 'published'
        and (freshness_checked_at is null or freshness_checked_at < now() - make_interval(days => ${days}))
      order by freshness_checked_at asc nulls first
      limit ${limit}
    `);
    return rows.rows;
  }

  /** CMS-004 — duplicate candidates: same provider id, or near + similar name. */
  async duplicateCandidates(limit: number) {
    const rows = await this.db.execute(sql`
      select a.id as place_a, b.id as place_b, a.name as name_a, b.name as name_b,
        similarity(a.name_normalized, b.name_normalized) as name_similarity,
        ST_Distance(a.geom::geography, b.geom::geography) as distance_m
      from places a
      join places b on a.id < b.id
      where a.status <> 'archived' and b.status <> 'archived'
        and ST_DWithin(a.geom::geography, b.geom::geography, 150)
        and similarity(a.name_normalized, b.name_normalized) > 0.5
      order by name_similarity desc
      limit ${limit}
    `);
    return rows.rows;
  }

  /**
   * CMS-004 — merge: the duplicate's references move to canonical, and the
   * duplicate is archived rather than deleted so the history survives.
   *
   * #334: the list used to stop at five tables, so a merge left the duplicate
   * holding its `place_provider_sources` row — the row dedup resolves a Google
   * Place ID through. The next import of that ID resolved to an archived
   * place, which no reader serves. Hours, taxonomies, plan stops, saved items
   * and travel legs were stranded the same way.
   *
   * Not every table moves the same way, and the differences are deliberate:
   *
   * - `place_provider_sources` moves outright. Its unique index is global on
   *   `(provider, external_id)`, so two places cannot hold the same identity
   *   and this update cannot collide.
   * - `place_taxonomies` and `saved_items` move where the canonical place does
   *   not already have the row, and the leftovers are dropped — a place cannot
   *   carry a category twice, and a user cannot save it twice.
   * - `place_hours` moves only into a canonical place that has none. Two
   *   opening-hour sets for one place is not more information, it is a
   *   contradiction, and the canonical place's own hours are the ones an
   *   editor has been looking at.
   * - `travel_legs` are deleted, not moved. A leg is a cached duration between
   *   two coordinates; carrying the duplicate's over would attribute a travel
   *   time measured from one point to a place that sits at another. They
   *   recompute on demand.
   */
  async mergePlaces(adminId: string, canonicalId: string, duplicateId: string) {
    if (canonicalId === duplicateId) {
      throw AppError.badRequest('INVALID_MERGE', 'Cannot merge a place into itself');
    }
    await this.db.transaction(async (tx) => {
      for (const table of [
        schema.placeSources,
        schema.placeProviderSources,
        schema.placeMedia,
        schema.placePrices,
        schema.reviews,
        schema.roomSeedPlaces,
        schema.planStops,
      ] as const) {
        await tx
          .update(table)
          .set({ placeId: canonicalId } as never)
          .where(eq((table as typeof schema.placeSources).placeId, duplicateId));
      }

      await tx.execute(sql`
        update place_taxonomies pt set place_id = ${canonicalId}::uuid
        where pt.place_id = ${duplicateId}::uuid
          and not exists (
            select 1 from place_taxonomies keep
            where keep.place_id = ${canonicalId}::uuid and keep.taxonomy_id = pt.taxonomy_id
          )
      `);
      await tx.execute(sql`
        delete from place_taxonomies where place_id = ${duplicateId}::uuid
      `);

      await tx.execute(sql`
        update saved_items si set target_id = ${canonicalId}::uuid
        where si.target_type = 'place' and si.target_id = ${duplicateId}::uuid
          and not exists (
            select 1 from saved_items keep
            where keep.user_id = si.user_id and keep.target_type = 'place'
              and keep.target_id = ${canonicalId}::uuid
          )
      `);
      await tx.execute(sql`
        delete from saved_items where target_type = 'place' and target_id = ${duplicateId}::uuid
      `);

      await tx.execute(sql`
        update place_hours set place_id = ${canonicalId}::uuid
        where place_id = ${duplicateId}::uuid
          and not exists (select 1 from place_hours keep where keep.place_id = ${canonicalId}::uuid)
      `);
      await tx.execute(sql`delete from place_hours where place_id = ${duplicateId}::uuid`);

      await tx.execute(sql`
        delete from travel_legs
        where from_place_id = ${duplicateId}::uuid or to_place_id = ${duplicateId}::uuid
      `);

      // A merge is the editorial answer the backfill could not give itself.
      await tx.execute(sql`
        update place_identity_conflicts
        set resolved_at = now(), resolution = 'merged'
        where resolved_at is null
          and ((canonical_place_id = ${canonicalId}::uuid and legacy_place_id = ${duplicateId}::uuid)
            or (canonical_place_id = ${duplicateId}::uuid and legacy_place_id = ${canonicalId}::uuid))
      `);

      await tx
        .update(schema.places)
        .set({ status: 'archived', updatedAt: sql`now()` })
        .where(eq(schema.places.id, duplicateId));
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'place.merged',
        resourceType: 'place',
        resourceId: canonicalId,
        diff: { duplicateId },
      });
      // Both sides changed: one gained the references, the other left the
      // catalogue. Consumers are idempotent (PI-BE-010).
      for (const placeId of [canonicalId, duplicateId]) {
        await writeOutbox(tx, {
          eventType: 'place.updated',
          resourceType: 'place',
          resourceId: placeId,
          payload: { reason: 'merged' },
        });
      }
    });
    return { merged: true, canonicalId };
  }
}
