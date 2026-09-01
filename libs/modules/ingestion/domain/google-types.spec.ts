import { describe, expect, it } from 'vitest';
import { categoryForGoogleType, deriveCategory, familyForGoogleType } from './google-types';

/**
 * PI-BE-023 — one Google-type table, two views, and a derivation that must be
 * predictable enough for an operator to reason about before they import.
 */

/** The eight keys `libs/database/src/seed.ts` actually creates. */
const SEEDED_CATEGORIES = new Set([
  'cafe',
  'restaurant',
  'bar',
  'park',
  'museum',
  'cinema',
  'shopping',
  'lodging',
]);

describe('categoryForGoogleType', () => {
  it('never proposes a key the catalog does not have', () => {
    const googleTypes = [
      'cafe',
      'coffee_shop',
      'bakery',
      'restaurant',
      'food',
      'fast_food_restaurant',
      'bar',
      'night_club',
      'karaoke',
      'park',
      'garden',
      'museum',
      'art_gallery',
      'movie_theater',
      'shopping_mall',
      'store',
      'lodging',
      'hotel',
      'vietnamese_restaurant',
    ];
    for (const type of googleTypes) {
      const key = categoryForGoogleType(type);
      expect(SEEDED_CATEGORIES.has(key!), `${type} → ${key}`).toBe(true);
    }
  });

  it('resolves cuisine-specific restaurant types by suffix', () => {
    expect(categoryForGoogleType('vietnamese_restaurant')).toBe('restaurant');
    expect(categoryForGoogleType('ramen_restaurant')).toBe('restaurant');
    // An explicit entry still wins over the suffix rule.
    expect(categoryForGoogleType('fast_food_restaurant')).toBe('restaurant');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(categoryForGoogleType(' Coffee_Shop ')).toBe('cafe');
  });

  it('returns undefined for a type GoGo has no honest category for', () => {
    // The rule the HCM sheet was breaking: a tourist attraction is not a park.
    // Bến Thành market, the War Remnants Museum and a rooftop bar are all
    // tourist attractions, and none of them is a park.
    expect(categoryForGoogleType('tourist_attraction')).toBeUndefined();
    expect(categoryForGoogleType('historical_landmark')).toBeUndefined();
    expect(categoryForGoogleType('amusement_center')).toBeUndefined();
    expect(categoryForGoogleType('point_of_interest')).toBeUndefined();
    expect(categoryForGoogleType('dentist')).toBeUndefined();
    expect(categoryForGoogleType('')).toBeUndefined();
    expect(categoryForGoogleType(null)).toBeUndefined();
  });

  it('never maps a `setting` taxonomy value as though it were a category', () => {
    for (const setting of ['rooftop', 'indoor', 'outdoor', 'riverside']) {
      expect(categoryForGoogleType(setting)).toBeUndefined();
    }
  });
});

describe('familyForGoogleType', () => {
  it('keeps the coarse grouping identity-change relies on', () => {
    expect(familyForGoogleType('bakery')).toBe(familyForGoogleType('cafe'));
    expect(familyForGoogleType('meal_takeaway')).toBe(familyForGoogleType('restaurant'));
    expect(familyForGoogleType('karaoke')).toBe(familyForGoogleType('night_club'));
    expect(familyForGoogleType('hotel')).toBe(familyForGoogleType('lodging'));
    expect(familyForGoogleType('art_gallery')).toBe(familyForGoogleType('museum'));
  });

  it('still interprets types that name no category', () => {
    // The reason family and category are separate views of one table: losing
    // these would stop `restaurant → tourist_attraction` reading as a change.
    expect(familyForGoogleType('tourist_attraction')).toBe('outdoor');
    expect(familyForGoogleType('amusement_center')).toBe('entertainment');
    expect(familyForGoogleType('historical_landmark')).toBe('culture');
  });

  it('says nothing about a type it cannot interpret', () => {
    expect(familyForGoogleType('point_of_interest')).toBeUndefined();
    expect(familyForGoogleType('dentist')).toBeUndefined();
  });
});

describe('deriveCategory', () => {
  it('takes primaryType when it maps — Google’s own answer to "mainly what"', () => {
    expect(
      deriveCategory({ primaryType: 'coffee_shop', types: ['coffee_shop', 'cafe', 'food'] }),
    ).toEqual({ key: 'cafe', source: 'google_primary_type', fromType: 'coffee_shop' });
  });

  it('falls back to types[] when primaryType maps to nothing', () => {
    expect(
      deriveCategory({ primaryType: 'point_of_interest', types: ['museum', 'establishment'] }),
    ).toEqual({ key: 'museum', source: 'google_types', fromType: 'museum' });
  });

  it('ranks rather than trusting array order', () => {
    // Same set, two orders Google could legitimately return. The answer must
    // not depend on which one arrives.
    const a = deriveCategory({ types: ['restaurant', 'food', 'cafe', 'store'] });
    const b = deriveCategory({ types: ['store', 'cafe', 'food', 'restaurant'] });
    expect(a).toEqual(b);
    expect(a?.key).toBe('cafe');
  });

  it('lets a specific type beat the generic parents hung off it', () => {
    // A café: `restaurant` and `food` are attached to almost every F&B place.
    expect(deriveCategory({ types: ['cafe', 'restaurant', 'food'] })?.key).toBe('cafe');
    // A bar with a kitchen is still a bar.
    expect(deriveCategory({ types: ['bar', 'restaurant', 'food'] })?.key).toBe('bar');
    // A hotel with a restaurant and a rooftop bar is a hotel.
    expect(deriveCategory({ types: ['restaurant', 'bar', 'lodging'] })?.key).toBe('lodging');
    // A museum café is a museum.
    expect(deriveCategory({ types: ['cafe', 'museum'] })?.key).toBe('museum');
    // A mall tenant is not the mall.
    expect(deriveCategory({ types: ['clothing_store', 'shopping_mall'] })?.key).toBe('shopping');
  });

  it('a plain restaurant still resolves to restaurant', () => {
    expect(deriveCategory({ primaryType: 'restaurant', types: ['restaurant', 'food'] })).toEqual({
      key: 'restaurant',
      source: 'google_primary_type',
      fromType: 'restaurant',
    });
  });

  it('returns null when Google describes the place in terms GoGo has no category for', () => {
    expect(
      deriveCategory({
        primaryType: 'tourist_attraction',
        types: ['tourist_attraction', 'point_of_interest', 'establishment'],
      }),
    ).toBeNull();
    expect(deriveCategory({ types: [] })).toBeNull();
    expect(deriveCategory({})).toBeNull();
  });

  it('is stable across repeated calls', () => {
    const input = { types: ['store', 'cafe', 'restaurant', 'bar', 'lodging', 'museum'] };
    const results = Array.from({ length: 5 }, () => deriveCategory(input));
    expect(new Set(results.map((r) => r?.key)).size).toBe(1);
    expect(results[0]?.key).toBe('lodging');
  });
});
