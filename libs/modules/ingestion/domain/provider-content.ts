import {
  GOOGLE_ATTRIBUTION,
  type PlaceDescriptionTier,
  type ResolvedProviderPlace,
} from '@gogo/providers';

/**
 * #341 (PR8) — the ephemeral provider-content boundary (ADR-0006 §9.7).
 *
 * Under the MVP policy, rich Google content — name, address, rating, hours,
 * price level, business status, coordinates — may be *fetched* for one
 * operation and then must be *discarded*. Nothing may write it to Postgres,
 * Redis, an audit diff, a metric label or a log line, and nothing may hand it
 * to a later request. The Place ID is the one thing that may outlive the
 * request.
 *
 * This file is that rule made structural. A caller that needs Google's
 * current answer gets an `EphemeralProviderContent`, and the type is built so
 * the existing persistence paths cannot take it by accident:
 *
 * - It is **not** a `ResolvedProviderPlace`. No `providerPlaceId` at the top
 *   level, no `fetchTier`, no `raw`, no `photos`, no `attribution` string
 *   that could be re-wrapped — so `upsertProviderSource`, `createPlace` and
 *   every other method whose parameter is the resolved shape refuses it at
 *   compile time (`provider-content.spec.ts` pins that with a
 *   `@ts-expect-error`).
 * - It is **deeply frozen**. A repository that tried to mutate a field before
 *   writing throws in strict mode rather than succeeding quietly.
 * - It carries a `kind` discriminator, so a structural scan can find every
 *   file that names it (`provider-content-boundary.spec.ts`) and refuse a
 *   write statement in any of them.
 *
 * What it deliberately does *not* do is make the object unreadable. The whole
 * point is that a moderator can see Google's current name next to GoGo's and
 * decide — the value is meant to be rendered, compared and reasoned about,
 * within the request that fetched it.
 */

export const PROVIDER_CONTENT_KIND = 'ephemeral_provider_content' as const;

/**
 * The tiers a caller may ask for. Same set as `PlaceDescriptionTier` — the
 * described tiers of PR5 (#338) — and, like there, **no default**: a caller
 * that has not decided what it reads has not decided what it pays for.
 * `liveness` is excluded on purpose: an identity answer carries no content and
 * has its own path (PR7's refresh).
 */
export const PROVIDER_CONTENT_TIERS = [
  'core',
  'quality',
  'detail',
] as const satisfies readonly PlaceDescriptionTier[];
export type ProviderContentTier = (typeof PROVIDER_CONTENT_TIERS)[number];

export type ProviderContentHours = Readonly<{
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
  isOvernight: boolean;
}>;

/**
 * The fields only a `quality` (or `detail`) fetch buys.
 *
 * Present as a block rather than as nullable fields on the parent so that a
 * `core` answer cannot be misread: under `core` the adapter reports
 * `ratingCount: 0` and `hours: []` because the mask did not ask, and a
 * consumer reading those as facts would tell a moderator "no reviews, no
 * hours" about a place with hundreds of both. `quality: null` says "not
 * fetched", which is the truth.
 */
export type ProviderContentQualityFacts = Readonly<{
  rating: number | null;
  ratingCount: number;
  hours: readonly ProviderContentHours[];
  priceLevel: number | null;
}>;

export type ProviderContentFacts = Readonly<{
  name: string;
  addressText: string;
  location: Readonly<{ lat: number; lng: number }>;
  businessStatus: ResolvedProviderPlace['businessStatus'];
  primaryType: string | null;
  types: readonly string[];
  googleMapsUri: string | null;
  quality: ProviderContentQualityFacts | null;
}>;

export type EphemeralProviderContent = Readonly<{
  kind: typeof PROVIDER_CONTENT_KIND;
  /** The id Google answered with. */
  googlePlaceId: string;
  /** The id that was asked for. Differs from `googlePlaceId` when Google answered as a successor. */
  requestedGooglePlaceId: string;
  /** `googlePlaceId !== requestedGooglePlaceId` — Google answered under another id. */
  moved: boolean;
  tier: ProviderContentTier;
  /** ISO-8601, the moment of this fetch. Not a storage clock; there is no storage. */
  fetchedAt: string;
  /** Canonical presentation-boundary attribution (PR6, #339). */
  attribution: typeof GOOGLE_ATTRIBUTION;
  facts: ProviderContentFacts;
}>;

/**
 * What one fetch produced.
 *
 * `not_found` and `invalid_id` are *answers* from Google, not failures of
 * GoGo's — the provider looked. A provider that could not look (outage,
 * quota, configuration) is not an outcome and is thrown as
 * `PLACE_PROVIDER_UNAVAILABLE` by the service, the same split #279 and PR6
 * settled for every other path. Neither answer may be turned into a
 * `source_status` write: only PR7's scheduled liveness path and a moderator
 * decide what the catalogue records.
 */
export type ProviderContentAnswer =
  | Readonly<{ outcome: 'found'; content: EphemeralProviderContent }>
  | Readonly<{
      outcome: 'not_found' | 'invalid_id';
      requestedGooglePlaceId: string;
      tier: ProviderContentTier;
      fetchedAt: string;
    }>;

/**
 * The only constructor. Picks fields by name — never spreads the resolved
 * object — so a field added to `ResolvedProviderPlace` later does not leak
 * through here unreviewed, and freezes every level.
 */
export function toEphemeralProviderContent(
  details: ResolvedProviderPlace,
  tier: ProviderContentTier,
  now: Date,
): EphemeralProviderContent {
  const requestedGooglePlaceId = details.requestedProviderPlaceId ?? details.providerPlaceId;
  const quality: ProviderContentQualityFacts | null =
    tier === 'core'
      ? null
      : frozen({
          rating: details.rating,
          ratingCount: details.ratingCount,
          hours: frozen(
            details.hours.map((h) =>
              frozen({
                dayOfWeek: h.dayOfWeek,
                openMinute: h.openMinute,
                closeMinute: h.closeMinute,
                isOvernight: h.isOvernight,
              }),
            ),
          ),
          priceLevel: details.priceLevel,
        });

  return frozen({
    kind: PROVIDER_CONTENT_KIND,
    googlePlaceId: details.providerPlaceId,
    requestedGooglePlaceId,
    moved: requestedGooglePlaceId !== details.providerPlaceId,
    tier,
    fetchedAt: now.toISOString(),
    attribution: GOOGLE_ATTRIBUTION,
    facts: frozen({
      name: details.name,
      addressText: details.addressText,
      location: frozen({ lat: details.lat, lng: details.lng }),
      businessStatus: details.businessStatus,
      primaryType: details.primaryType,
      types: frozen([...details.types]),
      googleMapsUri: details.googleMapsUri,
      quality,
    }),
  });
}

function frozen<T>(value: T): T {
  return Object.freeze(value);
}
