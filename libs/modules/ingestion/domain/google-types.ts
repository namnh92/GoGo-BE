/**
 * PI-BE-023 — one table for "what does this Google type mean to GoGo".
 *
 * There were two, in opposite directions and at different granularities:
 * `identity-change.ts` held Google type → coarse *family*, and `match-score.ts`
 * held GoGo category → Google type[]. Neither knew about the other, so
 * `shopping` had no family entry in one and `coffee_shop` had no category in
 * the other, and nothing made them agree.
 *
 * They are kept apart on purpose, though, because they answer different
 * questions:
 *
 *   - **category** is a GoGo taxonomy key. It only exists where the mapping is
 *     safe enough to put on a published place.
 *   - **family** is deliberately coarser and always present. It exists to
 *     answer "did this become a different kind of business", where `bakery` and
 *     `cafe` must count as the same thing and `tourist_attraction` is a usable
 *     signal even though it names no GoGo category.
 *
 * So one source table carries both, and each consumer reads the view it needs.
 *
 * Category keys here are a *proposal*. Every caller checks the result against
 * the live taxonomy before using it, so this table can never introduce a key
 * the catalog does not have.
 */

/** Coarse business kind. Not a taxonomy — never persisted, never shown. */
export type TypeFamily =
  'cafe' | 'food' | 'nightlife' | 'outdoor' | 'culture' | 'entertainment' | 'shopping' | 'lodging';

type TypeEntry = {
  /** GoGo category key, where this type implies one honestly. */
  category?: string;
  family: TypeFamily;
};

/**
 * Google Place types (New API) GoGo can interpret.
 *
 * A type with no `category` is not an oversight: it means Google has told us
 * something real about the business without telling us which of GoGo's eight
 * categories it belongs to. `tourist_attraction` is the case that matters —
 * Bến Thành market, the War Remnants Museum and a rooftop bar are all tourist
 * attractions, and collapsing them into `park` would put a wrong category on a
 * published place to save an operator one column.
 */
const TYPES: Readonly<Record<string, TypeEntry>> = {
  // — cafe ------------------------------------------------------------------
  cafe: { category: 'cafe', family: 'cafe' },
  coffee_shop: { category: 'cafe', family: 'cafe' },
  bakery: { category: 'cafe', family: 'cafe' },
  tea_house: { category: 'cafe', family: 'cafe' },
  dessert_shop: { category: 'cafe', family: 'cafe' },
  ice_cream_shop: { category: 'cafe', family: 'cafe' },
  juice_shop: { category: 'cafe', family: 'cafe' },

  // — restaurant ------------------------------------------------------------
  restaurant: { category: 'restaurant', family: 'food' },
  food: { category: 'restaurant', family: 'food' },
  meal_takeaway: { category: 'restaurant', family: 'food' },
  meal_delivery: { category: 'restaurant', family: 'food' },
  fast_food_restaurant: { category: 'restaurant', family: 'food' },
  food_court: { category: 'restaurant', family: 'food' },

  // — bar -------------------------------------------------------------------
  bar: { category: 'bar', family: 'nightlife' },
  pub: { category: 'bar', family: 'nightlife' },
  wine_bar: { category: 'bar', family: 'nightlife' },
  bar_and_grill: { category: 'bar', family: 'nightlife' },
  night_club: { category: 'bar', family: 'nightlife' },
  karaoke: { category: 'bar', family: 'nightlife' },

  // — park ------------------------------------------------------------------
  park: { category: 'park', family: 'outdoor' },
  national_park: { category: 'park', family: 'outdoor' },
  state_park: { category: 'park', family: 'outdoor' },
  dog_park: { category: 'park', family: 'outdoor' },
  garden: { category: 'park', family: 'outdoor' },
  botanical_garden: { category: 'park', family: 'outdoor' },
  hiking_area: { category: 'park', family: 'outdoor' },

  // — museum ----------------------------------------------------------------
  museum: { category: 'museum', family: 'culture' },
  art_gallery: { category: 'museum', family: 'culture' },

  // — cinema ----------------------------------------------------------------
  movie_theater: { category: 'cinema', family: 'entertainment' },

  // — shopping --------------------------------------------------------------
  shopping_mall: { category: 'shopping', family: 'shopping' },
  department_store: { category: 'shopping', family: 'shopping' },
  store: { category: 'shopping', family: 'shopping' },
  supermarket: { category: 'shopping', family: 'shopping' },
  convenience_store: { category: 'shopping', family: 'shopping' },
  clothing_store: { category: 'shopping', family: 'shopping' },
  book_store: { category: 'shopping', family: 'shopping' },
  market: { category: 'shopping', family: 'shopping' },

  // — lodging ---------------------------------------------------------------
  lodging: { category: 'lodging', family: 'lodging' },
  hotel: { category: 'lodging', family: 'lodging' },
  resort_hotel: { category: 'lodging', family: 'lodging' },
  motel: { category: 'lodging', family: 'lodging' },
  guest_house: { category: 'lodging', family: 'lodging' },
  hostel: { category: 'lodging', family: 'lodging' },
  bed_and_breakfast: { category: 'lodging', family: 'lodging' },

  // — interpretable, but naming no GoGo category ----------------------------
  tourist_attraction: { family: 'outdoor' },
  historical_landmark: { family: 'culture' },
  performing_arts_theater: { family: 'culture' },
  amusement_center: { family: 'entertainment' },
  amusement_park: { family: 'entertainment' },
};

