import { describe, expect, it } from 'vitest';
import { normalizeVietnamese, toSearchQuery } from './normalize';

describe('Vietnamese normalization (SE-002)', () => {
  it('strips diacritics including đ', () => {
    expect(normalizeVietnamese('Bún đậu Mắm tôm')).toBe('bun dau mam tom');
    expect(normalizeVietnamese('Phở Hà Nội')).toBe('pho ha noi');
    expect(normalizeVietnamese('ĐÀ NẴNG')).toBe('da nang');
  });

  it('collapses whitespace', () => {
    expect(normalizeVietnamese('  cà   phê  ')).toBe('ca phe');
  });

  it('accented and unaccented input normalize identically', () => {
    expect(normalizeVietnamese('cà phê sữa đá')).toBe(normalizeVietnamese('ca phe sua da'));
  });

  it('search query strips tsquery-dangerous characters', () => {
    expect(toSearchQuery("cafe & 'drop|table'!")).toBe('cafe drop table');
  });
});
