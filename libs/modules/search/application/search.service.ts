import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type Db } from '@gogo/database';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { AppError } from '../../shared/app-error';
import { iso, num, toPhotos, type PlacePhotoRow } from '../domain/place-dto';
import { writeOutbox } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import { normalizeVietnamese } from '../domain/normalize';
import {
  SearchRepository,
  vnDayMinute,
  type HoursRow,
  type SearchFilters,
  type SearchRow,
} from '../infrastructure/search.repository';

export type OpenState = {
  openNow: boolean;
  /** Minutes-of-day facts; client composes "Đang mở · Đóng 23:00" (FR-SEARCH-009). */
  closesAtMinute?: number;
  opensAtMinute?: number;
  opensDayOffset?: number;
};

export function openStateAt(hours: HoursRow[], at: Date): OpenState {
  const { dow, minute } = vnDayMinute(at);
  const prevDow = (dow + 6) % 7;
  for (const h of hours) {
    if (
      h.day_of_week === dow &&
      !h.is_overnight &&
      minute >= h.open_minute &&
      minute <= h.close_minute
    ) {
      return { openNow: true, closesAtMinute: h.close_minute };
    }
    if (h.day_of_week === dow && h.is_overnight && minute >= h.open_minute) {
      return { openNow: true, closesAtMinute: h.close_minute };
    }
    if (h.day_of_week === prevDow && h.is_overnight && minute <= h.close_minute) {
      return { openNow: true, closesAtMinute: h.close_minute };
    }
  }
  // Next opening within a week.
  for (let offset = 0; offset < 7; offset++) {
    const day = (dow + offset) % 7;
    const candidates = hours
      .filter((h) => h.day_of_week === day && (offset > 0 || h.open_minute > minute))
      .sort((a, b) => a.open_minute - b.open_minute);
    if (candidates.length > 0) {
      return { openNow: false, opensAtMinute: candidates[0]!.open_minute, opensDayOffset: offset };
    }
  }
  return { openNow: false };
}

function encodeCursor(v: number, id: string, scoredAt: Date): string {
  return Buffer.from(JSON.stringify([v, id, scoredAt.toISOString()])).toString('base64url');
}

