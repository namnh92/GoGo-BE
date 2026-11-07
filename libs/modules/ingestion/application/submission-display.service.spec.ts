import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { FakePlaceProvider } from '@gogo/providers';
import type { ProviderBudgetService } from '@gogo/cost-observability';
import { NoopMetrics } from '@gogo/observability';
import type { ProviderPhotosService } from '../../search/application/provider-photos.service';
import { SubmissionDisplayService } from './submission-display.service';

const providerId = 'submission-display-place';
function fixture() {
  const provider = new FakePlaceProvider();
  provider.seed({
    providerPlaceId: providerId,
    name: 'Café thật',
    shortAddress: 'P. Bến Thành, TP.HCM',
    attribution: 'Google Maps',
    raw: { secret: 'do not serialize' },
  });
  const execute = vi.fn().mockResolvedValue({ rows: [{ key: 'cafe' }] });
  const photo = {
    url: '/v1/places/google-provider-photo/submission-display-place',
    provider: 'google' as const,
    attribution: 'Google Maps',
    authorAttributions: [{ displayName: 'Author' }],
    googleMapsUri: null,
  };
  const candidateReference = vi.fn().mockResolvedValue(photo);
  const reserve = vi.fn().mockResolvedValue({ ok: true });
  const metrics = new NoopMetrics();
  const increment = vi.spyOn(metrics, 'increment');
  const service = new SubmissionDisplayService(
    { execute } as unknown as Db,
    provider,
    { candidateReference } as unknown as ProviderPhotosService,
    {
      PLACE_DISPLAY_DAILY_MAX_CALLS: 10,
      PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD: 1,
      PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY: 10,
    },
    metrics,
    { reserve } as unknown as ProviderBudgetService,
  );
  return { service, provider, execute, candidateReference, reserve, photo, increment };
}
afterEach(() => vi.useRealTimers());

describe('#801 live submission display', () => {
  it('reserves quality Details before the call and projects only attributed display facts and one proxy reference', async () => {
    const f = fixture();
    const answer = await f.service.get(providerId);
    expect(f.reserve).toHaveBeenCalledWith(
      { scope: 'google.places.display', operation: 'google.details.quality', calls: 1, units: 1 },
      {
        maxCallsPerDay: 10,
        maxListCostMicrosPerDay: 1_000_000,
        maxUnitsByOperation: { 'google.details.quality': 10 },
      },
    );
    expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      f.candidateReference.mock.invocationCallOrder[0]!,
    );
    expect(f.provider.tiersRequested).toEqual(['quality']);
    expect(answer).toEqual({
      providerStatus: 'ok',
      providerDisplay: {
        source: 'google_places',
        fetchedAt: expect.any(String),
        attributions: ['Google Maps'],
        googleMapsUri: expect.any(String),
        name: 'Café thật',
        addressShort: 'P. Bến Thành, TP.HCM',
        categoryKey: 'cafe',
        googleRating: 4.4,
        googleRatingCount: 250,
        openingHours: expect.any(Array),
        photo: f.photo,
      },
    });
    expect(JSON.stringify(answer)).not.toMatch(/secret|providerPlaceId|photoName|latitude|raw/);
    expect(f.increment).toHaveBeenCalledExactlyOnceWith('my_place_submission_display_total', {
      outcome: 'ok',
    });
  });

  it('makes no provider or photo call when budget is refused', async () => {
    const f = fixture();
    f.reserve.mockResolvedValue({ ok: false, reason: 'not_configured' });
    expect(await f.service.get(providerId)).toMatchObject({ providerStatus: 'budget_exhausted' });
    expect(f.provider.tiersRequested).toEqual([]);
    expect(f.candidateReference).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'unavailable', 'identity_mismatch'] as const)(
    'degrades %s without leaking raw provider data or changing identity',
    async (status) => {
      const f = fixture();
      if (status === 'unavailable') f.provider.failing = true;
      if (status === 'identity_mismatch') {
        f.provider.seed({ providerPlaceId: 'successor' });
        f.provider.movedTo.set(providerId, 'successor');
      }
      const answer = await f.service.get(status === 'not_found' ? 'missing' : providerId);
      expect(answer.providerStatus).toBe(status);
      expect(answer.providerDisplay).toBeUndefined();
      expect(f.candidateReference).not.toHaveBeenCalled();
    },
  );

  it('omits inactive category and missing photo and preserves unknown rating/hours', async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ rows: [] });
    f.candidateReference.mockResolvedValue(undefined);
    f.provider.seed({ providerPlaceId: providerId, hours: [], rating: null, ratingCount: 0 });
    const answer = await f.service.get(providerId);
    expect(answer.providerDisplay).toMatchObject({
      googleRating: null,
      googleRatingCount: 0,
      openingHours: [],
      addressShort: '1 Fake St, HCMC',
    });
    expect(answer.providerDisplay).not.toHaveProperty('categoryKey');
    expect(answer.providerDisplay).not.toHaveProperty('photo');
  });

  it('bounds a hung provider to six seconds and never fetches a photo after the deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.provider.registry.get(providerId)!;
    let finish!: (value: typeof original) => void;
    vi.spyOn(f.provider, 'details').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = f.service.get(providerId);
    await vi.advanceTimersByTimeAsync(6001);
    expect(await work).toMatchObject({ providerStatus: 'unavailable' });
    finish(original);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.candidateReference).not.toHaveBeenCalled();
    expect(f.increment).toHaveBeenCalledTimes(1);
  });
});
