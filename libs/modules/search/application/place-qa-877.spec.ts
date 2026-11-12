import { describe, expect, it, vi } from 'vitest';
import { SearchService } from './search.service';
import { SearchRepository } from '../infrastructure/search.repository';
import { AssistantCardHydrator } from '../../assistant/application/card-hydrator.service';
import { placeQaRead } from '../infrastructure/place-qa-read';
import { FIXTURE_A } from '../../assistant/domain/place-qa/fixtures';
import { renderPlaceAnswer } from '../../assistant/domain/place-qa/templates';

vi.mock('../infrastructure/place-qa-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  placeQaRead: vi.fn(),
}));

function fixture(overrides: Record<string, unknown> = {}) {
  const detail = {
    id: FIXTURE_A,
    name: 'The Workshop Coffee',
    status: 'published',
    checked_in_group_count: null,
    address_text: '12 Đường Mây',
    rating: '4.5',
    rating_count: 2100,
    gogo_rating_count: 5,
    gogo_rating_mean: '4.2',
    prices: [{ priceMin: 90000, priceMax: 180000, currency: 'VND', unit: 'per_person' }],
    ...overrides,
  };
  const row = {
    id: FIXTURE_A,
    name: detail.name,
    status: detail.status,
    provider_closed: false,
    lat: 21,
    lng: 105,
    area_summary: null,
    address_text: detail.address_text,
    phone: null,
    hours: [],
    prices: [],
    provenance: [],
    gogo_rating_count: detail.gogo_rating_count,
    gogo_rating_mean: detail.gogo_rating_mean,
    card_detail: detail,
    identity_collision: true,
  };
  const repo = new SearchRepository({} as never);
  vi.spyOn(repo, 'placeDetail').mockResolvedValue(detail);
  const execute = vi.fn(async () => ({ rows: [row] }));
  vi.mocked(placeQaRead).mockImplementation(async (_db, _ms, _options, work) =>
    work({ execute } as never),
  );
  const search = new SearchService(repo, {} as never);
  return {
    row,
    search,
    execute,
    hydrator: new AssistantCardHydrator(search, {} as never, {} as never, {} as never),
  };
}
async function read(f: ReturnType<typeof fixture>) {
  return f.search.placeFacts([FIXTURE_A], {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 2000,
  });
}
describe('GoGo-BE#877 shared PlaceDetail projection', () => {
  it('877-CARD-SQL: one bounded read feeds the exact same card projection as the hydrator', async () => {
    const f = fixture();
    const context = await read(f);
    const place = context.places.get(FIXTURE_A)!;
    expect(place.card).toEqual(await f.hydrator.placeCard(FIXTURE_A));
    expect(place.card?.facts).toMatchObject({
      addressText: '12 Đường Mây',
      priceMin: 90000,
      providerRating: 4.5,
      providerRatingCount: 2100,
      providerRatingSource: 'google',
      gogoRating: 4.2,
      gogoRatingCount: 5,
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(Object.isFrozen(place.card?.facts)).toBe(true);
    // A visible card never promotes absent topic evidence to verified prose.
    expect(
      renderPlaceAnswer({ placeId: FIXTURE_A, locale: 'vi', topic: 'address' }, context).tier,
    ).toBe('absent');
  });
  it('omits unknown price/address/rating; keeps the real below-threshold community count', async () => {
    const f = fixture({
      address_text: null,
      rating: null,
      gogo_rating_count: 4,
      gogo_rating_mean: '4.2',
      prices: [{ priceMin: 90000, priceMax: 180000, currency: 'VND', unit: null }],
    });
    const facts = (await read(f)).places.get(FIXTURE_A)!.card!.facts;
    for (const field of [
      'addressText',
      'priceMin',
      'providerRating',
      'providerRatingCount',
      'providerRatingSource',
      'gogoRating',
    ])
      expect(facts).not.toHaveProperty(field);
    expect(facts.gogoRatingCount).toBe(4);
  });
  it('does not hydrate closed/unpublished records even if a detail snapshot is present', async () => {
    const f = fixture({ status: 'draft' });
    const p = (await read(f)).places.get(FIXTURE_A)!;
    expect(p.available).toBe(false);
    expect(p.card).toBeUndefined();
  });
});
