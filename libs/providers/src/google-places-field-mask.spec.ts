import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesAdapter, PLACE_FIELD_MASKS } from './google-places.adapter';
import type { PlaceFetchTier } from './ports';

/**
 * PI-BE-023 / COST-BE-005 — the field mask *is* the cost decision (ADR-0006 §2,
 * plan §2.4).
 *
 * These assert the exact string sent to Google, not a subset, because the way
 * this drifted the first time was a plausible-looking edit: the shipped mask
 * carried the `quality` aggregates while silently dropping `types`,
 * `googleMapsUri` and `photos`, all three of which the ADR puts in `core`. A
 * containment check would have passed throughout.
 *
 * Four tiers now, and the prices they map to are 0 / 17 / 20 / 25 USD per
 * thousand. One word added to one of these strings can multiply a bill; that
 * is why the assertion is equality.
 */

/**
 * `liveness` is `id` and nothing else — Google's Place Details **IDs-Only**
 * SKU, free and unlimited.
 *
 * Plan §2.4 writes this mask as `id,movedPlaceId`. `movedPlaceId` is not a
 * field of the Places API (New) `Place` resource, so that mask would make
 * Google reject every liveness request with `INVALID_ARGUMENT` — invisibly,
 * because the stub transport does not validate field paths. Moved places are
 * detected by comparing the id Google answered with against the one we asked
 * for (#334), which needs no extra field and works at every tier.
 */
const ADR_LIVENESS = ['id'];
const ADR_CORE = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'businessStatus',
  'primaryType',
  'types',
  'googleMapsUri',
  'photos',
];
const ADR_QUALITY = [
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'priceLevel',
  'priceRange',
];
const ADR_DETAIL = ['reviews'];

describe('ADR-0006 §2 field-mask tiers', () => {
  it('liveness is IDs-only — one field, the free SKU', () => {
    expect(PLACE_FIELD_MASKS.liveness).toBe(ADR_LIVENESS.join(','));
  });

  it('liveness asks for nothing Google bills for', () => {
    // Every field that would lift the request off IDs-Only. `businessStatus`
    // is on this list on purpose: it is a Pro field, which is why there is no
    // cheaper "is it still open?" tier to be had (#338 scope note).
    const billed = [...ADR_CORE.filter((f) => f !== 'id'), ...ADR_QUALITY, ...ADR_DETAIL];
    for (const field of billed) {
      expect(PLACE_FIELD_MASKS.liveness.split(',')).not.toContain(field);
    }
  });

  it('core is exactly the fields the ADR lists', () => {
    expect(PLACE_FIELD_MASKS.core).toBe(ADR_CORE.join(','));
  });

  it('quality is core plus the quality fields, in that order', () => {
    expect(PLACE_FIELD_MASKS.quality).toBe([...ADR_CORE, ...ADR_QUALITY].join(','));
  });

  it('detail is quality plus reviews', () => {
    expect(PLACE_FIELD_MASKS.detail).toBe([...ADR_CORE, ...ADR_QUALITY, ...ADR_DETAIL].join(','));
  });

  it('each tier is a strict superset of the one below it', () => {
    const fields = (tier: PlaceFetchTier) => PLACE_FIELD_MASKS[tier].split(',');
    expect(fields('core')).toEqual(expect.arrayContaining(fields('liveness')));
    expect(fields('quality')).toEqual(expect.arrayContaining(fields('core')));
    expect(fields('detail')).toEqual(expect.arrayContaining(fields('quality')));
    expect(fields('liveness').length).toBeLessThan(fields('core').length);
    expect(fields('core').length).toBeLessThan(fields('quality').length);
    expect(fields('quality').length).toBeLessThan(fields('detail').length);
  });

  it('core carries the three fields the shipped adapter was missing', () => {
    for (const field of ['types', 'googleMapsUri', 'photos']) {
      expect(PLACE_FIELD_MASKS.core.split(',')).toContain(field);
    }
  });

  it('no tier requests a field outside the ADR — phone/website stay in #280', () => {
    const allowed = new Set([...ADR_LIVENESS, ...ADR_CORE, ...ADR_QUALITY, ...ADR_DETAIL]);
    for (const mask of Object.values(PLACE_FIELD_MASKS)) {
      for (const field of mask.split(',')) expect(allowed.has(field)).toBe(true);
    }
    expect(PLACE_FIELD_MASKS.detail).not.toMatch(/nationalPhoneNumber|websiteUri|editorialSummary/);
  });
});