export function decodeCursor(cursor: string): { v: number; id: string; scoredAt: Date } {
  try {
    const [v, id, t] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [
      number,
      string,
      string,
    ];
    const scoredAt = new Date(t);
    if (typeof v !== 'number' || typeof id !== 'string' || Number.isNaN(scoredAt.getTime())) {
      throw new Error('bad');
    }
    return { v, id, scoredAt };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

/** SE-004/005 + SE-010 — search orchestration, reason codes, zero-result telemetry. */
@Injectable()
export class SearchService {
  constructor(
    private readonly repo: SearchRepository,
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(APP_CONFIG) private readonly config?: MediaConfig,
  ) {}

  /** Empty until media hosting is configured; see `toPhotos`. */
  private get mediaBaseUrl(): string {
    return this.config?.MEDIA_PUBLIC_BASE_URL ?? '';
  }

  async search(filters: SearchFilters, actorAnalyticsId?: string) {
    const { weights, version } = await this.repo.activeWeights();
    const synonymCategoryKeys = filters.q
      ? await this.repo.synonymCategoryKeys(normalizeVietnamese(filters.q))
      : [];
    const rows = await this.repo.search({ ...filters, synonymCategoryKeys }, weights);
    const hasMore = rows.length > filters.limit;
    const page = rows.slice(0, filters.limit);

    const at = filters.openAt ?? new Date();
    const hoursAll = await this.repo.hoursFor(page.map((r) => r.id));
    const hoursByPlace = new Map<string, HoursRow[]>();
    for (const h of hoursAll) {
      const list = hoursByPlace.get(h.place_id) ?? [];
      list.push(h);
      hoursByPlace.set(h.place_id, list);
    }

    const results = page.map((row) =>
      this.toResult(row, hoursByPlace.get(row.id) ?? [], at, filters),
    );

    if (results.length === 0) {
      // FR-SEARCH-008: measurable zero-result without raw PII — normalized
      // query only, pseudonymous actor.
      await writeOutbox(this.db, {
        eventType: 'search.zero_result',
        resourceType: 'search',
        resourceId: createHash('sha256')
          .update(filters.q ?? '')
          .digest('hex')
          .slice(0, 16),
        actorId: actorAnalyticsId,
        payload: {
          queryNormalized: filters.q ? normalizeVietnamese(filters.q) : null,
          filters: {
            categories: filters.categories ?? [],
            radiusM: filters.radiusM ?? null,
            priceMaxPerPerson: filters.priceMaxPerPerson ?? null,
            suitedFor: filters.suitedFor ?? null,
            openAt: filters.openAt?.toISOString() ?? null,
          },
        },
      });
    }

    const last = page[page.length - 1];
    return {
      results,
      nextCursor: hasMore && last ? encodeCursor(last.sort_value, last.id, filters.scoredAt) : null,
      meta: { weightsVersion: version, sort: filters.sort },
    };
  }

  private toResult(row: SearchRow, hours: HoursRow[], at: Date, filters: SearchFilters) {
    const open = openStateAt(hours, at);
    const reasonCodes: string[] = [];
    if (filters.q && (row.text_score ?? 0) > 0.1) reasonCodes.push('TEXT_MATCH');
    if (row.distance_m !== null && row.distance_m < 2000) reasonCodes.push('NEAR_YOU');
    if (row.rating !== null && Number(row.rating) >= 4.3 && row.rating_count >= 100) {
      reasonCodes.push('HIGHLY_RATED');
    }
    if (row.curated_rank !== null) reasonCodes.push('CURATED');
    if (open.openNow) reasonCodes.push('OPEN_NOW');

    return {
      id: row.id,
      name: row.name,
      addressText: row.address_text ?? undefined,
      areaKey: row.area_key ?? undefined,
      lat: row.lat,
      lng: row.lng,
      rating: row.rating !== null ? Number(row.rating) : undefined,
      ratingCount: row.rating_count,
      avgVisitMinutes: row.avg_visit_minutes ?? undefined,
      suitability: row.suitability ?? undefined,
      isLodging: row.is_lodging,
      distanceM: row.distance_m !== null ? Math.round(row.distance_m) : undefined,
      // #151: one honest image or none. A client that gets nothing renders its
      // placeholder; a client that gets a stock photo tells the user a lie.
      primaryPhoto: row.photo_key
        ? toPhotos(
            [
              {
                id: row.photo_id!,
                storageKey: row.photo_key,
                width: row.photo_width,
                height: row.photo_height,
                source: row.photo_from_community ? 'community' : 'manual',
                moderation: 'approved',
              },
            ],
            this.mediaBaseUrl,
          )[0]
        : undefined,
      // FR-SEARCH-009: estimated per-person range — facts, not fake precision.
      pricePerPerson:
        row.price_min !== null
          ? {
              min: Number(row.price_min),
              max: Number(row.price_max),
              currency: row.price_currency ?? 'VND',
              confidence: Number(row.price_confidence ?? 0.5),
            }
          : undefined,
      open,
      freshnessCheckedAt: row.freshness_checked_at
        ? new Date(row.freshness_checked_at).toISOString()
        : undefined,
      confidence: Number(row.confidence),
      reasonCodes,
    };
  }

  /**
   * #169 — mapped, not passed through. The row carries `numeric` as strings,
   * Postgres timestamps and snake_case names; the contract promises numbers,
   * ISO-8601 and camelCase, and nothing in the generated types can catch the
   * difference at the boundary.
   */
  async placeDetail(placeId: string) {
    const row = (await this.repo.placeDetail(placeId)) as Record<string, unknown> | undefined;
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

    const sources = (row['sources'] ?? []) as { provider: string; attribution?: string }[];
    const providerAttribution = sources.find((s) => s.attribution)?.attribution;

    return {
      id: row['id'] as string,
      name: row['name'] as string,
      description: (row['description'] as string | null) ?? undefined,
      status: row['status'] as string,
      addressText: (row['address_text'] as string | null) ?? undefined,
      areaKey: (row['area_key'] as string | null) ?? undefined,
      lat: num(row['lat'])!,
      lng: num(row['lng'])!,
      phone: (row['phone'] as string | null) ?? undefined,
      website: (row['website'] as string | null) ?? undefined,
      rating: num(row['rating']),
      ratingCount: num(row['rating_count']) ?? 0,
      priceLevel: num(row['price_level']),
      avgVisitMinutes: num(row['avg_visit_minutes']),
      suitability: (row['suitability'] as Record<string, number> | null) ?? undefined,
      isLodging: Boolean(row['is_lodging']),
      confidence: num(row['confidence']),
      freshnessCheckedAt: iso(row['freshness_checked_at']),
      curatedRank: num(row['curated_rank']),
      taxonomies: (row['taxonomies'] as unknown[]) ?? [],
      hours: (row['hours'] as unknown[]) ?? [],
      prices: ((row['prices'] as Record<string, unknown>[] | null) ?? []).map((price) => ({
        priceMin: num(price['priceMin']) ?? 0,
        priceMax: num(price['priceMax']) ?? 0,
        currency: (price['currency'] as string) ?? 'VND',
        unit: price['unit'] as string,
        confidence: num(price['confidence']),
        verifiedAt: iso(price['verifiedAt']),
      })),
      sources,
      photos: toPhotos(
        row['media'] as PlacePhotoRow[] | null,
        this.mediaBaseUrl,
        providerAttribution,
      ),
    };
  }
}
