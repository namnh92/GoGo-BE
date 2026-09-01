import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type AreaAutocompletePort,
  type AreaPrediction,
  type PlaceFetchTier,
  type PlaceProviderPort,
  type ProviderPhotoRef,
  type ResolvedProviderPlace,
} from './ports';
import { googleFailure, readGoogleError } from './google-error';
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
    private readonly metrics: {
      increment(name: string, labels?: Record<string, string | number | undefined>): void;
    } = { increment: () => undefined },
  ) {}

  async resolveUrl(url: string): Promise<string | null> {
    // Direct place_id in the URL — no network needed.
    const byParam = /[?&]place_id=([\w-]+)/.exec(url);
    if (byParam) return byParam[1]!;

    // Short links redirect to a canonical URL carrying the place reference.
    if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/.test(url)) {
      const expanded = await withResilience({ name: 'google.expand', ...RESILIENCE }, (signal) =>
        fetch(url, { method: 'HEAD', redirect: 'follow', signal }).then((r) => r.url),
      );
      const fromExpanded = /[?&]place_id=([\w-]+)/.exec(expanded) ?? /!1s([\w:]+)!/.exec(expanded);
      if (fromExpanded) return fromExpanded[1]!;
      url = expanded;
    }

    // Canonical /maps/place/<name>/… — resolve by text search.
    const nameMatch = /\/maps\/place\/([^/@]+)/.exec(url);
    const query = nameMatch ? decodeURIComponent(nameMatch[1]!).replace(/\+/g, ' ') : null;
    if (!query) return null;
    return (await this.searchCandidates(query, 1))[0] ?? null;
  }

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

  async details(
    providerPlaceId: string,
    tier: PlaceFetchTier = 'quality',
  ): Promise<ResolvedProviderPlace | null> {
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
      name: data.displayName?.text ?? 'Unknown',
      addressText: data.formattedAddress ?? '',
      lat: data.location.latitude,
      lng: data.location.longitude,
      rating: data.rating ?? null,
      ratingCount: data.userRatingCount ?? 0,
      businessStatus:
        data.businessStatus === 'CLOSED_PERMANENTLY'
          ? 'CLOSED_PERMANENTLY'
          : data.businessStatus === 'CLOSED_TEMPORARILY'
            ? 'CLOSED_TEMPORARILY'
            : 'OPERATIONAL',
      hours,
      priceLevel: data.priceLevel ? (priceLevelMap[data.priceLevel] ?? null) : null,
      primaryType: data.primaryType ?? null,
      types,
      googleMapsUri: data.googleMapsUri ?? null,
      photos,
      fetchTier: tier,
      attribution: 'Data © Google',
      raw: data,
    };
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
      this.metrics.increment('places_provider_requests_total', {
        method: name,
        status: res.status,
        duration_ms: Date.now() - started,
      });
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
        reason: info.reason ?? 'unknown',
      });
      if (fault) throw fault;
      throw new Error(`google ${res.status}`);
    });
  }
}
