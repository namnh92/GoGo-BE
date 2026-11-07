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
            providerStatus: 'unavailable',
            rejectionReason: key,
            createdAt: row.created_at,
            updatedAt: '2026-11-07T01:00:00.000Z',
            decidedAt: '2026-11-07T01:00:00.000Z',
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

it('#801 projects only the selected page and deduplicates provider lookups within a request', async () => {
  const row = {
    id: actor.id,
    status: 'pending',
    google_place_id: 'same',
    created_at: '2026-11-07T00:00:00Z',
    updated_at: '2026-11-07T00:00:00Z',
  };
  const execute = vi.fn().mockResolvedValue({
    rows: [row, { ...row, id: 'two' }, { ...row, id: 'extra', google_place_id: 'must-not-fetch' }],
  });
  const get = vi
    .fn()
    .mockResolvedValue({ providerStatus: 'unavailable', providerDisplay: undefined });
  const service = new MyPlaceSubmissionsService(
    { execute } as unknown as Db,
    { MEDIA_PUBLIC_BASE_URL: '' },
    { get } as unknown as SubmissionDisplayService,
  );
  const page = await service.list(actor, { limit: 2 });
  expect(page.items).toHaveLength(2);
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('same', expect.any(Number));
  await service.list(actor, { limit: 2 });
  expect(get).toHaveBeenCalledTimes(2); // No cache across requests.
});

it('#801 bounds concurrent display lookups and defers unstarted rows after the page deadline', async () => {
  vi.useFakeTimers();
  try {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}`,
      status: 'pending',
      google_place_id: `${i}`,
      created_at: '2026-11-07T00:00:00Z',
      updated_at: '2026-11-07T00:00:00Z',
    }));
    let active = 0;
    let maximum = 0;
    const get = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 6001));
      active--;
      return { providerStatus: 'unavailable', providerDisplay: undefined };
    });
    const service = new MyPlaceSubmissionsService(
      { execute: vi.fn().mockResolvedValue({ rows }) } as unknown as Db,
      { MEDIA_PUBLIC_BASE_URL: '' },
      { get } as unknown as SubmissionDisplayService,
    );
    const result = service.list(actor, { limit: 12 });
    await vi.advanceTimersByTimeAsync(6002);
    const page = await result;
    expect(maximum).toBe(4);
    expect(get).toHaveBeenCalledTimes(4);
    expect(page.items.map((item) => item.id)).toEqual(rows.map((row) => row.id));
    expect(page.items.slice(4).every((item) => item.providerStatus === 'deferred')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('#801 supplies a real pending name/address/category from live attributed facts', async () => {
  const execute = vi.fn().mockResolvedValue({
    rows: [
      {
        id: actor.id,
        google_place_id: 'provider',
        status: 'pending',
        created_at: '2026-11-07T00:00:00Z',
        updated_at: '2026-11-07T00:00:00Z',
      },
    ],
  });
  const providerDisplay = {
    source: 'google_places',
    fetchedAt: '2026-11-07T00:00:00Z',
    attributions: ['Google Maps'],
    googleMapsUri: null,
    name: 'Tên thật',
    addressShort: 'Bến Thành, TP.HCM',
    categoryKey: 'cafe',
    googleRating: 4.6,
    googleRatingCount: 980,
    openingHours: [],
  };
  const get = vi.fn().mockResolvedValue({ providerStatus: 'ok', providerDisplay });
  const service = new MyPlaceSubmissionsService(
    { execute } as unknown as Db,
    { MEDIA_PUBLIC_BASE_URL: '' },
    { get } as unknown as SubmissionDisplayService,
  );
  const { items } = await service.list(actor, { limit: 25 });
  expect(items[0]).toMatchObject({
    id: actor.id,
    status: 'pending',
    name: 'Tên thật',
    addressShort: 'Bến Thành, TP.HCM',
    categoryKey: 'cafe',
    providerStatus: 'ok',
    providerDisplay,
  });
});
