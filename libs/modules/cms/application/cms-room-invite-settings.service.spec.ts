import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import { CmsRoomInviteSettingsService } from './cms-room-invite-settings.service';
import {
  beginIdempotent,
  completeIdempotentWithin,
  releaseIdempotent,
} from '../../shared/idempotency.interceptor';

vi.mock('../../shared/idempotency.interceptor', () => ({
  beginIdempotent: vi.fn(),
  completeIdempotentWithin: vi.fn(),
  releaseIdempotent: vi.fn(),
}));
const claim = { storedKey: 'key', claimedAt: new Date() };
const scope = {
  storedKey: 'key',
  actorScope: 'admin:a',
  endpoint: 'PUT settings',
  requestHash: 'hash',
};
const row = {
  ttl_seconds: 86400,
  version: '9007199254740993',
  updated_at: '2026-11-13T00:00:00Z',
  updated_by_admin_id: null,
};
const tag = '"room-invite-ttl-v1-r9007199254740993"';
const now = new Date('2026-11-13T01:00:00Z');
function harness() {
  const execute = vi.fn().mockResolvedValue({ rows: [row] });
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = { execute, insert: vi.fn().mockReturnValue({ values }) };
  const events: string[] = [];
  const transaction = vi.fn(async (fn: (arg: unknown) => Promise<unknown>) => {
    events.push('begin');
    const result = await fn(tx);
    events.push('commit');
    return result;
  });
  const db = { execute, transaction };
  const increment = vi.fn(() => {
    events.push('metric');
  });
  const service = new CmsRoomInviteSettingsService(
    db as unknown as Db,
    { increment } as unknown as MetricsPort,
  );
  return { service, db, tx, execute, values, transaction, increment, events };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(beginIdempotent).mockResolvedValue({ kind: 'owned', claim });
  vi.mocked(completeIdempotentWithin).mockResolvedValue(true);
  vi.mocked(releaseIdempotent).mockResolvedValue(undefined);
});
describe('#906 CMS invite TTL service', () => {
  it('reads DB every time and preserves bigint as a decimal string', async () => {
    const h = harness();
    expect(await h.service.read()).toMatchObject({
      ttlSeconds: 86400,
      version: row.version,
      etag: tag,
      updatedByAdminId: null,
      minTtlSeconds: 1,
      maxTtlSeconds: 2147483647,
      codeMaxTtlSeconds: 172800,
    });
    await h.service.read();
    expect(h.execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['missing', undefined],
    ['invalid', { ...row, ttl_seconds: 0 }],
    ['invalid', { ...row, version: '0' }],
  ] as const)('fails closed on %s singleton', async (reason, value) => {
    const h = harness();
    h.execute.mockResolvedValue({ rows: value ? [value] : [] });
    await expect(h.service.read()).rejects.toMatchObject({
      code: 'INVITE_TTL_SETTING_UNAVAILABLE',
      reason,
      options: { retryable: false },
    });
  });
  it('sanitizes DB read failures', async () => {
    const h = harness();
    h.execute.mockRejectedValue(new Error('private SQL parameter'));
    await expect(h.service.read()).rejects.toMatchObject({
      reason: 'db_error',
      options: { retryable: true },
    });
  });
  it('replays the original response before reading or locking current state', async () => {
    const h = harness();
    const receipt = { ttlSeconds: 300, etag: '"old"' };
    vi.mocked(beginIdempotent).mockResolvedValue({ kind: 'replay', status: 200, body: receipt });
    expect(await h.service.update('admin', 300, '"stale"', scope)).toEqual({
      body: receipt,
      replayed: true,
    });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.increment).toHaveBeenCalledExactlyOnceWith('cms_room_invite_ttl_update_total', {
      result: 'replayed',
    });
  });
  it('completes no-op replay inside transaction, preserving actor/time/revision and skipping audit', async () => {
    const h = harness();
    const result = await h.service.update('admin', 86400, tag, scope);
    expect(result.body.version).toBe(row.version);
    expect(h.tx.insert).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(completeIdempotentWithin).toHaveBeenCalledWith(h.tx, claim, 200, result.body);
    expect(h.events).toEqual(['begin', 'commit', 'metric']);
    expect(h.increment).toHaveBeenCalledWith('cms_room_invite_ttl_update_total', {
      result: 'noop',
    });
  });
  it('still checks ETag on no-op and releases own claim on conflict', async () => {
    const h = harness();
    await expect(h.service.update('admin', 86400, '"stale"', scope)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      httpStatus: 412,
    });
    expect(completeIdempotentWithin).not.toHaveBeenCalled();
    expect(releaseIdempotent).toHaveBeenCalledWith(h.db, claim);
    expect(h.events).toEqual(['begin', 'metric']);
  });
  function changed(h: ReturnType<typeof harness>) {
    h.execute
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ now }] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...row,
            ttl_seconds: 300,
            version: '9007199254740994',
            updated_at: now,
            updated_by_admin_id: 'admin',
          },
        ],
      });
  }
  it('shares one post-lock DB clock with audit and completes replay before changed outcome', async () => {
    const h = harness();
    changed(h);
    const result = await h.service.update('admin', 300, tag, scope);
    expect(h.tx.insert).toHaveBeenCalledWith(schema.auditLogs);
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin',
        action: 'room_invite_ttl.updated',
        resourceType: 'room_invite_ttl',
        resourceId: 'global',
        createdAt: now,
        diff: {
          before: { ttlSeconds: 86400, version: row.version },
          after: { ttlSeconds: 300, version: '9007199254740994' },
        },
      }),
    );
    expect(result.body.updatedAt).toBe(now.toISOString());
    expect(completeIdempotentWithin).toHaveBeenCalledWith(h.tx, claim, 200, result.body);
    expect(h.events).toEqual(['begin', 'commit', 'metric']);
    expect(h.increment).toHaveBeenCalledExactlyOnceWith('cms_room_invite_ttl_update_total', {
      result: 'changed',
    });
  });
  it.each(['audit', 'completion', 'lost_claim'])(
    'rolls back on %s failure without changed outcome',
    async (fault) => {
      const h = harness();
      changed(h);
      if (fault === 'audit') h.values.mockRejectedValue(new Error('audit failed'));
      else if (fault === 'completion')
        vi.mocked(completeIdempotentWithin).mockRejectedValue(new Error('completion failed'));
      else vi.mocked(completeIdempotentWithin).mockResolvedValue(false);
      await expect(h.service.update('admin', 300, tag, scope)).rejects.toBeDefined();
      expect(h.events).not.toContain('commit');
      expect(releaseIdempotent).toHaveBeenCalledWith(h.db, claim);
      expect(h.increment).not.toHaveBeenCalledWith('cms_room_invite_ttl_update_total', {
        result: 'changed',
      });
    },
  );
  it('turns lock timeout into typed retryable 503', async () => {
    const h = harness();
    h.execute.mockRejectedValue({ code: '55P03', message: 'private params' });
    await expect(h.service.update('admin', 300, tag, scope)).rejects.toMatchObject({
      code: 'INVITE_TTL_SETTING_UNAVAILABLE',
      reason: 'db_error',
      options: { retryable: true },
    });
  });
});
