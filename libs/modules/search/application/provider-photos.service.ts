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
  ProviderInvalidRequestError,
  type PlacePhotoDisplayPort,
  type ProviderDisplayPhotoRef,
  type ProviderPhotoAuthor,
  type ProviderPhotoMedia,
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

/**
 * `place_provider_photos_total{outcome}` — closed, no id or provider text.
 * **Exactly one per 200 response** (review F-04): `served` (≥1 photo, even if
 * the budget ran out part-way), `empty` (Google answered with no usable
 * photo), and one outcome per non-ok `status`.
 */
export const PROVIDER_PHOTO_OUTCOMES = [
  'served',
  'empty',
  'disabled',
  'not_linked',
  'refused_budget',
  'identity_mismatch',
  'provider_error',
  'timeout',
] as const;
type ProviderPhotoOutcome = (typeof PROVIDER_PHOTO_OUTCOMES)[number];

type Result = { dto: ProviderPhotosDto; outcome: ProviderPhotoOutcome };

/** A media call Google refused because the photo name has expired. */
const EXPIRED = Symbol('expired');

function isExpiredName(err: unknown): boolean {
  return (
    err instanceof ProviderInvalidRequestError &&
    (err.canonicalStatus === 'NOT_FOUND' || err.canonicalStatus === 'INVALID_ARGUMENT')
  );
}

@Injectable()
export class ProviderPhotosService {
  private readonly budget: ProviderBudgetService;
  private readonly limits: BudgetLimits;
  /** The whole provider stage. A field so a test can shorten it. */
  deadlineMs = PROVIDER_PHOTOS_DEADLINE_MS;

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
    const result = await this.resolve(placeId);
    // The single place an outcome is counted: one request, one outcome.
    this.metrics.increment('place_provider_photos_total', { outcome: result.outcome });
    return result.dto;
  }

  private async resolve(placeId: string): Promise<Result> {
    const providerPlaceId = await this.googleIdOf(placeId);
    if (!(await this.enabled())) return this.result('disabled', 'disabled');
    if (!providerPlaceId) return this.result('not_linked', 'not_linked');
    // The reference lookup is IDs Only and free, so it reserves nothing — but
    // it is skipped outright when no photo could be paid for: an environment
    // with no budget makes no Google call at all.
    if (!this.mediaBudgetConfigured()) return this.result('budget_exhausted', 'refused_budget');

    // F-01: one signal for the whole stage. When the deadline fires it aborts
    // every in-flight provider call and stops anything not yet started, so no
    // work — and no byte of provider data — outlives the response.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('deadline');
      }, this.deadlineMs);
    });
    const work = this.fetch(providerPlaceId, controller.signal).catch((): Result =>
      this.result('unavailable', 'provider_error'),
    );
    try {
      const winner = await Promise.race([work, deadline]);
      if (winner === 'deadline') return this.result('unavailable', 'timeout');
      return winner;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async fetch(providerPlaceId: string, signal: AbortSignal): Promise<Result> {
    const refs = await this.refsFor(providerPlaceId, signal);
    if (!refs) return this.result('unavailable', 'identity_mismatch');

    const wanted = refs.slice(0, MAX_PROVIDER_PHOTOS);
    if (wanted.length === 0) return this.result('ok', 'empty');

    // One reservation per billed call, immediately before it — the refresh
    // job's rule. A refusal part-way shows the photos already paid for.
    const granted = await this.grant(wanted, signal);
    if (granted.length === 0) return this.result('budget_exhausted', 'refused_budget');

    const first = await this.mediaFor(granted, signal);
    const photos: (ProviderPhotoDto | null)[] = first.map((m, i) =>
      m === EXPIRED || m === null ? null : this.toDto(granted[i]!, m),
    );

    // F-02: photo names expire. Expired ones get exactly one fresh lookup in
    // the same deadline; the fresh reference at the same position replaces
    // the stale one, credit included, and its media call is reserved anew.
    const expiredAt = first.flatMap((m, i) => (m === EXPIRED ? [i] : []));
    if (expiredAt.length > 0 && !signal.aborted) {
      const fresh = await this.refsFor(providerPlaceId, signal).catch(() => null);
      const retry = expiredAt
        .map((i) => ({ i, ref: fresh?.[i] }))
        .filter((r): r is { i: number; ref: ProviderDisplayPhotoRef } => r.ref !== undefined);
      const regranted = await this.grant(
        retry.map((r) => r.ref),
        signal,
      );
      const second = await this.mediaFor(regranted, signal);
      second.forEach((m, k) => {
        if (m !== EXPIRED && m !== null) photos[retry[k]!.i] = this.toDto(regranted[k]!, m);
      });
    }

    if (signal.aborted) return this.result('unavailable', 'timeout');
    const served = photos.filter((p): p is ProviderPhotoDto => p !== null);
    if (served.length === 0) return this.result('unavailable', 'provider_error');
    return { dto: { ...this.answer('ok'), photos: served }, outcome: 'served' };
  }

  /** References for the id GoGo holds, or `null` when Google answers as another id. */
  private async refsFor(
    providerPlaceId: string,
    signal: AbortSignal,
  ): Promise<ProviderDisplayPhotoRef[] | null> {
    const refs = await this.provider.photoRefs(providerPlaceId, { signal });
    // Google answering about another id means the place moved or merged. Its
    // successor's photos are not evidence about the place GoGo shows, so none.
    if (!refs || refs.providerPlaceId !== providerPlaceId) return null;
    return refs.photos;
  }

  /** Reserve one billed media call per ref, in order, stopping at the first refusal. */
  private async grant(
    refs: ProviderDisplayPhotoRef[],
    signal: AbortSignal,
  ): Promise<ProviderDisplayPhotoRef[]> {
    const granted: ProviderDisplayPhotoRef[] = [];
    for (const ref of refs) {
      if (signal.aborted) break;
      const result = await this.budget.reserve(
        { scope: SCOPE, operation: MEDIA_OPERATION, calls: 1, units: 1 },
        this.limits,
      );
      if (!result.ok) break;
      granted.push(ref);
    }
    return granted;
  }

  private async mediaFor(
    refs: ProviderDisplayPhotoRef[],
    signal: AbortSignal,
  ): Promise<(ProviderPhotoMedia | null | typeof EXPIRED)[]> {
    if (signal.aborted) return refs.map(() => null);
    const settled = await Promise.allSettled(
      refs.map((ref) =>
        this.provider.photoMedia(ref.reference, {
          maxWidthPx: PROVIDER_PHOTO_MAX_WIDTH_PX,
          maxBytes: PROVIDER_PHOTO_MAX_BYTES,
          signal,
        }),
      ),
    );
    return settled.map((s) => {
      if (s.status === 'fulfilled') return s.value;
      return isExpiredName(s.reason) ? EXPIRED : null;
    });
  }

  /** The bytes go out once, inside this response. Nothing holds them. */
  private toDto(ref: ProviderDisplayPhotoRef, media: ProviderPhotoMedia): ProviderPhotoDto {
    return {
      contentType: media.contentType,
      dataBase64: Buffer.from(media.bytes).toString('base64'),
      widthPx: ref.widthPx,
      heightPx: ref.heightPx,
      authorAttributions: ref.authorAttributions,
      googleMapsUri: ref.googleMapsUri,
    };
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

  private result(status: ProviderPhotosStatus, outcome: ProviderPhotoOutcome): Result {
    return { dto: this.answer(status), outcome };
  }

  private answer(status: ProviderPhotosStatus): ProviderPhotosDto {
    return { status, provider: 'google', attribution: GOOGLE_ATTRIBUTION, photos: [] };
  }
}
