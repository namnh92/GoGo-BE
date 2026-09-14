import { describe, expect, it } from 'vitest';
import {
  isCoordinateKey,
  REDACTED,
  redactCoordinatesDeep,
  redactCoordinateText,
} from './telemetry-redaction';

describe('isCoordinateKey (#588)', () => {
  it('names a coordinate by exact name, camelCase suffix or snake_case suffix', () => {
    for (const name of [
      'lat',
      'LNG',
      'lon',
      'latitude',
      'Longitude',
      'originLat',
      'originLng',
      'origin_lat',
      'ORIGIN_LNG',
    ]) {
      expect(isCoordinateKey(name)).toBe(true);
    }
  });

  it('leaves look-alikes alone', () => {
    for (const name of [
      'flat',
      'plateau',
      'latencyMs',
      'platform',
      'template',
      'long',
      'lang',
      'slug',
    ]) {
      expect(isCoordinateKey(name)).toBe(false);
    }
  });
});

describe('redactCoordinateText (#588)', () => {
  it('redacts coordinate parameters in a URL, a bare query string and free text', () => {
    expect(redactCoordinateText('https://h/v1/search?q=cafe&lat=10.7&lng=106.7&radiusM=5000')).toBe(
      'https://h/v1/search?q=cafe&lat=[redacted]&lng=[redacted]&radiusM=5000',
    );
    expect(redactCoordinateText('lat=10.7&q=cafe&originLng=106.7')).toBe(
      'lat=[redacted]&q=cafe&originLng=[redacted]',
    );
    expect(redactCoordinateText('Route GET:/v1/search?lat=10.7&lng=106.7 not found')).toBe(
      'Route GET:/v1/search?lat=[redacted]&lng=[redacted] not found',
    );
  });

  it('redacts coordinate members in JSON text and keeps the rest', () => {
    expect(
      redactCoordinateText('{"originLat":10.7,"originLng":"106.7","budgetAmount":500000}'),
    ).toBe('{"originLat":"[redacted]","originLng":"[redacted]","budgetAmount":500000}');
    expect(redactCoordinateText('{"lat": -1.5e2, "title": "lat=1"}')).toBe(
      '{"lat": "[redacted]", "title": "lat=1"}',
    );
  });

  it('drops a Drizzle params list and keeps the query text', () => {
    expect(
      redactCoordinateText('Failed query: select 1 where x = $1\nparams: 106.7,10.7,5000\nat line'),
    ).toBe('Failed query: select 1 where x = $1\nparams: [redacted]\nat line');
  });

  it('changes nothing without a coordinate', () => {
    const text = 'GET /v1/places?q=phở&page=2 → 500 req-1';
    expect(redactCoordinateText(text)).toBe(text);
  });
});

describe('redactCoordinatesDeep (#588)', () => {
  it('redacts query parameters in object and pair forms', () => {
    expect(redactCoordinatesDeep({ lat: '10.7', q: 'cafe', lng: 106.7 })).toEqual({
      lat: REDACTED,
      q: 'cafe',
      lng: REDACTED,
    });
    expect(
      redactCoordinatesDeep([
        ['lat', '10.7'],
        ['q', 'cafe'],
      ]),
    ).toEqual([
      ['lat', REDACTED],
      ['q', 'cafe'],
    ]);
  });

  it('walks nested values and strings without mutating the input', () => {
    const input = {
      request: {
        url: '/v1/locate?lat=1&lng=2',
        data: { stop: { originLat: 1, title: 'Hồ Gươm' } },
      },
      tags: { area: null, latitude: null },
      count: 3,
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    expect(redactCoordinatesDeep(input)).toEqual({
      request: {
        url: '/v1/locate?lat=[redacted]&lng=[redacted]',
        data: { stop: { originLat: REDACTED, title: 'Hồ Gươm' } },
      },
      tags: { area: null, latitude: null },
      count: 3,
    });
    expect(input).toEqual(snapshot);
  });

  it('survives a cycle and passes SDK metadata through untouched', () => {
    const metadata = { normalizedRequest: { url: '/x?lat=1' } };
    const cyclic: Record<string, unknown> = { lat: 1, sdkProcessingMetadata: metadata };
    cyclic.self = cyclic;
    const out = redactCoordinatesDeep(cyclic);
    expect(out.lat).toBe(REDACTED);
    expect(out.sdkProcessingMetadata).toBe(metadata);
  });
});
