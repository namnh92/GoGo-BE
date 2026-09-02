import {
  GOOGLE_ATTRIBUTION,
  NO_PROVIDER_METRICS,
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type AreaAutocompletePort,
  type AreaPrediction,
  type PlaceDescriptionTier,
  type PlaceFetchTier,
  type PlaceProviderPort,
  type ProviderPlaceIdentity,
  type ProviderMetrics,
  type ProviderPhotoRef,
  type ResolvedProviderPlace,
} from './ports';
import { boundedReason, googleFailure, readGoogleError } from './google-error';
import { expandShortLink, parseMapsUrl, type Fetcher, type UrlParseResult } from './maps-url';
import { withResilience } from './resilience';

const RESILIENCE = {
  timeoutMs: 5000,
  retries: 2,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

/**
 * ADR-0006 §2, verbatim. Each tier is the one before it plus its own fields, so
 * the relationship is expressed once instead of three drifting strings — which
 * is how the adapter came to send a mask that was neither `core` nor `quality`:
 * it carried the quality aggregates while missing `types`, `googleMapsUri` and
 * `photos`, all three of which the ADR puts in `core`.
 *
 * Exported because the field mask *is* the cost decision. A test that asserts
 * the exact string is the only thing standing between a one-word edit and a
 * silently larger invoice.
 */
/**
 * Google's Place Details **IDs-Only** SKU, verbatim from plan §2.4: free,
 * unlimited, and able to answer exactly one question — does this id still
 * resolve, and where has it moved to.
 *
 * `movedPlaceId` is an IDs-Only field, so it is on the free side of the SKU
 * boundary: asking for it changes neither the tier nor the bill. It is the
 * signal PR7's refresh keys on, and it is the only one that arrives when
 * Google answers under the id it was given and names the successor separately
 * — the id comparison behind `requestedProviderPlaceId` (#334) does not see
 * that case at all, which is why the refresh needs this mask rather than `id`
 * alone.
 */
const LIVENESS_FIELDS = ['id', 'movedPlaceId'] as const;

const CORE_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'businessStatus',
  'primaryType',
  'types',
  'googleMapsUri',
  'photos',
] as const;

const QUALITY_FIELDS = [
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'priceLevel',
  'priceRange',
] as const;

const DETAIL_FIELDS = ['reviews'] as const;

export const PLACE_FIELD_MASKS: Readonly<Record<PlaceFetchTier, string>> = {
  liveness: LIVENESS_FIELDS.join(','),
  core: CORE_FIELDS.join(','),
  quality: [...CORE_FIELDS, ...QUALITY_FIELDS].join(','),
  detail: [...CORE_FIELDS, ...QUALITY_FIELDS, ...DETAIL_FIELDS].join(','),
};

/**
 * Google Places adapter (ADR-0004). Key stays server-side; attribution and
 * cache windows follow FR-PLACE-006. Only exercised when GOOGLE_PLACES_API_KEY
 * is configured — CI and dev use the fakes.
 */
export class GooglePlacesAdapter implements PlaceProviderPort, AreaAutocompletePort {
  /**
   * PI-SRE-001: cost is billed per SKU, so the counter is labelled by the call
   * that produced it — that is the only way an invoice can be reconciled.
   */
  constructor(
    private readonly apiKey: string,
    private readonly metrics: ProviderMetrics = NO_PROVIDER_METRICS,
  ) {}

  /**
   * URL → provider place id, over the **SSRF-guarded** walker (#339).
   *
   * This used to be a second, unguarded short-link expander: a bare
   * `fetch(url, { redirect: 'follow' })` that let the platform chase every hop
   * with no hostname allowlist, no private-address block and no per-hop
   * re-validation. `POST /v1/places/imports` hands it a URL typed by a user, so
   * an open redirect on a Google host — or simply a link to somewhere else
   * entirely — was a request this server would make on request. The resolver
   * has had the guarded walker since PI-BE-003; the adapter just could not
   * reach it, which is why `maps-url` now lives in this package.
   *
   * `parseMapsUrl` also replaces the hand-rolled regexes. They accepted any
   * host at all, so `https://evil.test/maps/place/X` reached the branch below
   * and turned an attacker's string into a billed Text Search.
   */
  async resolveUrl(url: string): Promise<string | null> {
    const identified = await this.identifyUrl(url);
    if (!identified.ok) return null;
    if (identified.value.providerPlaceId) return identified.value.providerPlaceId;

    // Canonical /maps/place/<name>/… — resolve by text search.
    const query = identified.value.query;
    if (!query) return null;
    return (await this.searchCandidates(query, 1))[0] ?? null;
  }

