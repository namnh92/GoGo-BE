import {
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type AreaAutocompletePort,
  type AreaPrediction,
  type PlaceProviderPort,
  type ResolvedProviderPlace,
} from './ports';
import { withResilience } from './resilience';

const RESILIENCE = {
  timeoutMs: 5000,
  retries: 2,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

/**
 * Google Places adapter (ADR-0004). Key stays server-side; attribution and
 * cache windows follow FR-PLACE-006. Only exercised when GOOGLE_MAPS_API_KEY
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
    const data = await this.call<{ places?: { id: string }[] }>(
      'google.searchText',
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        body: JSON.stringify({ textQuery: query }),
        fieldMask: 'places.id',
      },
    );
    return data.places?.[0]?.id ?? null;
  }

  async details(providerPlaceId: string): Promise<ResolvedProviderPlace | null> {
    type GooglePlace = {
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      rating?: number;
      userRatingCount?: number;
      businessStatus?: string;
      priceLevel?: string;
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
        'google.details',
        `https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}`,
        {
          method: 'GET',
          fieldMask:
            'id,displayName,formattedAddress,location,rating,userRatingCount,businessStatus,priceLevel,regularOpeningHours',
        },
      );
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      if (err instanceof ProviderQuotaExceededError) throw err;
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
      if (res.ok) this.metrics.increment('places_provider_cost_units', { sku: name });
      // 429 / RESOURCE_EXHAUSTED pauses the import instead of retrying into
      // an exhausted budget (spec §9.4).
      if (res.status === 429) throw new ProviderQuotaExceededError('google.places');
      if (!res.ok) throw new Error(`google ${res.status}`);
      return (await res.json()) as T;
    });
  }
}
