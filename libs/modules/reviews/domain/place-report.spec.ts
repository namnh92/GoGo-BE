import { describe, expect, it } from 'vitest';
import { PLACE_REPORT_NOTE_MAX, placeReportBodySchema } from './place-report';

describe('place report body (#218)', () => {
  it('accepts a stable reason key and trims the note', () => {
    expect(placeReportBodySchema.parse({ reasonCode: 'wrong_hours', note: '  21h  ' })).toEqual({
      reasonCode: 'wrong_hours',
      note: '21h',
    });
  });

  it('treats a blank note as absent', () => {
    expect(placeReportBodySchema.parse({ reasonCode: 'other', note: '   ' })).toEqual({
      reasonCode: 'other',
      note: undefined,
    });
  });

  it('refuses a sentence where a key belongs, and a missing reason', () => {
    expect(placeReportBodySchema.safeParse({ reasonCode: 'Sai giờ' }).success).toBe(false);
    expect(placeReportBodySchema.safeParse({ note: 'x' }).success).toBe(false);
  });

  it('caps the note length', () => {
    const at = 'a'.repeat(PLACE_REPORT_NOTE_MAX);
    expect(placeReportBodySchema.safeParse({ reasonCode: 'other', note: at }).success).toBe(true);
    expect(placeReportBodySchema.safeParse({ reasonCode: 'other', note: `${at}a` }).success).toBe(
      false,
    );
  });

  it('applies the cap after trimming (#662 F-03)', () => {
    const padded = `  ${'a'.repeat(PLACE_REPORT_NOTE_MAX)}  `;
    expect(placeReportBodySchema.parse({ reasonCode: 'other', note: padded }).note).toBe(
      'a'.repeat(PLACE_REPORT_NOTE_MAX),
    );
  });

  it('refuses control characters except tab and line feed (#662 F-03)', () => {
    for (const note of ['a\u0000b', 'a\u0007', 'a\u001b', 'a\u007f', 'a\u0085', 'a\rb']) {
      const parsed = placeReportBodySchema.safeParse({ reasonCode: 'other', note });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(['note']);
    }
    expect(placeReportBodySchema.parse({ reasonCode: 'other', note: 'a\nb\tc' }).note).toBe(
      'a\nb\tc',
    );
  });

  it('normalises CRLF to LF rather than refusing pasted text', () => {
    expect(placeReportBodySchema.parse({ reasonCode: 'other', note: 'a\r\nb' }).note).toBe('a\nb');
  });
});
