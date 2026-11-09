import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { NoopMetrics } from '@gogo/observability';
import { SUBMISSION_REJECTION_REASONS } from '../domain/submission-rejection';
import type { SubmissionDisplayService } from './submission-display.service';
import { MyPlaceSubmissionsService } from './my-place-submissions.service';

const actor: Actor = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session',
};
const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const noDisplay = {
  get: vi.fn().mockResolvedValue({ providerStatus: 'unavailable', providerDisplay: undefined }),
} as unknown as SubmissionDisplayService;
const fixture = () => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return {
    execute,
    service: new MyPlaceSubmissionsService(
      { execute } as unknown as Db,
      {
        MEDIA_PUBLIC_BASE_URL: 'https://assets.example.test',
      },
      noDisplay,
    ),
  };
};

describe('MyPlaceSubmissionsService', () => {
  it.each(['guest', 'admin'] as const)('rejects %s before querying', async (type) => {
    const { execute, service } = fixture();
    await expect(service.list({ ...actor, type }, { limit: 25 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'not-json',
    cursor(null),
    cursor({}),
    cursor(['2026-11-07T00:00:00Z']),
    cursor(['not-a-date', actor.id]),
    cursor(['2026-02-30T00:00:00Z', actor.id]),
    cursor(['2026-11-07T00:00:00Z', '-'.repeat(36)]),
    cursor(['2026-11-07T00:00:00Z', actor.id, 'extra']),
  ])('rejects malformed cursor before querying: %s', async (value) => {
    const { execute, service } = fixture();
    await expect(service.list(actor, { limit: 25, cursor: value })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
      httpStatus: 400,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(SUBMISSION_REJECTION_REASONS)(
    'projects stored key %s and a microsecond-precise cursor',
    async (key) => {
      const { execute, service } = fixture();
      const row = {
        id: actor.id,
        status: 'rejected',
        rejection_reason: key,
        name: null,
        photo_key: null,
        result_place_id: null,
        created_at: '2026-11-07T00:00:00.123456Z',
        updated_at: new Date('2026-11-07T01:00:00Z'),
        decided_at: '2026-11-07 01:00:00+00',
        decision_reason: 'PII@example.test',
        note: 'private note',
        submitted_by_user_id: actor.id,
      };
      execute.mockResolvedValue({ rows: [row, { ...row, id: 'another-row' }] });
      const result = await service.list(actor, { limit: 1 });
      expect(result).toEqual({
        items: [
          {
            id: actor.id,
            status: 'rejected',
            providerStatus: 'deferred',
            rejectionReason: key,
            createdAt: row.created_at,
            updatedAt: '2026-11-07T01:00:00.000Z',
            decidedAt: '2026-11-07T01:00:00.000Z',
            updateDeadline: '2026-11-14T01:00:00.000Z',
          },
        ],
        nextCursor: cursor([row.created_at, actor.id]),
      });
    },
  );

  it('omits deleted place links and unavailable media, with null at the end', async () => {
    const { execute, service } = fixture();
    execute.mockResolvedValue({
      rows: [
        {
          id: actor.id,
          status: 'merged',
          name: null,
          photo_key: 'u/private.jpg',
          result_place_id: null,
          created_at: '2026-11-07T00:00:00.000001Z',
          updated_at: '2026-11-07 01:00:00+00',
          decided_at: null,
        },
      ],
    });
    const result = await service.list(actor, { limit: 25 });
    expect(result.nextCursor).toBeNull();
    expect(result.items[0]).not.toHaveProperty('placeId');
    expect(result.items[0]).not.toHaveProperty('photoUrl');
    expect(result.items[0]).not.toHaveProperty('rejectionReason');
    expect(result.items[0]).not.toHaveProperty('name');
  });

  it.each([
    ['rejected', null],
    ['pending', 'other'],
    ['approved', 'other'],
    ['merged', 'other'],
  ])('omits a public reason for status %s and stored key %s', async (status, key) => {
    const { execute, service } = fixture();
    execute.mockResolvedValue({
      rows: [
        {
          id: actor.id,
          status,
          rejection_reason: key,
          created_at: '2026-11-07T00:00:00Z',
          updated_at: '2026-11-07T00:00:00Z',
          decision_reason: 'PRIVATE',
        },
      ],
    });
    const result = await service.list(actor, { limit: 25 });
    expect(result.items[0]).not.toHaveProperty('rejectionReason');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('records query duration on a database failure without swallowing the error', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const metrics = new NoopMetrics();
    const observe = vi.spyOn(metrics, 'observe');
    const service = new MyPlaceSubmissionsService(
      { execute } as unknown as Db,
      {
        MEDIA_PUBLIC_BASE_URL: '',
      },
      noDisplay,
      metrics,
    );
    await expect(service.list(actor, { limit: 25 })).rejects.toThrow('database unavailable');
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      'my_place_submissions_query_duration_ms',
      expect.any(Number),
    );
  });
});

describe('#801 account submission detail', () => {
  it.each(['guest', 'admin'] as const)('rejects %s detail before DB', async (type) => {
    const { execute, service } = fixture();
    await expect(service.detail({ ...actor, type }, actor.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns the same missing result for inaccessible/unknown detail before any display call', async () => {
    const { service } = fixture();
    await expect(service.detail(actor, actor.id)).rejects.toMatchObject({
      code: 'SUBMISSION_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('strips unexpected enrichment keys, keeps own input unverified and never returns moderation fields', async () => {
    const { execute, service } = fixture();
    execute.mockResolvedValue({
      rows: [
        {
          id: actor.id,
          status: 'pending',
          created_at: '2026-11-07T00:00:00Z',
          updated_at: '2026-11-07T00:00:00Z',
          own_input: {
            note: 'My tip',
            vibeKeys: ['quiet'],
            priceMin: 10000,
            priceMax: 20000,
            priceUnit: 'per_item',
          },
          own_enrichment: {
            visitTips: 'My advice',
            service: { rating: 4, chipKeys: ['friendly'], private: 'hidden' },
            private: 'hidden',
          },
          decision_reason: 'moderator@example.test',
          review_draft: { description: 'private moderation text' },
        },
      ],
    });
    const detail = await service.detail(actor, actor.id);
    expect(detail.contribution).toEqual({
      verificationStatus: 'unverified',
      note: 'My tip',
      vibeKeys: ['quiet'],
      estimatedPrice: { min: 10000, max: 20000, unit: 'per_item', currency: 'VND' },
      enrichment: { visitTips: 'My advice', service: { rating: 4, chipKeys: ['friendly'] } },
    });
    expect(JSON.stringify(detail)).not.toMatch(/private|hidden|moderator/);
    const list = await service.list(actor, { limit: 25 });
    expect(list.items[0]).not.toHaveProperty('contribution');
  });

  it('omits enrichment when absent or malformed instead of returning an unchecked JSON blob', async () => {
    const { execute, service } = fixture();
    execute.mockResolvedValue({
      rows: [
        {
          id: actor.id,
          status: 'pending',
          created_at: '2026-11-07T00:00:00Z',
          updated_at: '2026-11-07T00:00:00Z',
          own_input: null,
          own_enrichment: { service: { rating: 9 } },
        },
      ],
    });
    expect(await service.detail(actor, actor.id)).not.toHaveProperty('contribution');
  });
});

const snapshot = {
  source: 'google_places' as const,
  fetchedAt: new Date().toISOString(),
  attributions: ['Google Maps'],
  googleMapsUri: null,
  name: 'Tên thật',
  addressShort: 'Bến Thành, TP.HCM',
  categoryKey: 'cafe',
  googleRating: 4.6,
  googleRatingCount: 980,
  openingHours: [],
};
const pending = {
  id: actor.id,
  status: 'pending',
  google_place_id: 'provider',
  display_snapshot: snapshot,
  created_at: '2026-11-07T00:00:00Z',
  updated_at: '2026-11-07T00:00:00Z',
};
function snapshotFixture(row = pending) {
  const execute = vi.fn().mockResolvedValue({ rows: [row] });
  const get = vi.fn().mockResolvedValue({ providerStatus: 'ok', providerDisplay: snapshot });
  const service = new MyPlaceSubmissionsService(
    { execute } as unknown as Db,
    { MEDIA_PUBLIC_BASE_URL: '' },
    { get } as unknown as SubmissionDisplayService,
  );
  return { service, execute, get };
}

it('#801 supplies pending facts without a lazy photo reference from the stored snapshot', async () => {
  const { service, get } = snapshotFixture();
  const { items } = await service.list(actor, { limit: 25 });
  expect(items[0]).toMatchObject({
    name: snapshot.name,
    addressShort: snapshot.addressShort,
    categoryKey: 'cafe',
    providerStatus: 'ok',
    providerDisplay: snapshot,
  });
  expect(get).not.toHaveBeenCalled();
});

it('#801 shares a fresh snapshot between list/detail without provider calls or changing fetchedAt', async () => {
  const { service, get, execute } = snapshotFixture();
  await service.list(actor, { limit: 25 });
  expect((await service.detail(actor, actor.id)).providerDisplay?.fetchedAt).toBe(
    snapshot.fetchedAt,
  );
  expect(get).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(2); // reads only
});

it('#801 omits expired facts from LIST, then DETAIL refreshes and persists only allowlisted facts', async () => {
  const expired = {
    ...snapshot,
    fetchedAt: new Date(Date.now() - 30 * 86400000 - 1000).toISOString(),
  };
  const { service, get, execute } = snapshotFixture({ ...pending, display_snapshot: expired });
  expect((await service.list(actor, { limit: 25 })).items[0]?.providerStatus).toBe('deferred');
  expect(get).not.toHaveBeenCalled();
  expect((await service.detail(actor, actor.id)).providerDisplay).toEqual(snapshot);
  expect(get).toHaveBeenCalledExactlyOnceWith('provider', { photos: false });
  expect(execute).toHaveBeenCalledTimes(4); // list, detail, lease, snapshot write
});

it.each(['approved', 'merged'])(
  '#801 reuses canonical facts for %s with no provider call',
  async (status) => {
    const { service, get } = snapshotFixture({ ...pending, status });
    await service.list(actor, { limit: 25 });
    expect((await service.detail(actor, actor.id)).providerDisplay).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  },
);

it('#801 a held refresh lease starts no second paid call', async () => {
  const { service, get, execute } = snapshotFixture({
    ...pending,
    display_snapshot: { ...snapshot, fetchedAt: '2020-01-01T00:00:00.000Z' },
  });
  execute
    .mockResolvedValueOnce({ rows: [{ ...pending, display_snapshot: null }] })
    .mockResolvedValueOnce({ rows: [] });
  expect((await service.detail(actor, actor.id)).providerStatus).toBe('deferred');
  expect(get).not.toHaveBeenCalled();
});
