import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { MediaCleanupService } from './media-cleanup.service';

describe('media cleanup live provider image guard (#786)', () => {
  it('skips deleting an object referenced by place_media even without a live avatar', async () => {
    const row = { id: 'cleanup', bucket: 'public', objectKey: 'places/provider/photo.jpg' };
    const results = [[row], [], [{ id: 'photo' }]];
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => results.shift() }) }) }),
      delete: vi.fn(() => ({ where: async () => undefined })),
    };
    const storage = { deleteObject: vi.fn() };
    const cleanup = new MediaCleanupService(
      db as never,
      { private: storage, public: storage } as never,
      {} as never,
      'https://assets.test',
    );
    await cleanup.attemptNow(['cleanup']);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

it('retirement replaces an existing maintenance intent using the open-key upsert', async () => {
  const conflict = vi.fn(() => ({ returning: async () => [{ id: 'existing' }] }));
  const values = vi.fn(() => ({ onConflictDoUpdate: conflict }));
  const db = { insert: vi.fn(() => ({ values })) };
  const cleanup = new MediaCleanupService(db as never, {} as never, {} as never, '');
  const at = new Date('2026-11-16T00:00:00Z');
  expect(
    await cleanup.scheduleRetirement(
      db as never,
      {
        bucket: 'public',
        objectKey: 'places/provider/a.jpg',
        reason: 'submission_provider_photo_rejected',
      },
      at,
    ),
  ).toEqual(['existing']);
  expect(conflict).toHaveBeenCalledWith(
    expect.objectContaining({
      set: { reason: 'submission_provider_photo_rejected', nextAttemptAt: at, attempts: 0 },
    }),
  );
});

it.each([true, false])(
  'worker reschedules a future retirement marker instead of dropping it; live without marker=%s',
  async (unretired) => {
    const row = { id: 'job', bucket: 'public', objectKey: 'places/provider/a.jpg' };
    const until = new Date(Date.now() + 7 * 86400_000).toISOString();
    let selects = 0;
    const deleted = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: async () => undefined }));
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => (++selects === 1 ? [row] : []) }) }),
      }),
      execute: vi.fn(async () => ({ rows: [{ until: unretired ? null : until }] })),
      delete: () => ({ where: deleted }),
      update: () => ({ set }),
    };
    const storage = { deleteObject: vi.fn() };
    const metrics = { increment: vi.fn() };
    const cleanup = new MediaCleanupService(
      db as never,
      { private: storage, public: storage } as never,
      {} as never,
      '',
      metrics as never,
    );
    await cleanup.attemptNow(['job']);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(deleted).toHaveBeenCalledTimes(unretired ? 1 : 0);
    if (!unretired) expect(set).toHaveBeenCalledWith({ nextAttemptAt: new Date(until) });
    expect(metrics.increment).toHaveBeenCalledWith('media_cleanup_attempt_total', {
      bucket: 'public',
      outcome: unretired ? 'referenced' : 'deferred',
    });
  },
);

it('reconciler recreates a missing schedule from a past-due obligation', async () => {
  const execute = vi.fn(async (_query: SQL) => ({
    rows: [{ id: 'submission', key: 'places/provider/a.jpg' }],
  }));
  const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) };
  const cleanup = new MediaCleanupService(db as never, {} as never, {} as never, '');
  const schedule = vi.spyOn(cleanup, 'scheduleRetirement').mockResolvedValue(['job']);
  expect(await cleanup.reconcileRetirements()).toBe(1);
  expect(schedule).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ objectKey: 'places/provider/a.jpg', bucket: 'public' }),
    expect.any(Date),
  );
});

it('reconciler keeps dead-lettered obligations for explicit operator retry (#825 F-02)', async () => {
  // PostgreSQL excludes the obligation when any matching public queue row exists.
  // Check the SQL boundary too: an empty mocked result alone missed this regression.
  const execute = vi.fn(async (_query: SQL) => ({ rows: [] }));
  const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) };
  const metrics = { increment: vi.fn() };
  const cleanup = new MediaCleanupService(
    db as never,
    {} as never,
    {} as never,
    '',
    metrics as never,
  );
  const schedule = vi.spyOn(cleanup, 'scheduleRetirement').mockResolvedValue(['job']);
  expect(await cleanup.reconcileRetirements()).toBe(0);
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]).sql;
  const queueCheck = query.match(/not exists \(select 1 from media_cleanup_queue q[^)]+\)/)?.[0];
  expect(queueCheck).toContain("q.bucket = 'public'");
  expect(queueCheck).toContain("q.object_key = s.provider_photo->>'storageKey'");
  expect(queueCheck).not.toContain('failed_at');
  expect(schedule).not.toHaveBeenCalled();
  expect(metrics.increment).toHaveBeenCalledWith('provider_photo_reconciled_total', undefined, 0);
});
