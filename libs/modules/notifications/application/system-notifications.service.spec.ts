import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { SystemNotificationsService } from './system-notifications.service';
import { parseSystemNotificationCursor } from '../domain/system-announcement';

const row = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  kind: 'future_kind',
  title: 'T',
  body: 'B',
  deep_link: null,
  published_at: '2026-11-09T10:00:00.123456Z',
  expires_at: null,
  status: 'published',
  locale: 'vi',
  created_by: 'private-admin',
  updated_by: 'private-admin',
  created_at: '2026-11-09T09:00:00.123456Z',
  updated_at: '2026-11-09T09:00:00.123456Z',
};

describe('system notification public representation', () => {
  it('returns only the seven public fields, including unknown extensible kinds', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ rows: [row, { ...row, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] });
    const service = new SystemNotificationsService({ execute } as unknown as Db);
    const page = await service.listPublic({ limit: 1 });
    expect(page.body.items).toEqual([
      {
        id: row.id,
        kind: 'future_kind',
        title: 'T',
        body: 'B',
        deepLink: null,
        publishedAt: row.published_at,
        expiresAt: null,
      },
    ]);
    expect(parseSystemNotificationCursor(page.body.nextCursor!, 'public')).toEqual({
      at: row.published_at,
      id: row.id,
    });
    const unchanged = await service.listPublic({ limit: 1 }, `W/${page.etag}`);
    expect(unchanged.notModified).toBe(true);
    execute.mockResolvedValue({ rows: [{ ...row, body: 'Edited copy' }] });
    const edited = await service.listPublic({ limit: 1 }, page.etag);
    expect(edited.etag).not.toBe(page.etag);
    expect(edited.notModified).toBe(false);
  });
  it('revalidates an empty page when content disappears', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [row] });
    const service = new SystemNotificationsService({ execute } as unknown as Db);
    const before = await service.listPublic({ limit: 20 });
    execute.mockResolvedValue({ rows: [] });
    const after = await service.listPublic({ limit: 20 }, before.etag);
    expect(after.notModified).toBe(false);
    expect(after.body).toEqual({ items: [], nextCursor: null });
  });
});
