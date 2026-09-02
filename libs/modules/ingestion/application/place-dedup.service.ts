import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { GOOGLE_PROVIDER } from '../../shared/google-provenance';
import { DB } from '../../shared/tokens';
import { writeOutbox } from '../../shared/outbox';

export type DedupVerdict =
  | { kind: 'LINKED_EXISTING'; placeId: string }
  | { kind: 'IDENTITY_CONFLICT'; placeIds: string[]; conflictId: string }
  | { kind: 'MERGE_CANDIDATE'; placeId: string; similarity: number; distanceM: number }
  | { kind: 'NEW' };

/**
 * What a Google Place ID resolves to — including "we do not know yet".
 *
 * `CONFLICT` is not a degenerate `RESOLVED`. An external ID recorded against
 * two different GoGo places has no single right answer, and picking the
 * canonical row because it happens to be first is precisely the silent choice
 * `place_identity_conflicts` exists to prevent (#334). Every caller has to
 * decide what to do with it; none may treat it as a link.
 */
export type GoogleIdentity =
  | { kind: 'NONE' }
  | { kind: 'RESOLVED'; placeId: string }
  | { kind: 'CONFLICT'; placeIds: string[]; conflictId: string };

/**
 * What the catalogue already knows about a Google Place ID, from rows GoGo
 * already holds — no provider request (#337 / plan §3 PR4 item 3).
 *
 * Every field here is already persisted and already served by
 * `/v1/places/:id`; reading it back is not a new store, and ADR-0006 §9.5
 * freezes new persistence, not new reads. Nothing is copied anywhere: the
 * lookup answers a question and the answer goes to the caller.
 */
export type KnownProviderPlace = {
  placeId: string;
  googlePlaceId: string;
  name: string;
  addressText: string;
  lat: number;
  lng: number;
  rating: number | null;
  ratingCount: number;
  derivedScore: number | null;
  businessStatus: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  attribution: string | null;
  /** When GoGo last heard this from Google — the stored value, never `now()`. */
  fetchedAt: string;
};

/**
 * `MISS` carries why, because the four reasons behave identically for the
 * caller (ask Google) and completely differently for whoever is looking at the
 * hit rate: `absent` is the catalogue growing, `stale` is the refresh job not
 * keeping up, `legacy` is a pre-PR1 row with no freshness to check, and
 * `indeterminate` is a provider row whose status we never learned.
 */
export type KnownProviderLookup =
  | { kind: 'MISS'; reason: 'absent' | 'stale' | 'legacy' | 'indeterminate' }
  | { kind: 'CONFLICT'; placeIds: string[]; conflictId: string }
  | { kind: 'KNOWN'; place: KnownProviderPlace };

const PROVIDER_STATUS_TO_BUSINESS_STATUS: Record<
  string,
  KnownProviderPlace['businessStatus'] | undefined
> = {
  active: 'OPERATIONAL',
  temporarily_closed: 'CLOSED_TEMPORARILY',
  closed: 'CLOSED_PERMANENTLY',
};

/**
 * PI-BE-006 / FR-INGEST-009 — duplicate rules, strongest signal first:
 * provider id (exact) → same name within 150 m (merge candidate) → new.
 * Ambiguity always becomes a human decision, never an automatic merge.
 */
