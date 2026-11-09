import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { flagEnvironmentOf, resolveFlag } from '../../shared/feature-flags';
import { DB } from '../../shared/tokens';

/**
 * ADR-0052: one bounded Google photo pipeline for resolve preview and authorized
 * stored covers. Provider names/retrieval URLs exist only inside this request;
 * callers may persist bytes + attribution, never the transient reference.
 * Preview stays private/no-store; submission views read the stored CDN cover.
 */

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

export type CandidatePhotoReference = {
  url: string;
  provider: 'google';
  attribution: string;
  authorAttributions: ProviderPhotoAuthor[];
  googleMapsUri: string | null;
};

type Result = { dto: ProviderPhotosDto; outcome: ProviderPhotoOutcome };
/** Photos paid for so far in this request, by position; `null` = not shown. */
type Bought = { photos: (ProviderPhotoDto | null)[] };

/** A media call Google refused because the photo name has expired. */
const EXPIRED = Symbol('expired');

/**
 * What stays the same about a photo when Google renames it: its Maps link,
 * else its credit. The name (`reference`) is not stable — it is what expired.
 */
function identityOf(ref: ProviderDisplayPhotoRef): string {
  if (ref.googleMapsUri) return `uri:${ref.googleMapsUri}`;
  return `by:${ref.authorAttributions.map((a) => `${a.displayName}|${a.uri ?? ''}`).join(',')}`;
}

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
    @Inject(APP_CONFIG)
    private readonly config: ProviderPhotosConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional() budget?: ProviderBudgetService,
  ) {
    this.budget = budget ?? new ProviderBudgetService(db);
    this.limits = budgetLimitsFrom(SCOPE, config as unknown as Record<string, number | undefined>);
  }

  /** #786: references only; no billed media and nothing retained between requests. */
  async candidateReference(
    providerPlaceId: string,
    options: { signal?: AbortSignal; deadline?: number } = {},
  ): Promise<CandidatePhotoReference | undefined> {
    if (
      options.signal?.aborted ||
      (options.deadline !== undefined && performance.now() >= options.deadline)
    )
      return undefined;
    if (!(await this.enabled()) || !this.mediaBudgetConfigured()) return undefined;
    const remaining = Math.min(this.deadlineMs, (options.deadline ?? Infinity) - performance.now());
    if (options.signal?.aborted || remaining <= 0) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, remaining);
    try {
      const refs = await Promise.race([
        this.refsFor(providerPlaceId, controller.signal),
        new Promise<null>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve(null), { once: true }),
        ),
      ]);
      const first = refs?.[0];
      if (!first) return undefined;
      return {
        url: `/v1/places/google-provider-photo/${encodeURIComponent(providerPlaceId)}`,
        provider: 'google',
        attribution: GOOGLE_ATTRIBUTION,
        authorAttributions: first.authorAttributions,
        googleMapsUri: first.googleMapsUri,
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  /** #786: candidate proxy and approval share the existing bounded, metered pipeline. */
  async firstForProvider(
    providerPlaceId: string,
    stage: 'submit' | 'approve' | 'preview' | 'cms_create' | 'backfill' = 'preview',
  ): Promise<ProviderPhotosDto> {
    const result = await this.resolveProvider(
      providerPlaceId,
      1,
      stage === 'submit' || stage === 'cms_create',
    );
    this.metrics.increment('provider_photo_requests_total', { stage, outcome: result.outcome });
    return result.dto;
  }

  /** #797: references only, with explicit empty/error outcomes; never reserve or store. */
  async probeForProvider(
    providerPlaceId: string,
  ): Promise<{ status: ProviderPhotosStatus; hasPhoto: boolean }> {
    if (!(await this.enabled())) return { status: 'disabled', hasPhoto: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    try {
      const refs = await Promise.race([
        this.refsFor(providerPlaceId, controller.signal),
        new Promise<null>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve(null), { once: true }),
        ),
      ]);
      return refs === null
        ? { status: 'unavailable', hasPhoto: false }
        : { status: 'ok', hasPhoto: refs.length > 0 };
    } catch {
      return { status: 'unavailable', hasPhoto: false };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async resolveProvider(
    providerPlaceId: string | null,
    limit: number,
    acquired = false,
  ): Promise<Result> {
    if (!acquired && !(await this.enabled())) return this.result('disabled', 'disabled');
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
    // F-09 (SA): photos already bought stay visible here, so a deadline that
    // fires during the expired-name retry still shows what was paid for.
    const bought: Bought = { photos: [] };
    const work = this.fetch(providerPlaceId, controller.signal, bought, limit).catch((): Result =>
      this.result('unavailable', 'provider_error'),
    );
    try {
      const winner = await Promise.race([work, deadline]);
      if (winner === 'deadline')
        return this.served(bought) ?? this.result('unavailable', 'timeout');
      return winner;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async fetch(
    providerPlaceId: string,
    signal: AbortSignal,
    bought: Bought,
    limit: number,
  ): Promise<Result> {
    const refs = await this.refsFor(providerPlaceId, signal);
    if (!refs) return this.result('unavailable', 'identity_mismatch');

    const wanted = refs.slice(0, limit);
    if (wanted.length === 0) return this.result('ok', 'empty');

    // One reservation per billed call, immediately before it — the refresh
    // job's rule. A refusal part-way shows the photos already paid for.
    const granted = await this.grant(wanted, signal);
    if (granted.length === 0) return this.result('budget_exhausted', 'refused_budget');

    const first = await this.mediaFor(granted, signal);
    const photos: (ProviderPhotoDto | null)[] = first.map((m, i) =>
      m === EXPIRED || m === null ? null : this.toDto(granted[i]!, m),
    );
    bought.photos = photos;

    // F-02: photo names expire. Expired ones get exactly one fresh lookup in
    // the same deadline, and its media call is reserved anew. F-06: fresh
    // names differ from the stale ones and Google may reorder the list, so a
    // replacement is matched by the photo's stable identity — never by
    // position — and a photo already served is never bought twice.
    const expired = first.flatMap((m, i) => (m === EXPIRED ? [i] : []));
    if (expired.length > 0 && !signal.aborted) {
      const fresh = await this.refsFor(providerPlaceId, signal).catch(() => null);
      // F-07: every photo already paid for in the first round and not expired
      // — served or failed for any other reason — is off limits. Only an
      // expired photo may come back, under its new name.
      const expiredSet = new Set(expired);
      const servedKeys = new Set(
        granted.filter((_, i) => !expiredSet.has(i)).map((ref) => identityOf(ref)),
      );
      const retry: { i: number; ref: ProviderDisplayPhotoRef }[] = [];
      const taken = new Set<string>();
      for (const i of expired) {
        const wantedKey = identityOf(granted[i]!);
        const candidates = (fresh ?? []).filter((f) => {
          const key = identityOf(f);
          return !servedKeys.has(key) && !taken.has(key);
        });
        // The same photo under its new name, else the first one not shown yet.
        const match = candidates.find((f) => identityOf(f) === wantedKey) ?? candidates[0];
        if (!match) continue;
        taken.add(identityOf(match));
        retry.push({ i, ref: match });
      }
      const regranted = await this.grant(
        retry.map((r) => r.ref),
        signal,
      );
      const second = await this.mediaFor(regranted, signal);
      second.forEach((m, k) => {
        if (m !== EXPIRED && m !== null) photos[retry[k]!.i] = this.toDto(regranted[k]!, m);
      });
    }

    const served = this.served(bought);
    if (served) return served;
    if (signal.aborted) return this.result('unavailable', 'timeout');
    return this.result('unavailable', 'provider_error');
  }

  /** `ok` with every photo already in hand, or `null` when there is none. */
  private served(bought: Bought): Result | null {
    const photos = bought.photos.filter((p): p is ProviderPhotoDto => p !== null);
    if (photos.length === 0) return null;
    return { dto: { ...this.answer('ok'), photos }, outcome: 'served' };
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

  async enabled(): Promise<boolean> {
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
