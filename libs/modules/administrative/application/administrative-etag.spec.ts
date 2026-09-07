import { describe, expect, it } from 'vitest';
import { administrativeEtag, ifNoneMatchSatisfied } from './administrative-etag';

/**
 * ADM-003 (#456) / ADR-0019 §8.
 *
 * The property that matters is separation: two requests that can produce
 * different bodies must never share a tag. A collision here is not a cache
 * miss, it is a client shown another query's answer — so every parameter is
 * tested for its effect on the tag rather than assumed to have one.
 */

const V = 'v5.0.0+v2.4.1+7fac8c45+none+r0';

describe('the tag carries no clock and no process state', () => {
  it('is identical across calls, so two instances agree and a restart changes nothing', () => {
    const a = administrativeEtag(V, 'provinces', { limit: 50, cursor: null });
    const b = administrativeEtag(V, 'provinces', { limit: 50, cursor: null });
    expect(a).toBe(b);
    expect(a).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('ignores parameter order — the same request spelled two ways is one entity', () => {
    expect(administrativeEtag(V, 'search', { query: 'ba dinh', includeLegacy: false })).toBe(
      administrativeEtag(V, 'search', { includeLegacy: false, query: 'ba dinh' }),
    );
  });
});

describe('different requests cannot share a tag', () => {
  it('changes with the dataset version', () => {
    expect(administrativeEtag(V, 'provinces', {})).not.toBe(
      administrativeEtag('v5.1.0+v2.4.1+7fac8c45+none+r0', 'provinces', {}),
    );
  });

  it('changes with the route, so two endpoints never collide', () => {
    expect(administrativeEtag(V, 'provinces', {})).not.toBe(administrativeEtag(V, 'version', {}));
  });

  it.each([
    ['includeLegacy', { includeLegacy: false }, { includeLegacy: true }],
    ['a date', { at: null }, { at: '2020-01-01' }],
    ['pagination limit', { limit: 50 }, { limit: 51 }],
    ['a cursor', { cursor: null }, { cursor: 'MDAwMDQ' }],
    ['a province filter', { provinceCode: null }, { provinceCode: '01' }],
    ['the query itself', { query: 'ba dinh' }, { query: 'ba dinh ' + '' + 'x' }],
  ])('changes with %s', (_label, left, right) => {
    expect(administrativeEtag(V, 'search', left)).not.toBe(administrativeEtag(V, 'search', right));
  });

  it('distinguishes a number from its string spelling', () => {
    // Without the type in the hash, `limit=50` and `limit="50"` would collide —
    // harmless here, but the same weakness lets `code=01` and `code=1` collide
    // where it is not harmless.
    expect(administrativeEtag(V, 'provinces', { limit: 50 })).not.toBe(
      administrativeEtag(V, 'provinces', { limit: '50' }),
    );
  });

  it('does not let an absent parameter impersonate an explicit null', () => {
    // `undefined` means "not part of this request"; `null` means "explicitly
    // nothing". They are different requests and must hash differently.
    expect(administrativeEtag(V, 'search', { provinceCode: undefined })).not.toBe(
      administrativeEtag(V, 'search', { provinceCode: null }),
    );
  });
});

describe('If-None-Match', () => {
  const tag = administrativeEtag(V, 'provinces', {});

  it('matches an exact tag', () => {
    expect(ifNoneMatchSatisfied(tag, tag)).toBe(true);
  });

  it('matches when a proxy has weakened the tag on the way through', () => {
    expect(ifNoneMatchSatisfied(`W/${tag}`, tag)).toBe(true);
  });

  it('matches one entry of a list', () => {
    expect(ifNoneMatchSatisfied(`"other", ${tag}`, tag)).toBe(true);
  });

  it('matches the wildcard', () => {
    expect(ifNoneMatchSatisfied('*', tag)).toBe(true);
  });

  it('does not match a different tag, or none at all', () => {
    expect(ifNoneMatchSatisfied('"something-else"', tag)).toBe(false);
    expect(ifNoneMatchSatisfied(undefined, tag)).toBe(false);
    expect(ifNoneMatchSatisfied('', tag)).toBe(false);
  });
});
