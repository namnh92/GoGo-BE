import type { SearchService } from '../../search/application/search.service';
import { openStateAt } from '../../search/application/search.service';
import type { HoursRow } from '../../search/infrastructure/search.repository';
import { GOOGLE_PROVIDER_PUBLIC } from '../../shared/google-provenance';
import type { PlaceCard } from './card-hydrator.service';

/** The single PlaceDetail → assistant card mapper, also used by place_qa's
 * bounded snapshot. Prices here are explicitly per person; prose tier policy
 * remains separate. Never persist the returned facts in conversation history. */
export function placeCardFromDetail(
  detail: Awaited<ReturnType<SearchService['placeDetail']>>,
  at = new Date(),
): PlaceCard {
  const placeId = detail.id;
  const hours = (
    detail.hours as {
      dayOfWeek: number;
      kind: HoursRow['entry_kind'];
      openMinute: number;
      closeMinute: number;
      isOvernight: boolean;
    }[]
  ).map((h): HoursRow => ({
    place_id: placeId,
    day_of_week: h.dayOfWeek,
    entry_kind: h.kind,
    open_minute: h.openMinute,
    close_minute: h.closeMinute,
    is_overnight: h.isOvernight,
  }));
  const price = detail.prices.find((p) => p.unit === 'per_person');
  const photo = detail.photos[0];
  return {
    kind: 'place',
    placeId,
    available: detail.status === 'published',
    facts: {
      name: detail.name,
      ...(detail.areaKey ? { areaKey: detail.areaKey } : {}),
      ...(detail.addressText ? { addressText: detail.addressText } : {}),
      ...(detail.priceLevel !== undefined && detail.priceLevel !== null
        ? { priceLevel: detail.priceLevel }
        : {}),
      ...(price
        ? { priceMin: price.priceMin, priceMax: price.priceMax, currency: price.currency }
        : {}),
      // Reuse PlaceDetail's verified provider values and freshness mapping.
      // ADR-0020 / core rule 14: keep attribution and count with the score;
      // Stored ratings also cover editor/seeded places without source rows,
      // just like PlaceSummary; no extra coercion, rounding, or TTL here.
      ...(detail.rating != null && Number.isFinite(detail.rating)
        ? {
            providerRating: detail.rating,
            providerRatingCount: detail.ratingCount,
            providerRatingSource: GOOGLE_PROVIDER_PUBLIC,
          }
        : {}),
      ...(detail.gogoRating !== undefined ? { gogoRating: detail.gogoRating } : {}),
      gogoRatingCount: detail.gogoRatingCount,
      openNow: hours.length > 0 ? openStateAt(hours, at).openNow : null,
      ...(photo ? { photoUrl: photo.url } : {}),
      ...(detail.freshnessCheckedAt ? { checkedAt: detail.freshnessCheckedAt } : {}),
    },
  };
}
