import { afterEach, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { FakePlaceProvider } from '@gogo/providers';
import type { ProviderBudgetService } from '@gogo/cost-observability';
import type { ProviderPhotosService } from '../../search/application/provider-photos.service';
import type { Actor } from '../../identity/domain/actor';
import { MyPlaceSubmissionsService } from './my-place-submissions.service';
import { SubmissionDisplayService } from './submission-display.service';

afterEach(() => vi.useRealTimers());

it('F-01: opening and refreshing 25 distinct submissions makes ZERO provider calls', async () => {
  const actor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' } as Actor;
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `${i}`,
    google_place_id: `google-${i}`,
    status: 'pending',
    created_at: '2026-11-07T00:00:00Z',
    updated_at: '2026-11-07T00:00:00Z',
  }));
  const get = vi.fn().mockResolvedValue({ providerStatus: 'unavailable' });
  const service = new MyPlaceSubmissionsService(
    { execute: vi.fn().mockResolvedValue({ rows }) } as unknown as Db,
    { MEDIA_PUBLIC_BASE_URL: '' },
    { get } as unknown as SubmissionDisplayService,
  );
  expect((await service.list(actor, { limit: 25 })).items).toHaveLength(25);
  expect((await service.list(actor, { limit: 25 })).items).toHaveLength(25);
  expect(get).not.toHaveBeenCalled();
});

it('F-02: paid facts survive optional photo timeout at the remaining deadline', async () => {
  vi.useFakeTimers();
  const provider = new FakePlaceProvider();
  provider.seed({ providerPlaceId: 'paid', name: 'Paid café' });
  const candidateReference = vi.fn(() => new Promise<undefined>(() => {}));
  const service = new SubmissionDisplayService(
    { execute: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Db,
    provider,
    { candidateReference } as unknown as ProviderPhotosService,
    {},
    undefined,
    { reserve: vi.fn().mockResolvedValue({ ok: true }) } as unknown as ProviderBudgetService,
  );
  const result = service.get('paid');
  await vi.advanceTimersByTimeAsync(6001);
  const answer = await result;
  expect(answer.providerStatus).toBe('ok');
  expect(answer.providerDisplay).toMatchObject({
    name: 'Paid café',
    googleRating: 4.4,
    googleRatingCount: 250,
  });
  expect(answer.providerDisplay).not.toHaveProperty('photo');
});

it('ADR-0052 photos:false refreshes facts without any candidateReference/photo call', async () => {
  const provider = new FakePlaceProvider();
  provider.seed({ providerPlaceId: 'facts-only', name: 'Facts' });
  const candidateReference = vi.fn();
  const service = new SubmissionDisplayService(
    { execute: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Db,
    provider,
    { candidateReference } as unknown as ProviderPhotosService,
    {},
    undefined,
    { reserve: vi.fn().mockResolvedValue({ ok: true }) } as unknown as ProviderBudgetService,
  );
  const result = await service.get('facts-only', { photos: false });
  expect(result.providerStatus).toBe('ok');
  expect(result.providerDisplay).not.toHaveProperty('photo');
  expect(candidateReference).not.toHaveBeenCalled();
});
