import { describe, expect, it, vi } from 'vitest';
import {
  GeoProviderError,
  geoErrorCodeForStatus,
  isRetryableGeoCode,
  supportsAutocomplete,
  supportsReverse,
  type GeoPlaceProviderPort,
  type GeoProviderErrorCode,
} from './ports';

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

describe('GEO-001 — optional capabilities are answered, not thrown', () => {
  const base: GeoPlaceProviderPort = {
    providerId: 'vietmap',
    search: vi.fn().mockResolvedValue([]),
    getDetails: vi.fn().mockResolvedValue(null),
  };

  it('reports a provider with neither autocomplete nor reverse', () => {
    // Foursquare has neither. Asking beats calling a method that throws.
    expect(supportsAutocomplete(base)).toBe(false);
    expect(supportsReverse(base)).toBe(false);
  });

  it('reports a provider that has both', () => {
    const full: GeoPlaceProviderPort = {
      ...base,
      autocomplete: vi.fn().mockResolvedValue([]),
      reverse: vi.fn().mockResolvedValue([]),
    };

    expect(supportsAutocomplete(full)).toBe(true);
    expect(supportsReverse(full)).toBe(true);
  });
});
