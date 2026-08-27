import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import {
  PLACE_PROVIDER,
  type PlaceProviderPort,
  type ResolvedProviderPlace,
} from '@gogo/providers';
import { AppError } from '../../shared/app-error';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { haversineMeters } from '../../suggestions/domain/hard-filter';

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
  ) {}

  private async rules(): Promise<ImportRules> {
    const [flag] = await this.db
      .select()
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, 'place_import.rules'))
      .limit(1);
    const payload = (flag?.payload ?? {}) as Partial<ImportRules>;
    return {
      ...DEFAULT_RULES,
      ...payload,
      autoPublish:
        (await this.flagEnabled('place_import.autopublish')) || payload.autoPublish === true,
    };
  }

  private async flagEnabled(key: string): Promise<boolean> {
    const [flag] = await this.db
      .select()
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, key))
      .limit(1);
    return flag?.enabled === true;
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

    let providerPlaceId: string | null;
    let details: ResolvedProviderPlace | null;
    try {
      providerPlaceId = await this.provider.resolveUrl(row.url);
      if (!providerPlaceId) return reject('INVALID_URL');
      details = await this.provider.details(providerPlaceId);
    } catch {
      // Any provider failure — breaker open, timeout, transport — is a clean
      // rejection the client can retry, never a 500 (FR-PLACE-002).
      return reject('PROVIDER_ERROR');
    }
    if (!details) return reject('NOT_FOUND');

    const rules = await this.rules();
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

    // Dedup by provider id (FR-PLACE-005) — link to the existing place.
    const [existingSource] = await this.db
      .select()
      .from(schema.placeSources)
      .where(
        sql`${schema.placeSources.provider} = 'google' and ${schema.placeSources.externalId} = ${details.providerPlaceId}`,
      )
      .limit(1);

    const placeId = existingSource
      ? existingSource.placeId
      : await this.createPlace(details, rules.autoPublish);

    const [updated] = await this.db
      .update(schema.placeImports)
      .set({
        status: 'verified',
        providerPlaceId: details.providerPlaceId,
        providerSnapshot: {
          name: details.name,
          addressText: details.addressText,
          lat: details.lat,
          lng: details.lng,
          rating: details.rating,
          ratingCount: details.ratingCount,
          attribution: details.attribution,
        },
        resultPlaceId: placeId,
        decidedAt: sql`now()`,
      })
      .where(eq(schema.placeImports.id, importId))
      .returning();
    await this.db.insert(schema.auditLogs).values({
      actorType: row.submittedByUserId ? 'user' : 'system',
      actorId: row.submittedByUserId,
      action: 'place.import_verified',
      resourceType: 'place',
      resourceId: placeId,
      diff: { providerPlaceId: details.providerPlaceId, dedup: !!existingSource },
    });
    await writeOutbox(this.db, {
      eventType: 'place.import_verified',
      resourceType: 'place_import',
      resourceId: importId,
      payload: { placeId, dedup: !!existingSource },
    });
    return this.toDto(updated!);
  }

  private async createPlace(details: ResolvedProviderPlace, autoPublish: boolean): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [place] = await tx
        .insert(schema.places)
        .values({
          name: details.name,
          nameNormalized: 'set-by-trigger',
          status: autoPublish ? 'published' : 'community_submitted',
          geom: { x: details.lng, y: details.lat },
          addressText: details.addressText,
          rating: details.rating !== null ? details.rating.toFixed(2) : null,
          ratingCount: details.ratingCount,
          priceLevel: details.priceLevel,
          confidence: '0.60',
          freshnessCheckedAt: new Date(),
        })
        .returning();
      await tx.insert(schema.placeSources).values({
        placeId: place!.id,
        provider: 'google',
        externalId: details.providerPlaceId,
        attribution: details.attribution,
        // Provider payload retention bounded by license (FR-PLACE-006).
        raw: details.raw,
        rawUpdatedAt: new Date(),
      });
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
