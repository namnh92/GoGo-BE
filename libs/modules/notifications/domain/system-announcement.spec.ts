import { describe, expect, it } from 'vitest';
import {
  matchesSystemNotificationEtag,
  parseSystemNotificationCursor,
  systemAnnouncementInput,
  systemAnnouncementPatch,
  systemNotificationCursor,
  systemNotificationQuery,
} from './system-announcement';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { kind: 'general', title: 'Thông báo', body: 'Nội dung do CMS soạn.' };

describe('system announcement input and canonical routing', () => {
  it.each([
    `gogo://place/${id}`,
    `gogo://room/${id}`,
    `gogo://plan/${id}`,
    'gogo://invite/Abc_123456',
    'gogo://l/Abc123',
    'gogo://saved',
    'gogo://notifications',
    'gogo://profile',
    null,
  ])('accepts canonical destination %s', (deepLink) => {
    expect(systemAnnouncementInput.parse({ ...input, deepLink }).deepLink).toBe(deepLink);
  });
  it.each([
    'https://gogo.id.vn',
    'javascript:alert(1)',
    'gogo://unknown',
    'gogo://notifications?token=secret',
    'gogo://saved#fragment',
    'gogo://saved/',
    'gogo://user@profile',
    'gogo://profile:80',
    `gogo://places/${id}`,
    `gogo://place/${id}/extra`,
    'gogo://place/not-a-uuid',
    'gogo://%70rofile',
    ' gogo://profile',
    'gogo://profile\n',
    'GOGO://profile',
    'gogo://invite/abc',
  ])('refuses unsafe or noncanonical destination %s', (deepLink) => {
    expect(systemAnnouncementInput.safeParse({ ...input, deepLink }).success).toBe(false);
  });
  it('bounds editorial copy and accepts only supported authoring kinds/locale', () => {
    expect(systemAnnouncementInput.parse(input).body).toBe(input.body);
    for (const patch of [
      { title: ' ' },
      { title: 't'.repeat(201) },
      { body: 'b'.repeat(10001) },
      { kind: 'unknown' },
      { locale: 'en' },
      { status: 'published' },
      { expiresAt: 'tomorrow' },
      { publishedAt: new Date().toISOString() },
    ])
      expect(systemAnnouncementInput.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(systemAnnouncementPatch.safeParse({}).success).toBe(false);
    expect(systemAnnouncementPatch.parse({ deepLink: null, expiresAt: null })).toEqual({
      deepLink: null,
      expiresAt: null,
    });
  });
  it('bounds page work', () => {
    expect(systemNotificationQuery.parse({}).limit).toBe(20);
    for (const limit of ['0', '101', '1.5', 'NaN'])
      expect(systemNotificationQuery.safeParse({ limit }).success).toBe(false);
  });
});

describe('system notification tuple cursor', () => {
  it.each(['public', 'cms'] as const)('accepts PostgreSQL year boundaries for %s', (purpose) => {
    for (const at of ['0001-01-01T00:00:00.000001Z', '9999-12-31T23:59:59.999999Z']) {
      const cursor = systemNotificationCursor(at, id, purpose);
      expect(parseSystemNotificationCursor(cursor, purpose)).toEqual({ at, id });
    }
  });
  it.each(['public', 'cms'] as const)('rejects year zero for %s', (purpose) => {
    const cursor = systemNotificationCursor('0000-01-01T00:00:00.123456Z', id, purpose);
    expect(() => parseSystemNotificationCursor(cursor, purpose)).toThrow('Cursor is not valid');
  });
  it('retains microseconds and binds the list purpose', () => {
    const at = '2026-11-09T10:00:00.123456Z';
    const cursor = systemNotificationCursor(at, id, 'public');
    expect(parseSystemNotificationCursor(cursor, 'public')).toEqual({ at, id });
    expect(() => parseSystemNotificationCursor(cursor, 'cms')).toThrow('Cursor is not valid');
  });
  it.each([
    '!',
    'e30',
    'null',
    Buffer.from(JSON.stringify(['public', '2026-02-30T10:00:00Z', id])).toString('base64url'),
    Buffer.from(JSON.stringify(['public', '2026-11-09T10:00:00Z', 'x'.repeat(36)])).toString(
      'base64url',
    ),
    Buffer.from(JSON.stringify(['public', '2026-11-09T10:00:00Z', id, 'extra'])).toString(
      'base64url',
    ),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(() => parseSystemNotificationCursor(cursor, 'public')).toThrow('Cursor is not valid');
  });
});

describe('conditional GET matching', () => {
  it.each(['"abc"', 'W/"abc"', '"other", W/"abc"', '*'])('accepts %s', (header) => {
    expect(matchesSystemNotificationEtag(header, '"abc"')).toBe(true);
  });
  it.each([undefined, 'abc', '"other"', 'W/"abcd"'])('refuses %s', (header) => {
    expect(matchesSystemNotificationEtag(header, '"abc"')).toBe(false);
  });
});
