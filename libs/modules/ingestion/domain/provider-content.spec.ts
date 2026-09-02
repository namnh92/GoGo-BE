import { describe, expect, it } from 'vitest';
import type { ResolvedProviderPlace } from '@gogo/providers';
import {
  PROVIDER_CONTENT_KIND,
  PROVIDER_CONTENT_TIERS,
  toEphemeralProviderContent,
  type EphemeralProviderContent,
} from './provider-content';

/**
 * #341 (PR8) — the ephemeral value is shaped so it cannot be persisted by
 * accident (ADR-0006 §9.7.3). Half of this file is compile-time: the
 * `@ts-expect-error` lines fail `tsc` the day the ephemeral shape becomes
 * assignable to the persisted one.
 */

const NOW = new Date('2026-09-02T09:00:00.000Z');

function resolved(overrides: Partial<ResolvedProviderPlace> = {}): ResolvedProviderPlace {
  return {
    providerPlaceId: 'ChIJ_answer',
    name: 'Quán Chao Ban',
    addressText: '12 Nguyễn Huệ, Quận 1',
    lat: 10.7769,
    lng: 106.7009,
    rating: 4.4,
    ratingCount: 251,
    businessStatus: 'OPERATIONAL',
    hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false }],
    priceLevel: 2,
    primaryType: 'cafe',
    types: ['cafe', 'food'],
    googleMapsUri: 'https://maps.google.com/?cid=1',
    photos: [{ reference: 'places/x/photos/y', widthPx: 1, heightPx: 1, attributions: ['a'] }],
    fetchTier: 'quality',
    attribution: 'Google Maps',
    raw: { displayName: { text: 'Quán Chao Ban' }, secret: 'must not leak' },
    ...overrides,
  };
}

/** Every key at every depth. */
function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

function frozenDeep(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(frozenDeep);
}

describe('toEphemeralProviderContent (#341)', () => {
  it('offers exactly the described tiers, with no default', () => {
    expect([...PROVIDER_CONTENT_TIERS]).toEqual(['core', 'quality', 'detail']);
  });

  it('carries no raw payload, no photos and no persistence-shaped field', () => {
    const content = toEphemeralProviderContent(resolved(), 'quality', NOW);
    const keys = keysDeep(content);
    for (const forbidden of ['raw', 'photos', 'fetchTier', 'providerPlaceId', 'secret']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(content.kind).toBe(PROVIDER_CONTENT_KIND);
    expect(content.attribution).toBe('Google Maps');
    expect(content.fetchedAt).toBe(NOW.toISOString());
  });

  it('is frozen at every level', () => {
    const content = toEphemeralProviderContent(resolved(), 'quality', NOW);
    expect(frozenDeep(content)).toBe(true);
    expect(() => {
      (content.facts as { name: string }).name = 'edited';
    }).toThrow();
  });

  it('under core, says "not fetched" rather than reporting zero reviews and no hours', () => {
    // The adapter reports `ratingCount: 0, hours: []` under `core` because the
    // mask did not ask; those are not facts about the place.
    const content = toEphemeralProviderContent(
      resolved({ rating: null, ratingCount: 0, hours: [], priceLevel: null, fetchTier: 'core' }),
      'core',
      NOW,
    );
    expect(content.tier).toBe('core');
    expect(content.facts.quality).toBeNull();
    expect(content.facts.name).toBe('Quán Chao Ban');
    expect(content.facts.location).toEqual({ lat: 10.7769, lng: 106.7009 });
  });

  it('under quality and detail, carries the quality block as a copy', () => {
    const source = resolved();
    for (const tier of ['quality', 'detail'] as const) {
      const content = toEphemeralProviderContent(source, tier, NOW);
      expect(content.facts.quality).toEqual({
        rating: 4.4,
        ratingCount: 251,
        hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false }],
        priceLevel: 2,
      });
      expect(content.facts.quality!.hours[0]).not.toBe(source.hours[0]);
      expect(content.facts.types).not.toBe(source.types);
    }
  });

  it('reports a move when Google answered under another id, keeping both ids', () => {
    const content = toEphemeralProviderContent(
      resolved({ requestedProviderPlaceId: 'ChIJ_old' }),
      'core',
      NOW,
    );
    expect(content.moved).toBe(true);
    expect(content.requestedGooglePlaceId).toBe('ChIJ_old');
    expect(content.googlePlaceId).toBe('ChIJ_answer');

    const same = toEphemeralProviderContent(resolved(), 'core', NOW);
    expect(same.moved).toBe(false);
    expect(same.requestedGooglePlaceId).toBe('ChIJ_answer');
  });

  it('passes FUTURE_OPENING through unflattened — there is no storage to flatten it for', () => {
    const content = toEphemeralProviderContent(
      resolved({ businessStatus: 'FUTURE_OPENING' }),
      'core',
      NOW,
    );
    expect(content.facts.businessStatus).toBe('FUTURE_OPENING');
  });

  it('is not a ResolvedProviderPlace, so no repository that takes one can take it (compile-time)', () => {
    const content: EphemeralProviderContent = toEphemeralProviderContent(
      resolved(),
      'quality',
      NOW,
    );
    // @ts-expect-error — no providerPlaceId / fetchTier / raw / photos / attribution string: the persisted shape is unreachable from the ephemeral one
    const asResolved: ResolvedProviderPlace = content;
    // @ts-expect-error — the facts block alone is not one either
    const factsAsResolved: ResolvedProviderPlace = content.facts;
    expect(asResolved).toBeDefined();
    expect(factsAsResolved).toBeDefined();
  });
});
