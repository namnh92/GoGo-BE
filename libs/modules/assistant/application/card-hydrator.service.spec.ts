import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/app-error';
import { SearchService } from '../../search/application/search.service';
import { AssistantCardHydrator } from './card-hydrator.service';

const placeId = '1b2c3d4e-0000-4000-8000-000000000001';
const checkedAt = '2026-11-10T03:00:00.000Z';

function fixture(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: placeId,
    name: 'Verified café',
    status: 'published',
    lat: '10.77',
    lng: '106.7',
    rating: '4.6',
    rating_count: 980,
    sources: [{ provider: 'google', attribution: 'Powered by Google' }],
    freshness_checked_at: checkedAt,
    gogo_rating_count: 5,
    gogo_rating_mean: '4.3',
    ...overrides,
  };
  const search = new SearchService({ placeDetail: async () => row } as never, {} as never);
  const hydrator = new AssistantCardHydrator(search, {} as never, {} as never, {} as never);
  return { row, search, hydrator };
}

describe('Assistant verified provider rating facts (#834)', () => {
  it('reuses the PlaceDetail mapper and keeps Google and GoGo scores separate', async () => {
    const { search, hydrator } = fixture();
    const detail = await search.placeDetail(placeId);
    const card = await hydrator.placeCard(placeId);
    expect(card.facts).toMatchObject({
      providerRating: detail.rating,
      providerRatingCount: detail.ratingCount,
      providerRatingSource: 'google',
      gogoRating: 4.3,
      gogoRatingCount: 5,
      checkedAt: detail.freshnessCheckedAt,
    });
  });

  it.each([
    { rating: null },
    { rating: undefined },
    { sources: [] },
    { sources: [{ provider: 'other' }] },
  ])('omits all provider facts when data or Google provenance is absent: %j', async (row) => {
    const { hydrator } = fixture(row);
    const { facts } = await hydrator.placeCard(placeId);
    expect(facts).not.toHaveProperty('providerRating');
    expect(facts).not.toHaveProperty('providerRatingCount');
    expect(facts).not.toHaveProperty('providerRatingSource');
    expect(facts.gogoRating).toBe(4.3);
  });

  it.each([0, 5])(
    'preserves the provider scale boundary %s and a genuine zero count',
    async (rating) => {
      const { hydrator } = fixture({ rating: String(rating), rating_count: 0 });
      expect((await hydrator.placeCard(placeId)).facts).toMatchObject({
        providerRating: rating,
        providerRatingCount: 0,
        providerRatingSource: 'google',
      });
    },
  );

  it('accepts only card IDs from a ref; supplied model rating facts are ignored', async () => {
    const { hydrator } = fixture();
    const ref = {
      kind: 'place' as const,
      placeId,
      facts: { providerRating: 1, providerRatingCount: 999, providerRatingSource: 'other' },
    };
    const [card] = await hydrator.hydrate({} as never, [ref]);
    expect(card!.facts).toMatchObject({
      providerRating: 4.6,
      providerRatingCount: 980,
      providerRatingSource: 'google',
    });
  });

  it('returns only minimal facts for an unavailable place', async () => {
    const hydrator = new AssistantCardHydrator(
      {
        placeDetail: async () => {
          throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
        },
      } as never,
      {} as never,
      {} as never,
      { execute: async () => ({ rows: [{ name: 'Unavailable café' }] }) } as never,
    );
    expect(await hydrator.placeCard(placeId)).toEqual({
      kind: 'place',
      placeId,
      available: false,
      facts: { name: 'Unavailable café' },
    });
  });

  it('keeps the existing PlaceDetail freshness rules without inventing another TTL', async () => {
    const { search, hydrator } = fixture({ freshness_checked_at: '2020-01-01T00:00:00.000Z' });
    const detail = await search.placeDetail(placeId);
    const card = await hydrator.placeCard(placeId);
    expect(card.facts.providerRating).toBe(detail.rating);
    expect(card.facts.checkedAt).toBe(detail.freshnessCheckedAt);
  });

  it('re-reads current verified facts instead of keeping a snapshot in history', async () => {
    const { row, hydrator } = fixture();
    await hydrator.placeCard(placeId);
    row.rating = '3.8';
    row.rating_count = 1001;
    expect((await hydrator.placeCard(placeId)).facts).toMatchObject({
      providerRating: 3.8,
      providerRatingCount: 1001,
    });
    row.rating = null;
    expect((await hydrator.placeCard(placeId)).facts).not.toHaveProperty('providerRating');
  });
});
