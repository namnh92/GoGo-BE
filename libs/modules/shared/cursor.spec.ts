import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from './cursor';

describe('keyset cursor (BE-CMS-G1 #219)', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  it('round-trips a Date and a string timestamp identically', () => {
    const date = new Date('2026-01-10T12:00:00.000Z');
    expect(decodeKeysetCursor(encodeKeysetCursor(date, id))).toEqual({
      at: date.toISOString(),
      id,
    });
    expect(decodeKeysetCursor(encodeKeysetCursor(date.toISOString(), id)).at).toBe(
      date.toISOString(),
    );
  });

  it('is opaque: no sort value leaks into the URL as plain text', () => {
    const cursor = encodeKeysetCursor(new Date('2026-01-10T12:00:00.000Z'), id);
    expect(cursor).not.toContain('2026');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects rather than coerces anything it did not produce', () => {
    for (const bad of [
      'not-a-cursor',
      '',
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify(['2026-01-10T12:00:00.000Z', 'not-a-uuid'])).toString('base64url'),
      Buffer.from(JSON.stringify(['whenever', id])).toString('base64url'),
      Buffer.from(JSON.stringify([id])).toString('base64url'),
    ]) {
      expect(() => decodeKeysetCursor(bad)).toThrowError(/Cursor is not valid/);
    }
  });

  it('normalizes whichever shape the driver hands back', () => {
    expect(toIso(new Date('2026-01-10T12:00:00.000Z'))).toBe('2026-01-10T12:00:00.000Z');
    expect(toIso('2026-01-10 12:00:00+00')).toBe('2026-01-10 12:00:00+00');
  });
});
