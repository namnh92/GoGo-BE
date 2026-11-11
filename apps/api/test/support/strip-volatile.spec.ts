import { describe, expect, it } from 'vitest';
import { stripVolatile } from './strip-volatile';

describe('stripVolatile', () => {
  it.each([
    'a12000bc-1234-4abc-8def-0123456789ab',
    'A12000BC-1234-4ABC-8DEF-0123456789AB',
    '2026-11-11T12:34:56.120001Z',
    '2026-11-11T12:34:56.120001+07:00',
    '2026-11-11T12:34:56.120001-0700',
  ])('removes volatile value %s containing the fixture price', (value) => {
    const stripped = stripVolatile(JSON.stringify({ value }));
    expect(stripped).toBe('{"value":""}');
    expect(stripped).not.toMatch(/12000/);
  });

  it('removes timestamps without fractional seconds', () => {
    expect(stripVolatile('2026-11-11T12:34:56Z')).toBe('');
  });

  it('preserves fixture prices alongside volatile metadata', () => {
    const stripped = stripVolatile(
      'costs 12000 VND at 2026-11-11T12:34:56.120001Z (a12000bc-1234-4abc-8def-0123456789ab)',
    );
    expect(stripped).toBe('costs 12000 VND at  ()');
    expect(stripped).toMatch(/12000/);
  });
});
