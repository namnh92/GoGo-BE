import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InboxCursorCodec,
  INBOX_CURSOR_TTL_MS,
  legacyInboxTimestamp,
  fallbackInboxCursor,
  fallbackInboxPosition,
  type InboxCursor,
} from './inbox-cursor';

const secret = 'inbox-test-secret'.padEnd(48, 'x');
const codec = new InboxCursorCodec(secret);
const account = randomUUID();
const now = Date.parse('2026-11-08T10:00:00.000Z');
const through: InboxCursor = {
  v: 1,
  account,
  cutoff: '9007199254740993',
  asOf: new Date(now).toISOString(),
  expires: now + INBOX_CURSOR_TTL_MS,
  type: 'through',
  filter: 'all',
};

describe('inbox signed cursors', () => {
  it('round-trips full-precision fallback positions and rejects malformed boundaries', () => {
    const position = { createdAt: '2026-11-08T10:00:00.123456Z', id: randomUUID() };
    expect(fallbackInboxPosition(fallbackInboxCursor(position))).toEqual(position);
    for (const raw of [
      `before:2026-02-31T10:00:00.123456Z:${position.id}`,
      `before:2026-11-08T10:00:00.1234567Z:${position.id}`,
      `before:${position.createdAt}:invalid`,
      `${fallbackInboxCursor(position)}:extra`,
    ])
      expect(fallbackInboxPosition(raw)).toBeNull();
  });
  it('preserves bigint cutoff without JS precision loss and microsecond/id pagination position', () => {
    expect(codec.open(codec.seal(through), account, 'through', now)).toEqual(through);
    const page: InboxCursor = {
      ...through,
      type: 'page',
      before: { createdAt: '2026-11-08T10:00:00.123456Z', id: randomUUID() },
    };
    expect(codec.open(codec.seal(page), account, 'page', now)).toEqual(page);
  });
  it('refuses foreign accounts, other purposes, tampering and malformed tokens with the same code', () => {
    const token = codec.seal(through);
    for (const run of [
      () => codec.open(token, randomUUID(), 'through', now),
      () => codec.open(token, account, 'page', now),
      () => codec.open(`${token.slice(0, 10)}X${token.slice(11)}`, account, 'through', now),
      () => codec.open('garbage', account, 'through', now),
      () => codec.open('a'.repeat(2049), account, 'through', now),
    ])
      expect(run).toThrow(
        expect.objectContaining({ code: 'INVALID_NOTIFICATION_CURSOR', httpStatus: 400 }),
      );
  });
  it('rejects signed unknown schema/filter/cutoff values', () => {
    const key = createHmac('sha256', secret).update('gogo.notification-inbox.v1').digest();
    for (const patch of [{ v: 2 }, { filter: 'invite' }, { cutoff: '-1' }, { cutoff: '1e5' }]) {
      const body = Buffer.from(JSON.stringify({ ...through, ...patch })).toString('base64url');
      const token = `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
      expect(() => codec.open(token, account, 'through', now)).toThrow(
        expect.objectContaining({ code: 'INVALID_NOTIFICATION_CURSOR' }),
      );
    }
  });
  it('expires at exactly 24h and fails closed without configured signing material', () => {
    expect(() => codec.open(codec.seal(through), account, 'through', through.expires)).toThrow(
      expect.objectContaining({ code: 'NOTIFICATION_CURSOR_EXPIRED', httpStatus: 410 }),
    );
    expect(() => new InboxCursorCodec('').seal(through)).toThrow(
      expect.objectContaining({ httpStatus: 503 }),
    );
  });
  it('accepts previously issued timestamp cursors, rejects arbitrary date coercions', () => {
    expect(legacyInboxTimestamp(through.asOf)).toBe(through.asOf);
    for (const value of [
      '0',
      'yesterday',
      '2026-11-08',
      'invalid',
      '2026-99-08T10:00:00.000Z',
      '2026-02-31T10:00:00.000Z',
    ])
      expect(legacyInboxTimestamp(value)).toBeNull();
  });
});