  /**
   * The guarded walker, wearing this adapter's instrumentation.
   *
   * #335/#336: the expansion hop is free — an unauthenticated HEAD to a URL
   * shortener, not a billed SKU — but "free" and "unmeasured" are different
   * facts, and baseline scenario C2 counts it. One count per hop, the same as
   * the resolver's walker emits, under the same `google.expand` label: they
   * are the same operation against the same host, and splitting the label
   * would report one operation as two.
   */
  private async identifyUrl(url: string): Promise<UrlParseResult> {
    const parsed = parseMapsUrl(url);
    if (!parsed.ok) return parsed;
    if (!parsed.value.needsExpansion) return parsed;
    return expandShortLink(url, this.expandFetcher);
  }

  private readonly expandFetcher: Fetcher = async (target, init) => {
    const started = Date.now();
    const record = (status: number | 'error'): void => {
      this.metrics.increment('places_provider_requests_total', {
        method: 'google.expand',
        status,
      });
      this.metrics.observe(
        'place_provider_request_duration_seconds',
        (Date.now() - started) / 1000,
        { method: 'google.expand', status },
      );
    };
    try {
      const res = await fetch(target, {
        method: init.method,
        redirect: init.redirect,
        signal: init.signal,
      });
      record(res.status);
      return res;
    } catch (err) {
      // A hop that threw still happened and still took time. Recording it
      // keeps the count equal to the number of requests that left this process.
      record('error');
      throw err;
    }
  };

