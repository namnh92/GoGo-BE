import { describe, expect, it } from 'vitest';
import { minorUnitAmounts } from './minor-unit-amounts';
import { stripVolatile } from './strip-volatile';

describe('minorUnitAmounts with stripVolatile', () => {
  it.each([
    [0, ['0']],
    [123, ['123']],
    [1000, ['1000', '1.000', '1,000']],
    [12000, ['12000', '12.000', '12,000']],
    [24000, ['24000', '24.000', '24,000']],
    [1234567, ['1234567', '1.234.567', '1,234,567']],
  ] as const)('matches every representation of %i in persisted text/frames', (amount, forms) => {
    for (const form of forms) {
      for (const persisted of [{ text: form }, { frames: [{ event: 'delta', text: form }] }]) {
        expect(stripVolatile(JSON.stringify(persisted))).toMatch(minorUnitAmounts(amount));
      }
    }
  });

  it.each(['12000', '12.000', '12,000', '24000', '24.000', '24,000'])(
    'keeps leaked %s beside volatile metadata while removing metadata-only matches',
    (text) => {
      const metadata = {
        id: 'a12000bc-1234-4abc-8def-0123456789ab',
        completedAt: '2026-11-11T12:34:56.120001+07:00',
      };
      const pattern = minorUnitAmounts(12000, 24000);
      expect(stripVolatile(JSON.stringify(metadata))).not.toMatch(pattern);
      expect(stripVolatile(JSON.stringify({ ...metadata, text }))).toMatch(pattern);
    },
  );

  it('treats dots literally and does not accept partial or mixed grouping', () => {
    for (const text of ['12x000', '12 000', '1.234,567', '1,234.567']) {
      expect(text).not.toMatch(minorUnitAmounts(12000, 1234567));
    }
  });

  it.each([
    [12000, ['12000', '12.000', '12,000']],
    [24000, ['24000', '24.000', '24,000']],
  ] as const)('matches %i inside text, JSON and SSE frames', (amount, forms) => {
    for (const form of forms) {
      for (const subject of [
        `Giá ${form} VND/người.`,
        `Price:(${form}), per person.`,
        JSON.stringify({ amount: Number(form.replace(/[.,]/g, '')) }),
        JSON.stringify({ text: form }),
        `event: delta\ndata: ${JSON.stringify({ text: `Giá ${form} VND/người.` })}\n\n`,
      ]) {
        expect(stripVolatile(subject)).toMatch(minorUnitAmounts(amount));
      }
    }
  });

  const otherAmounts = [
    [0, ['10', '01', '1.000', '1,000']],
    [123, ['1230', '1123', '1.123', '1,123', '123.000', '123,000']],
    [12000, ['120000', '112000', '12.0000', '112.000', '12,0000', '112,000']],
    [12000, ['12000.000', '12000,000', '1.12000', '1,12000', '12.000.000', '12,000,000']],
    [12000, ['1.12.000', '1,12,000', '12.000,001', '12,000.001']],
    [24000, ['240000', '124000', '24.0000', '124.000', '24,0000', '124,000']],
    [24000, ['24.000.000', '24,000,000', '1.24.000', '1,24,000']],
    [1234567, ['12345670', '11234567', '1.234.5670', '11.234.567', '1,234,5670', '11,234,567']],
  ] as const;

  it.each(otherAmounts.flatMap(([amount, forms]) => forms.map((form) => [amount, form] as const)))(
    'does not match %i inside another numeric token %s',
    (amount, form) => {
      for (const subject of [
        `Giá ${form} VND/người.`,
        JSON.stringify({ text: form }),
        `event: delta\ndata: ${JSON.stringify({ text: form })}\n\n`,
      ]) {
        expect(stripVolatile(subject)).not.toMatch(minorUnitAmounts(amount));
      }
    },
  );

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid minor-unit amount %s',
    (amount) => {
      expect(() => minorUnitAmounts(amount)).toThrow(RangeError);
    },
  );

  it('rejects an empty guard', () => {
    expect(() => minorUnitAmounts()).toThrow(RangeError);
  });
});
