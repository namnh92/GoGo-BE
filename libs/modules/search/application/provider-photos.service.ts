import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  ProviderBudgetService,
  budgetLimitsFrom,
  type BudgetLimits,
} from '@gogo/cost-observability';
import { type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import {
  GOOGLE_ATTRIBUTION,
  PLACE_PHOTO_DISPLAY,
  type PlacePhotoDisplayPort,
  type ProviderDisplayPhotoRef,
  type ProviderPhotoAuthor,
} from '@gogo/providers';
import { APP_CONFIG, type ProviderPhotosConfig } from '../../shared/config';
import { AppError } from '../../shared/app-error';
import { flagEnvironmentOf, resolveFlag } from '../../shared/feature-flags';
import { GOOGLE_PROVIDER } from '../../shared/google-provenance';
import { DB } from '../../shared/tokens';

/**
 * GoGo-BE#509 — transient Google photos for Place Detail.
 *
 * Owner decision 2026-10-02 (ADR-0029): **display only, never stored.** A photo
 * name, its image URL and its bytes exist only inside this one request — they
 * are not written to the database, R2, Redis, a job or a snapshot, and the
 * response is `Cache-Control: no-store`. The only provider value GoGo keeps is
 * the Place ID it already holds.
 *
 * Every way this can fail ends in a 200 with no photos and a reason: Place
 * Detail is already on screen from GoGo's own data, and a missing gallery must
 * never turn into an error page.
 */

/** At most this many photos per view — each one is a billed media call. */
export const MAX_PROVIDER_PHOTOS = 3;
/** Width asked of Google; a phone detail hero, not an original. */
export const PROVIDER_PHOTO_MAX_WIDTH_PX = 800;
/** Per-image byte ceiling; base64 adds a third on top. */
export const PROVIDER_PHOTO_MAX_BYTES = 400 * 1024;
/** The whole provider stage, references and media together. */
export const PROVIDER_PHOTOS_DEADLINE_MS = 6000;

const SCOPE = 'google.places.display' as const;
const MEDIA_OPERATION = 'google.photoMedia';

export type ProviderPhotosStatus =
  'ok' | 'disabled' | 'not_linked' | 'budget_exhausted' | 'unavailable';

export type ProviderPhotoDto = {
  contentType: string;
  dataBase64: string;
  widthPx: number | null;
  heightPx: number | null;
  authorAttributions: ProviderPhotoAuthor[];
  googleMapsUri: string | null;
};

export type ProviderPhotosDto = {
  status: ProviderPhotosStatus;
  provider: 'google';
  /** Shown beside the gallery whenever a photo is shown (Google Maps). */
  attribution: string;
  photos: ProviderPhotoDto[];
};

/** `place_provider_photos_total{outcome}` — closed, no id or provider text. */
export const PROVIDER_PHOTO_OUTCOMES = [
  'served',
  'disabled',
  'not_linked',
  'refused_budget',
  'identity_mismatch',
  'provider_error',
  'timeout',
] as const;
type ProviderPhotoOutcome = (typeof PROVIDER_PHOTO_OUTCOMES)[number];

class DeadlineExceeded extends Error {}

@Injectable()
export class ProviderPhotosService {
  private readonly budget: ProviderBudgetService;
  private readonly limits: BudgetLimits;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PLACE_PHOTO_DISPLAY) private readonly provider: PlacePhotoDisplayPort,
    @Inject(APP_CONFIG) private readonly config: ProviderPhotosConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional() budget?: ProviderBudgetService,
  ) {
    this.budget = budget ?? new ProviderBudgetService(db);
    this.limits = budgetLimitsFrom(SCOPE, config as unknown as Record<string, number | undefined>);
  }

  async photos(placeId: string): Promise<ProviderPhotosDto> {
    const providerPlaceId = await this.googleIdOf(placeId);
    if (!(await this.enabled())) return this.answer('disabled');
    if (!providerPlaceId) return this.answer('not_linked');

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded()), PROVIDER_PHOTOS_DEADLINE_MS);
    });
    try {
      return await Promise.race([this.fetch(providerPlaceId), deadline]);
    } catch (err) {
      this.count(err instanceof DeadlineExceeded ? 'timeout' : 'provider_error');
      return this.answer('unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetch(providerPlaceId: string): Promise<ProviderPhotosDto> {
    // The reference lookup is IDs Only and free, so it reserves nothing — but
    // it is skipped outright when no photo could be paid for: an environment
    // with no budget makes no Google call at all.
    if (!this.mediaBudgetConfigured()) {
      this.count('refused_budget');
      return this.answer('budget_exhausted');
    }

    const refs = await this.provider.photoRefs(providerPlaceId);
    // Google answering about another id means the place moved or merged. Its
    // successor's photos are not evidence about the place GoGo shows, so none.
    if (!refs || refs.providerPlaceId !== providerPlaceId) {
      this.count('identity_mismatch');
      return this.answer('unavailable');
    }

    const wanted = refs.photos.slice(0, MAX_PROVIDER_PHOTOS);
    if (wanted.length === 0) return this.answer('ok');

    // One reservation per billed call, immediately before it — the refresh
    // job's rule. A refusal part-way shows the photos already paid for.
    const granted: ProviderDisplayPhotoRef[] = [];
    for (const ref of wanted) {
      if (!(await this.reserve(MEDIA_OPERATION))) break;
      granted.push(ref);
    }
    if (granted.length === 0) return this.answer('budget_exhausted');

    const settled = await Promise.allSettled(
      granted.map(async (ref) => {
        const media = await this.provider.photoMedia(ref.reference, {
          maxWidthPx: PROVIDER_PHOTO_MAX_WIDTH_PX,
          maxBytes: PROVIDER_PHOTO_MAX_BYTES,
        });
        if (!media) return null;
        // The bytes go out once, inside this response. Nothing holds them.
        const photo: ProviderPhotoDto = {
          contentType: media.contentType,
          dataBase64: Buffer.from(media.bytes).toString('base64'),
          widthPx: ref.widthPx,
          heightPx: ref.heightPx,
          authorAttributions: ref.authorAttributions,
          googleMapsUri: ref.googleMapsUri,
        };
        return photo;
      }),
    );
    const photos = settled
      .map((s) => (s.status === 'fulfilled' ? s.value : null))
      .filter((p): p is ProviderPhotoDto => p !== null);
    if (photos.length === 0) {
      this.count('provider_error');
      return this.answer('unavailable');
    }
    this.count('served');
    return { ...this.answer('ok'), photos };
  }

  /**
   * The place's Google Place ID — the one provider value GoGo may keep — or
   * `null` when it has none. 404 for a place Place Detail would not show.
   */
  private async googleIdOf(placeId: string): Promise<string | null> {
    const { rows } = await this.db.execute(sql`
      select
        (select ps.external_id from place_provider_sources ps
          where ps.place_id = p.id and ps.provider = ${GOOGLE_PROVIDER}
            and ps.source_status <> 'moved'
          order by ps.fetched_at desc nulls last limit 1) as provider_id,
        (select s.external_id from place_sources s
          where s.place_id = p.id and s.provider = 'google'
          order by s.imported_at desc limit 1) as legacy_id
      from places p
      where p.id = ${placeId} and p.status in ('published', 'community_submitted')
      limit 1
    `);
    const row = rows[0] as { provider_id: string | null; legacy_id: string | null } | undefined;
    if (!row) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
    return row.provider_id ?? row.legacy_id ?? null;
  }

  private async enabled(): Promise<boolean> {
    const resolved = await resolveFlag(this.db, 'place_provider_photos.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
    return resolved.isDefault ? this.config.FLAG_PLACE_PROVIDER_PHOTOS : resolved.enabled;
  }

  private mediaBudgetConfigured(): boolean {
    return (
      this.limits.maxCallsPerDay !== null &&
      this.limits.maxListCostMicrosPerDay !== null &&
      this.limits.maxUnitsByOperation[MEDIA_OPERATION] !== undefined
    );
  }

  private async reserve(operation: string): Promise<boolean> {
    const result = await this.budget.reserve(
      { scope: SCOPE, operation, calls: 1, units: 1 },
      this.limits,
    );
    if (!result.ok) this.count('refused_budget');
    return result.ok;
  }

  private answer(status: ProviderPhotosStatus): ProviderPhotosDto {
    if (status === 'disabled' || status === 'not_linked') this.count(status);
    return { status, provider: 'google', attribution: GOOGLE_ATTRIBUTION, photos: [] };
  }

  private count(outcome: ProviderPhotoOutcome): void {
    this.metrics.increment('place_provider_photos_total', { outcome });
  }
}