  /**
   * Text Search (New), IDs-Only field mask — spec §6.2 step 6 keeps the search
   * itself cheap and pays for details only on the candidates it goes on to
   * score.
   */
  async searchCandidates(query: string, limit: number): Promise<string[]> {
    const data = await this.call<{ places?: { id?: string }[] }>(
      'google.searchText',
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        body: JSON.stringify({ textQuery: query, maxResultCount: limit }),
        fieldMask: 'places.id',
      },
    );
    return (data.places ?? []).map((p) => p.id).filter((id): id is string => Boolean(id));
  }

  async details(providerPlaceId: string, tier: 'liveness'): Promise<ProviderPlaceIdentity | null>;
  async details(
    providerPlaceId: string,
    tier: PlaceDescriptionTier,
  ): Promise<ResolvedProviderPlace | null>;
  async details(
    providerPlaceId: string,
    tier: PlaceFetchTier,
  ): Promise<ResolvedProviderPlace | ProviderPlaceIdentity | null> {
    type GooglePlace = {
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      rating?: number;
      userRatingCount?: number;
      businessStatus?: string;
      priceLevel?: string;
      primaryType?: string;
      types?: string[];
      googleMapsUri?: string;
      /** IDs-Only: the successor Google names for a place id that moved. */
      movedPlaceId?: string;
      photos?: {
        name?: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: { displayName?: string }[];
      }[];
      regularOpeningHours?: {
        periods?: {
          open?: { day: number; hour: number; minute: number };
          close?: { day: number; hour: number; minute: number };
        }[];
      };
    };
    let data: GooglePlace;
    try {
      data = await this.call<GooglePlace>(
        // The SKU differs per tier, so the cost counter must too — a single
        // `google.details` label cannot be reconciled against an invoice that
        // bills Essentials, Pro and Enterprise separately.
        `google.details.${tier}`,
        `https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}`,
        { method: 'GET', fieldMask: PLACE_FIELD_MASKS[tier] },
      );
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      if (err instanceof ProviderQuotaExceededError) throw err;
      // #273: a place we cannot look up because our own API is disabled is not
      // a place that does not exist. Returning null here is what turned a GCP
      // console setting into "Không tìm thấy địa điểm trên Google Maps" on a
      // real user's screen.
      if (err instanceof ProviderConfigurationError) throw err;
      // #314: nor is a place id Google calls invalid a place that does not
      // exist. The caller turns this into "your link is broken", which is both
      // true and actionable, instead of "we looked and found nothing".
      if (err instanceof ProviderInvalidRequestError) throw err;
      return null;
    }

    // A liveness answer is identity and nothing else — including no
    // `location`, which is why it returns here rather than falling into the
    // guard below that (correctly) treats a *described* place with no
    // coordinates as no answer at all.
    //
    // Both move signals are passed through as Google sent them, and neither is
    // derived from the other: `movedPlaceId` is Google naming a successor,
    // `requestedProviderPlaceId` is Google quietly answering as one.
    if (tier === 'liveness') {
      if (!data?.id) return null;
      return {
        providerPlaceId: data.id,
        ...(data.id !== providerPlaceId ? { requestedProviderPlaceId: providerPlaceId } : {}),
        ...(data.movedPlaceId ? { movedPlaceId: data.movedPlaceId } : {}),
        fetchTier: 'liveness',
      };
    }

    if (!data?.id || !data.location) return null;

    const hours = (data.regularOpeningHours?.periods ?? [])
      .filter((p) => p.open)
      .map((p) => {
        const openMinute = p.open!.hour * 60 + p.open!.minute;
        const closeMinute = p.close ? p.close.hour * 60 + p.close.minute : 1439;
        return {
          dayOfWeek: p.open!.day,
          openMinute,
          closeMinute,
          isOvernight: p.close !== undefined && p.close.day !== p.open!.day,
        };
      });

    const priceLevelMap: Record<string, number> = {
      PRICE_LEVEL_FREE: 0,
      PRICE_LEVEL_INEXPENSIVE: 1,
      PRICE_LEVEL_MODERATE: 2,
      PRICE_LEVEL_EXPENSIVE: 3,
      PRICE_LEVEL_VERY_EXPENSIVE: 4,
    };

    // `photos[].name` is the whole reference — width/height describe the
    // original, and the author attributions travel with it because a photo
    // rendered without them breaches the licence.
    const photos: ProviderPhotoRef[] = (data.photos ?? [])
      .filter((p): p is { name: string } & typeof p => typeof p.name === 'string' && p.name !== '')
      .map((p) => ({
        reference: p.name,
        widthPx: p.widthPx ?? null,
        heightPx: p.heightPx ?? null,
        attributions: (p.authorAttributions ?? [])
          .map((a) => a.displayName)
          .filter((n): n is string => typeof n === 'string' && n !== ''),
      }));

    // `primaryType` is not guaranteed to appear in `types`, and a caller
    // reading `types` alone must not lose it.
    const types = [
      ...new Set([...(data.primaryType ? [data.primaryType] : []), ...(data.types ?? [])]),
    ];

    return {
      providerPlaceId: data.id,
      // Only when they disagree — see `requestedProviderPlaceId` on the port.
      ...(data.id !== providerPlaceId ? { requestedProviderPlaceId: providerPlaceId } : {}),
      name: data.displayName?.text ?? 'Unknown',
      addressText: data.formattedAddress ?? '',
      lat: data.location.latitude,
      lng: data.location.longitude,
      rating: data.rating ?? null,
      ratingCount: data.userRatingCount ?? 0,
      businessStatus: this.businessStatusOf(data.businessStatus),
      hours,
      priceLevel: data.priceLevel ? (priceLevelMap[data.priceLevel] ?? null) : null,
      primaryType: data.primaryType ?? null,
      types,
      googleMapsUri: data.googleMapsUri ?? null,
      photos,
      fetchTier: tier,
      attribution: GOOGLE_ATTRIBUTION,
      raw: data,
    };
  }

  /**
   * Google's `businessStatus`, mapped explicitly (#339).
   *
   * This was a two-armed ternary whose default was `OPERATIONAL`, so every
   * status it did not name — `FUTURE_OPENING` among them — became "open for
   * business". A place that has been announced but has never traded was
   * therefore imported, published, and offered to someone deciding where to eat
   * tonight.
   *
   * The unmapped case still resolves to `OPERATIONAL`, deliberately and
   * narrowly: `BUSINESS_STATUS_UNSPECIFIED` and an absent field both mean
   * "Google did not say", and refusing every place Google is quiet about would
   * reject good imports for a field that is frequently just missing. What
   * changes is that it is no longer silent — the counter is what will say
   * whether a future Google value is arriving in volume, without putting
   * provider text into a metric label.
   */
  private businessStatusOf(raw: string | undefined): ResolvedProviderPlace['businessStatus'] {
    switch (raw) {
      case 'CLOSED_PERMANENTLY':
        return 'CLOSED_PERMANENTLY';
      case 'CLOSED_TEMPORARILY':
        return 'CLOSED_TEMPORARILY';
      case 'FUTURE_OPENING':
        return 'FUTURE_OPENING';
      case 'OPERATIONAL':
      case 'BUSINESS_STATUS_UNSPECIFIED':
      case undefined:
        return 'OPERATIONAL';
      default:
        this.metrics.increment('places_provider_business_status_unmapped_total', {
          method: 'google.details',
        });
        return 'OPERATIONAL';
    }
  }

  async suggest(query: string, sessionToken: string): Promise<AreaPrediction[]> {
    const data = await this.call<{
      suggestions?: { placePrediction?: { placeId: string; text?: { text: string } } }[];
    }>('google.autocomplete', 'https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      body: JSON.stringify({
        input: query,
        sessionToken,
        includedRegionCodes: ['vn'],
        includedPrimaryTypes: ['locality', 'sublocality', 'administrative_area_level_2'],
      }),
      fieldMask: '*',
    });
    return (data.suggestions ?? [])
      .filter((s) => s.placePrediction)
      .map((s) => ({
        key: s.placePrediction!.placeId,
        description: s.placePrediction!.text?.text ?? '',
      }));
  }

  private call<T>(
    name: string,
    url: string,
    init: { method: string; body?: string; fieldMask: string },
  ): Promise<T> {
    return withResilience({ name, ...RESILIENCE }, async (signal) => {
      const started = Date.now();
      const res = await fetch(url, {
        method: init.method,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': init.fieldMask,
        },
      });
      // #313: `status` and `method` are finite; a duration is not. Emitted as
      // a label it gave every request a series of its own — 10 requests, 10
      // series, each stuck at 1 — which is a log line wearing a counter's
      // clothes and answers no question `rate()` can ask. The duration belongs
      // in a histogram, and now has one.
      this.metrics.increment('places_provider_requests_total', {
        method: name,
        status: res.status,
      });
      // #320: seconds, the Prometheus base unit. `libs/providers` deliberately
      // depends on no `@gogo/*` package, so the conversion is spelled out here
      // rather than imported from `@gogo/observability`.
      this.metrics.observe(
        'place_provider_request_duration_seconds',
        (Date.now() - started) / 1000,
        {
          method: name,
          status: res.status,
        },
      );
      if (res.ok) {
        this.metrics.increment('places_provider_cost_units', { sku: name });
        return (await res.json()) as T;
      }

      // #273: the reason is read before the status, because the status alone
      // does not separate a disabled API from a refused request. 429 /
      // RESOURCE_EXHAUSTED still pauses the import rather than retrying into
      // an exhausted budget (spec §9.4); a configuration fault is not retried
      // either, because the answer will not change.
      const info = await readGoogleError(res);
      const fault = googleFailure('google.places', res.status, info);

      // #314: a request Google rejected is not a provider failure and must not
      // be counted as one — an alert on `places_provider_failures_total` is a
      // statement that Google is not serving us, and pasted junk would make
      // that statement false. It is still counted, on its own bounded series,
      // because a spike in rejected links is worth seeing.
      if (fault instanceof ProviderInvalidRequestError) {
        this.metrics.increment('places_provider_rejected_total', {
          method: name,
          canonical_status: fault.canonicalStatus,
        });
        throw fault;
      }

      this.metrics.increment('places_provider_failures_total', {
        method: name,
        status: res.status,
        reason: boundedReason(info.reason),
      });
      if (fault) throw fault;
      throw new Error(`google ${res.status}`);
    });
  }
}