/**
 * Google keeps adding cuisine-specific restaurant types
 * (`vietnamese_restaurant`, `ramen_restaurant`, …) faster than any table is
 * maintained, and every one of them is a restaurant. The suffix is the rule;
 * anything the table names explicitly still wins, so `fast_food_restaurant`
 * resolves from `TYPES` rather than from here.
 *
 * Deliberately the only pattern: `_store` looked tempting until
 * `liquor_store`, `convenience_store` and `pet_store` turned out to want three
 * different answers.
 */
const RESTAURANT_SUFFIX = '_restaurant';

/**
 * Which category wins when a place carries several.
 *
 * Google hangs generic parents off almost every commercial place: a specialty
 * coffee bar comes back as `cafe, coffee_shop, food, restaurant, store,
 * point_of_interest`. Array order is the provider's business and is not
 * promised to be stable, so position cannot decide — otherwise the same place
 * could import as `cafe` today and `restaurant` after a provider-side reshuffle.
 *
 * Lower wins. The order is "how often is this type attached to a place that is
 * really something else":
 *
 *   1. `lodging`    — attached to hotels and nothing else.
 *   2. `museum`     — specific; a museum café is still a museum.
 *   3. `cinema`     — specific.
 *   4. `bar`        — a place Google calls a bar is a bar, food menu or not.
 *   5. `cafe`       — must outrank `restaurant`, which hangs off most cafés.
 *   6. `park`       — specific, but loses to a venue *inside* the park.
 *   7. `shopping`   — `shopping_mall` and `store` attach to mall tenants.
 *   8. `restaurant` — the most over-attached F&B parent of all; last.
 */
const CATEGORY_RANK: Readonly<Record<string, number>> = {
  lodging: 1,
  museum: 2,
  cinema: 3,
  bar: 4,
  cafe: 5,
  park: 6,
  shopping: 7,
  restaurant: 8,
};

function entryFor(type: string): TypeEntry | undefined {
  const key = type.trim().toLowerCase();
  if (!key) return undefined;
  const exact = TYPES[key];
  if (exact) return exact;
  if (key.endsWith(RESTAURANT_SUFFIX)) return TYPES.restaurant;
  return undefined;
}

/** GoGo category a single Google type implies, or undefined when none does. */
export function categoryForGoogleType(type: string | null | undefined): string | undefined {
  return type ? entryFor(type)?.category : undefined;
}

/**
 * Coarse family, for "is this still the same kind of business".
 * Undefined means "we cannot tell" — which must never be reported as a change.
 */
export function familyForGoogleType(type: string | null | undefined): TypeFamily | undefined {
  return type ? entryFor(type)?.family : undefined;
}

/** Where a derived category came from, so a row can explain itself. */
export type CategorySource = 'google_primary_type' | 'google_types';

export type DerivedCategory = { key: string; source: CategorySource; fromType: string };

/**
 * Google's view of a place → one GoGo category, deterministically.
 *
 * `primaryType` wins whenever it maps: it is Google's own answer to "what is
 * this place mainly", and honouring it is what lets an operator predict the
 * outcome. Only when it maps to nothing does rank over `types[]` decide.
 *
 * Returns null when Google described the place in terms GoGo has no category
 * for. That is an answer, not a failure — the caller asks a human.
 */
export function deriveCategory(place: {
  primaryType?: string | null;
  types?: readonly string[] | null;
}): DerivedCategory | null {
  const primary = categoryForGoogleType(place.primaryType);
  if (primary && place.primaryType) {
    return { key: primary, source: 'google_primary_type', fromType: place.primaryType };
  }

  let best: DerivedCategory | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const type of place.types ?? []) {
    const category = categoryForGoogleType(type);
    if (!category) continue;
    const rank = CATEGORY_RANK[category] ?? Number.POSITIVE_INFINITY;
    // Strict `<`: the first type at a given rank wins, but since rank is per
    // category and each category has exactly one, a tie means the same answer.
    if (rank < bestRank) {
      bestRank = rank;
      best = { key: category, source: 'google_types', fromType: type };
    }
  }
  return best;
}
