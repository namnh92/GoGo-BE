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
