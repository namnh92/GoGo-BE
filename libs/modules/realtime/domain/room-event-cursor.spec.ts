import { describe, expect, it } from 'vitest';
import { formatCursor, parseResumePoint } from './room-event-cursor';

const GEN = '0f8b2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('room event cursor (ADR-0027 D4)', () => {
  it('round-trips v2:<generation>:<seq>', () => {
    const cursor = { generation: GEN, seq: 42 };
    expect(formatCursor(cursor)).toBe(`v2:${GEN}:42`);
    expect(parseResumePoint(formatCursor(cursor))).toEqual({ kind: 'cursor', cursor });
    expect(parseResumePoint(`v2:${GEN}:0`)).toEqual({
      kind: 'cursor',
      cursor: { generation: GEN, seq: 0 },
    });
  });

  it('no cursor (absent or empty) is a fresh stream', () => {
    expect(parseResumePoint(null)).toEqual({ kind: 'fresh' });
    expect(parseResumePoint(undefined)).toEqual({ kind: 'fresh' });
    expect(parseResumePoint('')).toEqual({ kind: 'fresh' });
  });

  it.each([
    ['legacy bare sequence', '7'],
    ['legacy zero', '0'],
    ['garbage', 'abc'],
    ['other version', `v3:${GEN}:1`],
    ['uppercase generation', `v2:${GEN.toUpperCase()}:1`],
    ['not a uuid', 'v2:------------------------------------:1'],
    ['leading zero', `v2:${GEN}:01`],
    ['negative', `v2:${GEN}:-1`],
    ['exponent', `v2:${GEN}:1e3`],
    ['beyond safe integer', `v2:${GEN}:9999999999999999`],
    ['trailing junk', `v2:${GEN}:1 `],
    ['missing seq', `v2:${GEN}:`],
  ])('%s is invalid (answered with resync, never a fresh stream)', (_label, value) => {
    expect(parseResumePoint(value)).toEqual({ kind: 'invalid' });
  });
});