@Injectable()
export class PlaceDedupService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * What GoGo place a Google Place ID belongs to — the one identity read.
   *
   * Three tables in one round trip, and the order matters. An **open** row in
   * `place_identity_conflicts` outranks both provenance tables: it says the
   * two disagree and no backfill was willing to choose, so runtime does not
   * get to choose either. Returning the canonical row here would make the
   * conflict queue decorative — the migration would have recorded a
   * disagreement that every import, submission and bulk row then ignored.
   *
   * Absent a conflict, canonical first and legacy `place_sources` second. That
   * fallback is what makes the transition safe in both directions: migration
   * 0033 copies every legacy row forward, but a database mid-rollout must
   * still resolve to the place it has always resolved to.
   */
  async resolveGoogleIdentity(
    googlePlaceId: string,
    runner: Pick<Db, 'execute'> = this.db,
  ): Promise<GoogleIdentity> {
    const found = await runner.execute(sql`
      select
        (select place_id from place_provider_sources
          where provider = ${GOOGLE_PROVIDER} and external_id = ${googlePlaceId}
          limit 1) as canonical_place_id,
        (select place_id from place_sources
          where provider = 'google' and external_id = ${googlePlaceId}
          limit 1) as legacy_place_id,
        (select id from place_identity_conflicts
          where provider = ${GOOGLE_PROVIDER} and external_id = ${googlePlaceId}
            and resolved_at is null
          limit 1) as conflict_id
    `);
    const row = found.rows[0] as {
      canonical_place_id: string | null;
      legacy_place_id: string | null;
      conflict_id: string | null;
    };

    if (row.conflict_id) {
      // Both sides are named, so a moderator sees what has to be merged rather
      // than being told only that something is wrong.
      const placeIds = [row.canonical_place_id, row.legacy_place_id].filter(
        (id): id is string => id !== null,
      );
      return { kind: 'CONFLICT', placeIds, conflictId: row.conflict_id };
    }
    if (row.canonical_place_id) return { kind: 'RESOLVED', placeId: row.canonical_place_id };
    if (row.legacy_place_id) return { kind: 'RESOLVED', placeId: row.legacy_place_id };
    return { kind: 'NONE' };
  }

  /**
   * DB-first: what we can answer about a Google Place ID without paying Google.
   *
   * The import, submit and bulk paths all used to call Details *before* asking
   * whether GoGo already had the place — so importing a place that is already
   * in the catalogue cost an Enterprise `details` to be told "you have this
   * already" (plan §4, scenario C). The order is simply wrong: the id is the
   * dedup key, and we hold it.
   *
   * A hit needs three things, and a miss on any of them means ask Google:
   *
   * - the id resolves to exactly one place — a `CONFLICT` is nobody's to
   *   collapse here any more than in `check()` (#334);
   * - the canonical provider row exists, so the freshness contract of
   *   ADR-0006 §4 actually applies (a legacy `place_sources` row has no
   *   `refresh_after` to check and is not treated as fresh);
   * - `refresh_after` is still in the future, which is the *same* window the
   *   catalogue already claims these facts are good for. This introduces no new
   *   retention: it reads a row for as long as that row was already allowed to
   *   answer for itself, and never longer.
   *
   * `unknown`/`moved` statuses are a miss on purpose: neither says whether the
   * place is open, and inventing `OPERATIONAL` for them would turn "we never
   * found out" into a product answer.
   */
  async knownProviderPlace(googlePlaceId: string): Promise<KnownProviderLookup> {
    const identity = await this.resolveGoogleIdentity(googlePlaceId);
    if (identity.kind === 'CONFLICT') {
      this.metrics.increment('place_identity_conflict_blocked_total', { path: 'dbfirst' });
      return { kind: 'CONFLICT', placeIds: identity.placeIds, conflictId: identity.conflictId };
    }
    if (identity.kind === 'NONE') return { kind: 'MISS', reason: 'absent' };

    const found = await this.db.execute(sql`
      select
        s.place_id, s.external_id, s.rating, s.rating_count, s.derived_score,
        s.source_status, s.attribution, s.fetched_at,
        (s.refresh_after is not null and s.refresh_after > now()) as fresh,
        p.name, p.address_text,
        ST_Y(p.geom::geometry) as lat, ST_X(p.geom::geometry) as lng
      from place_provider_sources s
      join places p on p.id = s.place_id
      where s.provider = ${GOOGLE_PROVIDER} and s.external_id = ${googlePlaceId}
      limit 1
    `);
    const row = found.rows[0] as
      | {
          place_id: string;
          external_id: string;
          rating: string | null;
          rating_count: number | null;
          derived_score: string | null;
          source_status: string;
          attribution: { text?: string } | null;
          fetched_at: Date | string;
          fresh: boolean;
          name: string;
          address_text: string | null;
          lat: number;
          lng: number;
        }
      | undefined;

    // Identity resolved but no canonical row: a legacy `place_sources` link
    // that PR1's backfill has not reached, or a place archived out from under
    // it. Either way there is no freshness to stand on.
    if (!row) return { kind: 'MISS', reason: 'legacy' };
    if (!row.fresh) return { kind: 'MISS', reason: 'stale' };
    const businessStatus = PROVIDER_STATUS_TO_BUSINESS_STATUS[row.source_status];
    if (!businessStatus) return { kind: 'MISS', reason: 'indeterminate' };

    const fetchedAt = row.fetched_at instanceof Date ? row.fetched_at : new Date(row.fetched_at);
    return {
      kind: 'KNOWN',
      place: {
        placeId: row.place_id,
        googlePlaceId: row.external_id,
        name: row.name,
        addressText: row.address_text ?? '',
        lat: Number(row.lat),
        lng: Number(row.lng),
        rating: row.rating === null ? null : Number(row.rating),
        ratingCount: row.rating_count ?? 0,
        derivedScore: row.derived_score === null ? null : Number(row.derived_score),
        businessStatus,
        attribution: row.attribution?.text ?? null,
        fetchedAt: fetchedAt.toISOString(),
      },
    };
  }

  /**
   * Links a place to its Google identity and nothing else.
   *
   * The path that calls this — `/v1/places/imports` — used to write
   * `place_sources`, which is what made the same Google Place ID able to
   * become two GoGo places. It writes here instead, but only the columns
   * ADR-0006 §9.3 classes "allowed": the ID, the provider's own link, the
   * attribution it obliges us to display, and our own fetch metadata. Rating,
   * price level and primary type stay out — §9.5 forbids moving provider
   * content into another table, and unifying an identity is not a reason to.
   *
   * Throws on a unique violation rather than re-pointing the row: an external
   * ID already held by another place is a merge decision, not an update.
   */
  async linkProviderIdentity(
    input: {
      placeId: string;
      googlePlaceId: string;
      attribution: string | null;
      providerUri: string | null;
      fetchTier: 'core' | 'quality' | 'detail';
      refreshAfterDays?: number;
    },
    runner: Pick<Db, 'insert'> = this.db,
  ): Promise<void> {
    const refreshAfter = new Date(Date.now() + (input.refreshAfterDays ?? 30) * 24 * 3600 * 1000);
    await runner.insert(schema.placeProviderSources).values({
      placeId: input.placeId,
      provider: GOOGLE_PROVIDER,
      externalId: input.googlePlaceId,
      providerUri: input.providerUri,
      refreshAfter,
      attribution: input.attribution === null ? {} : { text: input.attribution },
      sourceStatus: 'active',
      fetchTier: input.fetchTier,
    });
  }

  /**
   * #334 — Google answered about a different place than the one we asked for.
   *
   * Details follows a moved/merged place to its successor, so the returned id
   * can differ from the requested one. That is an identity change, and PR1
   * only reports it: recording `moved_to_external_id` and routing to review
   * arrives with PR7. Auto-relinking here would let Google's redirect silently
   * repoint a GoGo place.
   */
  reportIdMismatch(details: ResolvedProviderPlace, path: 'import' | 'ingest' | 'submission'): void {
    const requested = details.requestedProviderPlaceId;
    if (!requested || requested === details.providerPlaceId) return;
    // Labels stay bounded: the fact and the door it came through, never an id.
    this.metrics.increment('place_provider_id_mismatch_total', {
      provider: GOOGLE_PROVIDER,
      path,
    });
  }

  async check(details: ResolvedProviderPlace): Promise<DedupVerdict> {
    const identity = await this.resolveGoogleIdentity(details.providerPlaceId);
    if (identity.kind === 'CONFLICT') {
      this.metrics.increment('place_identity_conflict_blocked_total', { path: 'dedup' });
      return {
        kind: 'IDENTITY_CONFLICT',
        placeIds: identity.placeIds,
        conflictId: identity.conflictId,
      };
    }
    if (identity.kind === 'RESOLVED') {
      return { kind: 'LINKED_EXISTING', placeId: identity.placeId };
    }

    const normalized = normalizeVietnamese(details.name);
    const near = await this.db.execute(sql`
      select id,
        similarity(name_normalized, ${normalized}) as sim,
        ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(${details.lng}, ${details.lat}), 4326)::geography) as dist
      from places
      where status <> 'archived'
        and ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${details.lng}, ${details.lat}), 4326)::geography, 150)
        and similarity(name_normalized, ${normalized}) > 0.5
      order by sim desc
      limit 1
    `);
    const candidate = near.rows[0] as { id: string; sim: number; dist: number } | undefined;
    if (candidate) {
      return {
        kind: 'MERGE_CANDIDATE',
        placeId: candidate.id,
        similarity: Number(candidate.sim),
        distanceM: Math.round(Number(candidate.dist)),
      };
    }
    return { kind: 'NEW' };
  }

  /**
   * PI-BE-007/009 — upsert the provider snapshot. Raw aggregates and the
   * derived score are stored side by side with freshness + attribution.
   */
  async upsertProviderSource(input: {
    placeId: string;
    details: ResolvedProviderPlace;
    derivedScore: number;
    fetchTier: 'core' | 'quality' | 'detail';
    refreshAfterDays?: number;
  }): Promise<void> {
    const refreshAfter = new Date(Date.now() + (input.refreshAfterDays ?? 30) * 24 * 3600 * 1000);
    // `CLOSED_TEMPORARILY` used to land on 'unknown', which conflated "shut for
    // now" with "we have no idea" — and the two lead to different decisions.
    const sourceStatus =
      input.details.businessStatus === 'CLOSED_PERMANENTLY'
        ? 'closed'
        : input.details.businessStatus === 'CLOSED_TEMPORARILY'
          ? 'temporarily_closed'
          : 'active';
    await this.db
      .insert(schema.placeProviderSources)
      .values({
        placeId: input.placeId,
        provider: GOOGLE_PROVIDER,
        externalId: input.details.providerPlaceId,
        rating: input.details.rating !== null ? input.details.rating.toFixed(2) : null,
        ratingCount: input.details.ratingCount,
        derivedScore: input.derivedScore.toFixed(2),
        priceLevel: input.details.priceLevel,
        refreshAfter,
        attribution: { text: input.details.attribution },
        sourceStatus,
        primaryType: input.details.primaryType,
        // `provider_uri` has existed since the first ingestion migration and
        // nothing ever wrote it, because the adapter never asked Google for
        // `googleMapsUri` — one of the three `core` fields ADR-0006 §2 requires.
        providerUri: input.details.googleMapsUri,
        fetchTier: input.fetchTier,
      })
      .onConflictDoUpdate({
        target: [schema.placeProviderSources.provider, schema.placeProviderSources.externalId],
        set: {
          placeId: input.placeId,
          primaryType: input.details.primaryType,
          rating: input.details.rating !== null ? input.details.rating.toFixed(2) : null,
          ratingCount: input.details.ratingCount,
          derivedScore: input.derivedScore.toFixed(2),
          fetchedAt: sql`now()`,
          refreshAfter,
          sourceStatus,
          providerUri: input.details.googleMapsUri,
          fetchTier: input.fetchTier,
        },
      });
  }

  /** PI-BE-010 — publish/merge must nudge search; consumers are idempotent. */
  async emitReindex(placeId: string, reason: 'published' | 'merged' | 'updated'): Promise<void> {
    await writeOutbox(this.db, {
      eventType: 'place.updated',
      resourceType: 'place',
      resourceId: placeId,
      payload: { reason },
    });
  }
}
