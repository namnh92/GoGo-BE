import type { Db } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { fallbackInboxPosition, InboxCursorCodec } from '../domain/inbox-cursor';
import { NotificationInboxService } from './notification-inbox.service';

describe('NotificationInboxService raw timestamp mapping', () => {
  it('rejects erased accounts before creating an idempotency claim or read operation', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      fn({ execute }),
    );
    const inbox = new NotificationInboxService({ transaction } as unknown as Db, {
      AUTH_JWT_SECRET: '',
    });
    const userId = '00000000-0000-4000-8000-000000000001';
    await expect(
      inbox.readAll(userId, 'unused', {
        storedKey: 'key',
        requestHash: 'hash',
        actorScope: 'test',
        endpoint: 'POST /v1/me/notifications/read-all',
      }),
    ).rejects.toMatchObject({ httpStatus: 401 });
    expect(execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain("status <> 'deleted' for share");
    expect(query.params).toEqual([userId]);
  });
  it('retains legacy timestamp acceptance and its exclusive boundary without signing before cutover', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const cursor = '2026-11-08T10:00:00.123Z';
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ ready: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const inbox = new NotificationInboxService({ execute } as unknown as Db, {
      AUTH_JWT_SECRET: '',
    });
    expect(await inbox.list(userId, cursor)).toEqual({ notifications: [], nextCursor: null });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[1]![0]);
    expect(query.sql).toContain('created_at <');
    expect(query.sql).not.toContain('inbox_sequence');
    expect(query.params).toEqual([userId, cursor]);
  });
  it('keeps tuple fallback pages available across cutover without signing or excluding NULL sequences', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(21 - i).padStart(12, '0')}`,
      kind: 'invite',
      payload: {},
      created_at: '2026-11-08T10:00:00.123456Z',
      cursor_at: '2026-11-08T10:00:00.123456Z',
      read_at: null,
    }));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ ready: false }] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: rows.slice(20) })
      .mockResolvedValueOnce({ rows: [{ ready: false }] });
    // Fallback remains callable without a signing key, including after cutover.
    const inbox = new NotificationInboxService({ execute } as unknown as Db, {
      AUTH_JWT_SECRET: '',
    });
    const first = await inbox.list(userId);
    expect(first.notifications).toHaveLength(20);
    expect(fallbackInboxPosition(first.nextCursor!)).toEqual({
      createdAt: rows[19]!.cursor_at,
      id: rows[19]!.id,
    });
    const second = await inbox.list(userId, first.nextCursor!);
    expect(second.notifications.map((n) => n.id)).toEqual([rows[20]!.id]);
    expect(second.nextCursor).toBeNull();
    const dialect = new PgDialect();
    const firstQuery = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    const secondQuery = dialect.sqlToQuery(execute.mock.calls[2]![0]);
    expect(firstQuery.sql).not.toContain('inbox_sequence');
    expect(firstQuery.params).toEqual([userId]);
    expect(secondQuery.sql).toContain('(created_at, id) <');
    expect(secondQuery.sql).not.toContain('inbox_sequence');
    expect(secondQuery.params).toEqual([userId, rows[19]!.cursor_at, rows[19]!.id]);
    await expect(inbox.summary(userId)).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('serializes read/unread rows while retaining microseconds in the next-page boundary', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const secret = 'inbox-unit-secret'.padEnd(48, 'x');
    const asOf = new Date().toISOString();
    const cursorAt = '2026-11-08T10:00:00.123456Z';
    // Drizzle db.execute leaves timestamptz values as strings, unlike db.select.
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(21 - i).padStart(12, '0')}`,
      kind: 'plan_ready',
      payload: { roomId: userId },
      created_at: '2026-11-08 17:00:00.123456+07',
      read_at: i === 0 ? '2026-11-08 17:01:00.654321+07' : null,
      cursor_at: cursorAt,
    }));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ ready: true, cutoff: '21', unread: 20, as_of: asOf }] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: rows.slice(20) });
    const inbox = new NotificationInboxService({ execute } as unknown as Db, {
      AUTH_JWT_SECRET: secret,
    });

    const first = await inbox.list(userId);
    expect(first.notifications).toHaveLength(20);
    expect(first.notifications[0]).toEqual({
      id: rows[0]!.id,
      kind: 'plan_ready',
      payload: { roomId: userId },
      createdAt: '2026-11-08T10:00:00.123Z',
      readAt: '2026-11-08T10:01:00.654Z',
    });
    expect(first.notifications[1]!.readAt).toBeUndefined();
    const token = new InboxCursorCodec(secret).open(first.nextCursor!, userId, 'page');
    expect(token).toMatchObject({
      cutoff: '21',
      before: { createdAt: cursorAt, id: rows[19]!.id },
    });

    const last = await inbox.list(userId, first.nextCursor!);
    expect(last.notifications.map((n) => n.id)).toEqual([rows[20]!.id]);
    expect(last.nextCursor).toBeNull();
    // The SQL tuple comparison must use the original microseconds, not the DTO Date.
    const query = new PgDialect().sqlToQuery(execute.mock.calls[2]![0]);
    expect(query.params).toEqual([userId, '21', cursorAt, rows[19]!.id]);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