describe('GooglePlacesAdapter.details', () => {
  const googlePlace = {
    id: 'ChIJ-lacaph',
    displayName: { text: 'Lacàph Coffee Experiences Space' },
    formattedAddress: '76 Nguyễn Thị Minh Khai, Quận 3, TP.HCM',
    location: { latitude: 10.7845, longitude: 106.6912 },
    businessStatus: 'OPERATIONAL',
    primaryType: 'coffee_shop',
    types: ['coffee_shop', 'cafe', 'food', 'point_of_interest', 'establishment'],
    googleMapsUri: 'https://maps.google.com/?cid=1234567890',
    photos: [
      {
        name: 'places/ChIJ-lacaph/photos/AeJbb3c',
        widthPx: 4032,
        heightPx: 3024,
        authorAttributions: [{ displayName: 'Minh Trần' }, {}],
      },
      { widthPx: 100 },
    ],
    rating: 4.7,
    userRatingCount: 812,
    priceLevel: 'PRICE_LEVEL_MODERATE',
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => googlePlace,
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const maskSent = () =>
    (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers[
      'X-Goog-FieldMask'
    ];

  it.each(['core', 'quality', 'detail'] as const)('sends the %s mask verbatim', async (tier) => {
    await new GooglePlacesAdapter('key').details('ChIJ-lacaph', tier);
    expect(maskSent()).toBe(PLACE_FIELD_MASKS[tier]);
  });

  it('sends the liveness mask verbatim', async () => {
    await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'liveness');
    expect(maskSent()).toBe(PLACE_FIELD_MASKS.liveness);
  });

  it('has no default tier — every caller states what it is paying for', () => {
    // The signature is the assertion: `details(id)` no longer compiles, which
    // is what stops a new call site from silently buying Enterprise (#338).
    // @ts-expect-error tier is required
    void (() => new GooglePlacesAdapter('key').details('ChIJ-lacaph'));
  });

  it('records the tier it fetched at, so the row says what it may contain', async () => {
    const place = await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'core');
    expect(place?.fetchTier).toBe('core');
  });

  it('a liveness answer is an identity, not a place with empty facts', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'ChIJ-lacaph' }),
    }));
    const identity = await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'liveness');
    // Exactly these keys. A `ratingCount: 0` or a `lat: 0` here would be a
    // fetched-nothing dressed up as a measured value.
    expect(identity).toEqual({ providerPlaceId: 'ChIJ-lacaph', fetchTier: 'liveness' });
  });

  it('liveness still reports a place that moved', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'ChIJ-new' }),
    }));
    const identity = await new GooglePlacesAdapter('key').details('ChIJ-old', 'liveness');
    expect(identity).toEqual({
      providerPlaceId: 'ChIJ-new',
      requestedProviderPlaceId: 'ChIJ-old',
      fetchTier: 'liveness',
    });
  });

  it('liveness raises the same NOT_FOUND every other tier does', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { status: 'NOT_FOUND', message: 'not found' } }),
    }));
    // #314's classification is shared, not re-derived per tier: a refresh job
    // has to tell "this id is retired" apart from "Google is down", and it gets
    // that distinction from the same place a resolve does.
    await expect(
      new GooglePlacesAdapter('key').details('ChIJ-gone', 'liveness'),
    ).rejects.toMatchObject({ canonicalStatus: 'NOT_FOUND' });
  });

  it('labels the cost counter per tier — the SKU differs', async () => {
    const increments: Record<string, unknown>[] = [];
    const adapter = new GooglePlacesAdapter('key', {
      increment: (name, labels) => void increments.push({ name, ...labels }),
      observe: () => undefined,
    });
    await adapter.details('ChIJ-lacaph', 'detail');
    expect(increments).toContainEqual(
      expect.objectContaining({ name: 'places_provider_cost_units', sku: 'google.details.detail' }),
    );
  });

  it.each(['liveness', 'core', 'quality', 'detail'] as const)(
    'labels the %s request and its cost unit with that tier',
    async (tier) => {
      const increments: Record<string, unknown>[] = [];
      const adapter = new GooglePlacesAdapter('key', {
        increment: (name, labels) => void increments.push({ name, ...labels }),
        observe: () => undefined,
      });
      await adapter.details('ChIJ-lacaph', tier);
      // Both counters, because the ledger prices by SKU and the dashboard
      // counts by method. A tier that moved one and not the other would make
      // the two disagree about what the same call was.
      expect(increments).toContainEqual(
        expect.objectContaining({
          name: 'places_provider_requests_total',
          method: `google.details.${tier}`,
        }),
      );
      expect(increments).toContainEqual(
        expect.objectContaining({
          name: 'places_provider_cost_units',
          sku: `google.details.${tier}`,
        }),
      );
    },
  );

  it('normalizes types with primaryType first and no duplicates', async () => {
    const place = await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'quality');
    expect(place?.primaryType).toBe('coffee_shop');
    expect(place?.types).toEqual([
      'coffee_shop',
      'cafe',
      'food',
      'point_of_interest',
      'establishment',
    ]);
  });

  it('keeps a primaryType Google left out of types', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...googlePlace, primaryType: 'karaoke', types: ['bar'] }),
    }));
    const place = await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'quality');
    expect(place?.types).toEqual(['karaoke', 'bar']);
  });

  it('carries googleMapsUri through', async () => {
    const place = await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'quality');
    expect(place?.googleMapsUri).toBe('https://maps.google.com/?cid=1234567890');
  });

  it('normalizes photos to references with attributions, dropping nameless ones', async () => {
    const place = await new GooglePlacesAdapter('key').details('ChIJ-lacaph', 'quality');
    expect(place?.photos).toEqual([
      {
        reference: 'places/ChIJ-lacaph/photos/AeJbb3c',
        widthPx: 4032,
        heightPx: 3024,
        attributions: ['Minh Trần'],
      },
    ]);
  });

  it('survives a provider that omits the new core fields entirely', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'ChIJ-x',
        displayName: { text: 'Quán X' },
        location: { latitude: 10.7, longitude: 106.7 },
      }),
    }));
    const place = await new GooglePlacesAdapter('key').details('ChIJ-x', 'quality');
    expect(place).toMatchObject({ types: [], googleMapsUri: null, photos: [] });
  });
});
