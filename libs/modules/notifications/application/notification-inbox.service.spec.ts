import type { Db } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { InboxCursorCodec } from '../domain/inbox-cursor';
import { NotificationInboxService } from './notification-inbox.service';

describe('NotificationInboxService raw timestamp mapping', () => {
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
