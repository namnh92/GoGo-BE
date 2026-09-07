import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import {
  PLACE_PROVIDER,
  ProviderInvalidRequestError,
  type PlaceProviderPort,
  type ResolvedProviderPlace,
} from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { evaluatePlaceApproval } from '../../administrative/application/place-approval';
import {
  APP_CONFIG,
  type PlatformConfig,
  type VerificationWindowConfig,
} from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag, resolveFlag } from '../../shared/feature-flags';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { haversineMeters } from '../../suggestions/domain/hard-filter';
import { PlaceDedupService } from '../../ingestion/application/place-dedup.service';
import { writeAudit } from '../../shared/audit';

const ALLOWED_HOSTS =
  /^(https?:\/\/)?(www\.)?((maps\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com)/i;

type ImportRules = {
  minReviews: number;
  minRating: number;
  autoPublish: boolean;
};

const DEFAULT_RULES: ImportRules = { minReviews: 10, minRating: 3.5, autoPublish: false };

/** Rough per-person VND estimate per provider price level (facts stay ranged). */
const PRICE_LEVEL_VND: Record<number, { min: number; max: number }> = {
  0: { min: 0, max: 0 },
  1: { min: 20_000, max: 80_000 },
  2: { min: 60_000, max: 200_000 },
  3: { min: 150_000, max: 500_000 },
  4: { min: 400_000, max: 1_500_000 },
};

/**
 * BE-BFF-013 / FR-PLACE-001..006 — community place import via Google Maps
 * link with a verification pipeline and stable reason codes.
 */
@Injectable()
export class PlaceImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PLACE_PROVIDER) private readonly provider: PlaceProviderPort,
    @Inject(APP_CONFIG) private readonly config: PlatformConfig & VerificationWindowConfig,
    private readonly dedup: PlaceDedupService,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * #221 — flags are now scoped by environment, so a key can have more than
   * one row and "the row for this key" is no longer a single lookup. The
   * resolver picks the most specific match for the running deployment and
   * falls back to the default the code ships with.
   */
  private async rules(): Promise<ImportRules> {
    const environment = flagEnvironmentOf(this.config.APP_ENV);
    const configured = await resolveFlag(this.db, 'place_import.rules', { environment });
    const payload = (configured.value ?? {}) as Partial<ImportRules>;
    const autoPublish = await resolveFlag(this.db, 'place_import.autopublish', { environment });
    return {
      ...DEFAULT_RULES,
      ...payload,
      autoPublish: autoPublish.enabled || payload.autoPublish === true,
    };
  }

  async submit(actor: Actor, input: { url: string; roomId?: string | undefined }) {
    if (!ALLOWED_HOSTS.test(input.url) && !input.url.includes('place_id=')) {
      throw AppError.badRequest('INVALID_URL', 'Not a supported Google Maps link', [
        { field: 'url', code: 'invalid', message: 'supported: maps.google.com, maps.app.goo.gl' },
      ]);
    }
    const [row] = await this.db
      .insert(schema.placeImports)
      .values({
        url: input.url,
        roomId: input.roomId ?? null,
        ...(actor.type === 'user'
          ? { submittedByUserId: actor.id }
          : { submittedByGuestSessionId: actor.id }),
      })
      .returning();
    await writeOutbox(this.db, {
      eventType: 'place.import_submitted',
      resourceType: 'place_import',
      resourceId: row!.id,
      payload: {},
    });

    // FR-PLACE-004: verification is async by contract (pending → verified |
    // rejected). MVP executes it in-band; the BullMQ consumer takes over when
    // the worker queue lands — the API shape does not change.
    const verified = await this.verify(row!.id);
    return verified;
  }

  async getImport(actor: Actor, importId: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeImports)
      .where(eq(schema.placeImports.id, importId))
      .limit(1);
    if (!row) throw AppError.notFound('IMPORT_NOT_FOUND', 'Import not found');
    const isOwner =
      (actor.type === 'user' && row.submittedByUserId === actor.id) ||
      (actor.type === 'guest' && row.submittedByGuestSessionId === actor.id);
    if (!isOwner) throw AppError.forbidden();
    return this.toDto(row);
  }

  private toDto(row: typeof schema.placeImports.$inferSelect) {
    return {
      id: row.id,
      status: row.status,
      reasonCode: row.reasonCode ?? undefined,
      placeId: row.resultPlaceId ?? undefined,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString(),
    };
  }

  /** The verification pipeline. Also invoked by the worker consumer. */
  async verify(importId: string) {
    const [row] = await this.db
      .select()
      .from(schema.placeImports)
      .where(eq(schema.placeImports.id, importId))
      .limit(1);
    if (!row || row.status !== 'pending') return this.toDto(row!);

    const reject = async (reasonCode: string) => {
      const [updated] = await this.db
        .update(schema.placeImports)
        .set({ status: 'rejected', reasonCode, decidedAt: sql`now()` })
        .where(eq(schema.placeImports.id, importId))
        .returning();
      await writeOutbox(this.db, {
        eventType: 'place.import_rejected',
        resourceType: 'place_import',
        resourceId: importId,
        payload: { reasonCode },
      });
      return this.toDto(updated!);
    };

    /**
     * #314: a link Google rejects on its merits is the submitter's to fix, and
     * PROVIDER_ERROR ("thử lại sau") tells them to wait for a retry that will
     * fail identically. Any other provider failure — breaker open, timeout,
     * transport — is a clean rejection the client can retry, never a 500
     * (FR-PLACE-002).
     */
    const providerFault = (err: unknown) =>
      err instanceof ProviderInvalidRequestError ? 'INVALID_URL' : 'PROVIDER_ERROR';

    let providerPlaceId: string | null;
    try {
      providerPlaceId = await this.provider.resolveUrl(row.url);
    } catch (err) {
      return reject(providerFault(err));
    }
    if (!providerPlaceId) return reject('INVALID_URL');

    // DB-first (#337). `resolveUrl` learns the id without a Places request, so
    // by here the catalogue can be asked before Google is.
    //
    // A hit skips the import rules as well as the fetch, and deliberately:
    // `minReviews`, `minRating` and `OUT_OF_AREA` gate **creating** a place,
    // and this row creates none — it links to one the catalogue already
    // published. Re-adjudicating a live place's rating on the way to saying
    // "you already have this" would reject the import of a place the user can
    // already open, which is a worse answer than the one it replaces.
    if (await this.dbFirst()) {
      const known = await this.dedup.knownProviderPlace(providerPlaceId, {
        verificationWindowSeconds: this.config.PLACE_RESOLUTION_TTL_S,
      });
      if (known.kind === 'CONFLICT') {
        this.metrics.increment('place_identity_conflict_blocked_total', { path: 'import' });
        return reject('IDENTITY_CONFLICT');
      }
      if (known.kind === 'KNOWN') {
        this.metrics.increment('place_dbfirst_hit_total', { path: 'import' });
        // Identity: this row links to a place the catalogue already published
        // and creates nothing, so the catalogue's freshness window governs.
        if (known.place.businessStatus === 'OPERATIONAL') {
          return this.markVerified(row, known.place.googlePlaceId, known.place.placeId, true);
        }
        // Verification: rejecting an import as `CLOSED` on a `source_status`
        // that may be weeks old tells someone their reopened place is shut.
        // Held to the short window; otherwise ask Google (#337 review).
        if (known.place.verificationFresh) return reject('CLOSED');
        this.metrics.increment('place_dbfirst_miss_total', { reason: 'closure_unverified' });
      } else {
        this.metrics.increment('place_dbfirst_miss_total', { reason: known.reason });
      }
    }

    // `quality` (#338). This is `/v1/places/imports`: it gates on
    // `ratingCount` and `rating` against the import rules and then writes a
    // catalogue row with the rating, the price level and the weekly hours. All
    // Enterprise fields, all read below.
    let details: ResolvedProviderPlace | null;
    try {
      details = await this.provider.details(providerPlaceId, 'quality');
    } catch (err) {
      return reject(providerFault(err));
    }
    if (!details) return reject('NOT_FOUND');

    const rules = await this.rules();
    // #339 — an unopened place is refused with its own reason. `CLOSED` would
    // tell the submitter the place had shut, which is the opposite of true.
    if (details.businessStatus === 'FUTURE_OPENING') return reject('NOT_YET_OPEN');
    if (details.businessStatus !== 'OPERATIONAL') return reject('CLOSED');
    if (details.ratingCount < rules.minReviews) return reject('INSUFFICIENT_REVIEWS');
    if ((details.rating ?? 0) < rules.minRating) return reject('LOW_RATING');

    const areas = await this.db
      .select()
      .from(schema.serviceAreas)
      .where(eq(schema.serviceAreas.isActive, true));
    const inArea = areas.some(
      (a) =>
        haversineMeters(
          { lat: a.centerLat, lng: a.centerLng },
          { lat: details.lat, lng: details.lng },
        ) <= a.radiusM,
    );
    if (!inArea) return reject('OUT_OF_AREA');

    // #334 — Google may answer about the successor of a place that moved. PR1
    // reports it and links what came back; it does not repoint anything.
    this.dedup.reportIdMismatch(details, 'import');

    // Dedup by provider id (FR-PLACE-005) — link to the existing place.
    //
    // This used to read `place_sources` alone, which is what let the same
    // Google Place ID become a second GoGo place when it had first arrived
    // through bulk import or a mobile submission. The resolver reads the
    // canonical table and the legacy one, so every door now sees every other.
    const identity = await this.dedup.resolveGoogleIdentity(details.providerPlaceId);
    if (identity.kind === 'CONFLICT') {
      // Two places already claim this Google ID. Linking to either would be
      // this endpoint picking a winner in a decision an editor owns, and
      // creating a third place would make it worse (#334).
      this.metrics.increment('place_identity_conflict_blocked_total', { path: 'import' });
      return reject('IDENTITY_CONFLICT');
    }
    const created =
      identity.kind === 'RESOLVED'
        ? identity.placeId
        : await this.createLinkedPlace(details, rules.autoPublish);
    if (created === 'CONFLICT') {
      this.metrics.increment('place_identity_conflict_blocked_total', { path: 'import' });
      return reject('IDENTITY_CONFLICT');
    }
    const placeId = created;
    const linkedPlaceId = identity.kind === 'RESOLVED' ? identity.placeId : null;

    return this.markVerified(row, details.providerPlaceId, placeId, linkedPlaceId !== null);
  }

  /**
   * The row is verified and points at a place — whether Google was asked in
   * this call or the catalogue already had the answer (#337).
   */
  private async markVerified(
    row: typeof schema.placeImports.$inferSelect,
    providerPlaceId: string,
    placeId: string,
    dedup: boolean,
  ) {
    const importId = row.id;
    const [updated] = await this.db
      .update(schema.placeImports)
      .set({
        status: 'verified',
        providerPlaceId,
        // #348: `providerSnapshot` is no longer written. It held a Google
        // Details extract — name, address, lat/lng, rating, rating count —
        // that one writer produced and nothing anywhere read. That makes it
        // ADR-0006 §9.4 R5 "stop writing" on the same reasoning as R1, and
        // independent of the §9.6 counsel answer: a store with no reader has
        // no product purpose to weigh against the retention rule. The
        // coordinates it carried were also uncapped, which SST §14.3 does not
        // allow (the exposure #347 fixed for candidate rows).
        //
        // `providerPlaceId` stays. The Place ID is the one field SST §3
        // permits storing indefinitely, and it is what lets this row still say
        // which place it resolved to; every other field is re-fetchable from
        // Google on demand.
        resultPlaceId: placeId,
        decidedAt: sql`now()`,
      })
      .where(eq(schema.placeImports.id, importId))
      .returning();
    await writeAudit(this.db, {
      actorType: row.submittedByUserId ? 'user' : 'system',
      actorId: row.submittedByUserId,
      action: 'place.import_verified',
      resourceType: 'place',
      resourceId: placeId,
      diff: { providerPlaceId, dedup },
    });
    await writeOutbox(this.db, {
      eventType: 'place.import_verified',
      resourceType: 'place_import',
      resourceId: importId,
      payload: { placeId, dedup },
    });
    return this.toDto(updated!);
  }

  private async dbFirst(): Promise<boolean> {
    return resolveBooleanFlag(this.db, 'place_dbfirst.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
  }

  /**
   * Creates the place and claims its Google identity in one transaction.
   *
   * The claim can lose a race: another import, a bulk row or a submission may
   * link the same Google Place ID between the dedup read and this write. The
   * unique index on `(provider, external_id)` is what decides, and losing
   * rolls the whole transaction back — no orphan place, and no identity taken
   * away from whoever got there first. The loser then links to their place,
   * which is the answer the dedup read would have given a moment later.
   */
  private async createLinkedPlace(
    details: ResolvedProviderPlace,
    autoPublish: boolean,
  ): Promise<string | 'CONFLICT'> {
    try {
      return await this.createPlace(details, autoPublish);
    } catch (err) {
      const pg = err as { code?: string };
      if (pg.code !== '23505') throw err;
      const raced = await this.dedup.resolveGoogleIdentity(details.providerPlaceId);
      if (raced.kind === 'CONFLICT') return 'CONFLICT';
      if (raced.kind === 'NONE') throw err;
      return raced.placeId;
    }
  }

  /**
   * ADM-009 (#462) — `autoPublish` is a request, not a permission.
   *
   * A place created here has never had its administrative mapping verified by
   * anybody, so the shared approval invariant cannot pass at creation and the
   * place lands in `community_submitted` to be resolved and reviewed. The flag
   * is kept because it still expresses intent, and because the invariant is
   * evaluated rather than assumed: the moment a path exists that creates a
   * place with a verified mapping, this publishes it without further change.
   */
  private async createPlace(details: ResolvedProviderPlace, autoPublish: boolean): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [place] = await tx
        .insert(schema.places)
        .values({
          name: details.name,
          nameNormalized: 'set-by-trigger',
          status: 'community_submitted',
          geom: { x: details.lng, y: details.lat },
          addressText: details.addressText,
          rating: details.rating !== null ? details.rating.toFixed(2) : null,
          ratingCount: details.ratingCount,
          priceLevel: details.priceLevel,
          confidence: '0.60',
          freshnessCheckedAt: new Date(),
        })
        .returning();

      if (autoPublish) {
        const block = await evaluatePlaceApproval(tx, place!);
        if (!block) {
          await tx
            .update(schema.places)
            .set({ status: 'published' })
            .where(eq(schema.places.id, place!.id));
        }
      }

      // #334 — Google provenance is written to `place_provider_sources`, the
      // table dedup and attribution both read. The old `place_sources` write
      // is gone with it, and so is `raw`: it carried a whole Details payload
      // that nothing ever read (ADR-0006 §9.4 R1).
      await this.dedup.linkProviderIdentity(
        {
          placeId: place!.id,
          googlePlaceId: details.providerPlaceId,
          attribution: details.attribution,
          providerUri: details.googleMapsUri,
          // A row must say which fields it could legitimately have, so it
          // records the tier the fetch actually used rather than repeating a
          // literal that a later tier change would silently falsify (#338).
          fetchTier: details.fetchTier,
        },
        tx,
      );
      for (const h of details.hours) {
        await tx.insert(schema.placeHours).values({
          placeId: place!.id,
          dayOfWeek: h.dayOfWeek,
          openMinute: h.openMinute,
          closeMinute: h.closeMinute,
          isOvernight: h.isOvernight,
          source: 'provider',
          verifiedAt: new Date(),
        });
      }
      if (details.priceLevel !== null && PRICE_LEVEL_VND[details.priceLevel]) {
        const range = PRICE_LEVEL_VND[details.priceLevel]!;
        await tx.insert(schema.placePrices).values({
          placeId: place!.id,
          priceMin: range.min,
          priceMax: range.max,
          currency: 'VND',
          unit: 'per_person',
          confidence: '0.40',
          source: 'provider',
          verifiedAt: new Date(),
        });
      }
      return place!.id;
    });
  }
}
