import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { NoopMetrics } from '@gogo/observability';
import { SUBMISSION_REJECTION_REASONS } from '../domain/submission-rejection';
import { MyPlaceSubmissionsService } from './my-place-submissions.service';

const actor: Actor = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session',
};
const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fixture = () => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return {
    execute,
    service: new MyPlaceSubmissionsService({ execute } as unknown as Db, {
      MEDIA_PUBLIC_BASE_URL: 'https://assets.example.test',
    }),
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
      metrics,
    );
    await expect(service.list(actor, { limit: 25 })).rejects.toThrow('database unavailable');
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      'my_place_submissions_query_duration_ms',
      expect.any(Number),
    );
  });
});
