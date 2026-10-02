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
});
