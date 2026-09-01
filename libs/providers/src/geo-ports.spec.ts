import { describe, expect, it, vi } from 'vitest';
import {
  GeoProviderError,
  geoErrorCodeForStatus,
  isRetryableGeoCode,
  supportsSearch,
  type GeoPlaceProviderPort,
  type GeoProviderErrorCode,
} from './ports';
import { GooglePlacesAdapter } from './google-places.adapter';
import type { PlaceProviderPort } from './ports';

describe('GEO-001 — status classification (spec §17, §18)', () => {
  // The retry table is the expensive half of this contract: a code on the wrong
  // side of it either hammers a provider that already said no, or gives up on a
  // 503 that would have answered.
  const cases: [number, GeoProviderErrorCode, boolean][] = [
    [400, 'INVALID_REQUEST', false],
    [401, 'AUTH_FAILED', false],
    [403, 'FORBIDDEN', false],
    [404, 'NOT_FOUND', false],
    [408, 'TIMEOUT', true],
    [429, 'RATE_LIMITED', true],
    [418, 'INVALID_REQUEST', false],
    [500, 'UPSTREAM_UNAVAILABLE', true],
    [503, 'UPSTREAM_UNAVAILABLE', true],
  ];

  it.each(cases)('%i maps to %s (retryable: %s)', (status, code, retryable) => {
    expect(geoErrorCodeForStatus(status)).toBe(code);
    expect(isRetryableGeoCode(code)).toBe(retryable);
  });

  it('does not retry a response it could not parse', () => {
    // A malformed body parses the same way twice. Retrying it bills for the
    // provider's bug.
    expect(isRetryableGeoCode('BAD_UPSTREAM_RESPONSE')).toBe(false);
  });

  it('carries status and Retry-After without inventing retryability', () => {
    const err = GeoProviderError.fromStatus('vietmap', 429, { retryAfterMs: 2_000 });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.upstreamStatus).toBe(429);
    expect(err.retryAfterMs).toBe(2_000);
    expect(err.retryable).toBe(true);
  });
});

describe('GEO-001 — provider bodies never reach the message (spec §18)', () => {
  it('keeps the upstream payload in cause, out of the message', () => {
    const upstream = { error: 'apikey 7f3a-secret-value is invalid' };
    const err = GeoProviderError.fromStatus('vietmap', 401, { cause: upstream });

    expect(err.message).toBe('geo provider vietmap failed: AUTH_FAILED');
    expect(err.message).not.toContain('secret');
    expect(err.cause).toBe(upstream);
  });
});

describe('GEO-001 — search capability is answered, not thrown', () => {
  it('reports a provider that cannot search', () => {
    // Google Places stays a valid PlaceProviderPort and gains nothing: the POC
    // is not allowed to change what production does with the flag off.
    const google: PlaceProviderPort = new GooglePlacesAdapter('test-key');
    const asGeo = { ...google, providerId: 'google_places' } as GeoPlaceProviderPort;

    expect(supportsSearch(asGeo)).toBe(false);
  });

  it('reports a provider that can', () => {
    const searching: GeoPlaceProviderPort = {
      providerId: 'vietmap',
      resolveUrl: vi.fn(),
      details: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    };

    expect(supportsSearch(searching)).toBe(true);
  });
});
