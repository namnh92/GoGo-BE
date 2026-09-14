import { describe, expect, it } from 'vitest';
import {
  isCoordinateContainerKey,
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

describe('isCoordinateContainerKey (#588)', () => {
  it('names keys whose whole value is a position', () => {
    for (const name of [
      'coordinates',
      'bbox',
      'bounds',
      'Viewport',
      'latLng',
      'll',
      'geom',
      'geometry',
      'point',
    ]) {
      expect(isCoordinateContainerKey(name)).toBe(true);
    }
    for (const name of ['points', 'pointsTotal', 'boundary', 'llm', 'geoCode']) {
      expect(isCoordinateContainerKey(name)).toBe(false);
    }
  });
});

describe('redactCoordinateText by shape (#588)', () => {
  const LAT = '10.776912';
  const LNG = '106.700981';

  it('redacts a coordinate pair in a Google Maps URL, an encoded parameter and a CSV row', () => {
    expect(
      redactCoordinateText(
        `https://www.google.com/maps/place/Cafe/@10.7769,106.7009,17z/data=!3m1!4b1!8m2!3d${LAT}!4d${LNG}`,
      ),
    ).toBe(
      'https://www.google.com/maps/place/Cafe/@[redacted],17z/data=!3m1!4b1!8m2!3d[redacted]!4d[redacted]',
    );
    expect(redactCoordinateText('next=%4010.7769%2C106.7009%2C17z')).toBe(
      'next=%40[redacted]%2C17z',
    );
    expect(redactCoordinateText(`row 3: "Quán A",${LAT},${LNG},cafe`)).toBe(
      'row 3: "Quán A",[redacted],cafe',
    );
    expect(redactCoordinateText(`maps?q=${LAT},${LNG}`)).toBe('maps?q=[redacted]');
  });

  it('redacts list-valued position parameters by name', () => {
    expect(redactCoordinateText('/v1/cms/places?bounds=10.70,106.60,10.85,106.80&page=2')).toBe(
      '/v1/cms/places?bounds=[redacted]&page=2',
    );
    expect(redactCoordinateText('viewport=1,2,3,4&ll=10.7,106.7')).toBe(
      'viewport=[redacted]&ll=[redacted]',
    );
  });

  it('redacts WKT and EWKT geometries and keeps the geometry type', () => {
    expect(redactCoordinateText(`invalid geometry: POINT(${LNG} ${LAT}) near position 5`)).toBe(
      'invalid geometry: POINT([redacted]) near position 5',
    );
    expect(redactCoordinateText(`params: x\nSRID=4326;POINT Z (${LNG} ${LAT} 3)`)).toContain(
      'SRID=4326;POINT Z ([redacted])',
    );
    expect(redactCoordinateText('MULTIPOLYGON(((1 2,3 4,5 6,1 2)),((7 8,9 10,11 12,7 8)))')).toBe(
      'MULTIPOLYGON([redacted])',
    );
  });

  it('redacts GeoJSON coordinate arrays in JSON text, even when truncated', () => {
    expect(
      redactCoordinateText(
        `{"type":"Feature","geometry":{"type":"Point","coordinates":[${LNG},${LAT}]},"properties":{"name":"Quán A"}}`,
      ),
    ).toBe('{"type":"Feature","geometry":"[redacted]","properties":{"name":"Quán A"}}');
    expect(redactCoordinateText(`{"coordinates":[[${LNG},${LAT}],[106.7011,10.777`)).toBe(
      '{"coordinates":"[redacted]"',
    );
    expect(redactCoordinateText('{"bounds":{"north":10.8,"south":10.7},"q":"cafe"}')).toBe(
      '{"bounds":"[redacted]","q":"cafe"}',
    );
  });

  it('redacts the row and key values PostgreSQL echoes and keeps the rest', () => {
    expect(
      redactCoordinateText(
        `null value in column "name" violates not-null constraint\nFailing row contains (a1, null, ${LAT}, ${LNG}).`,
      ),
    ).toContain('Failing row contains ([redacted]');
    expect(redactCoordinateText(`Key (lat, lng)=(${LAT}, ${LNG}) already exists.`)).toBe(
      'Key (lat, lng)=([redacted]) already exists.',
    );
  });

  it('leaves versions, money, identifiers, timestamps and coarse pairs alone', () => {
    for (const text of [
      'GoGo/0.1.0 (build 1.2.3,4.5.6)',
      'budget 1.500.000,2.500.000 VND',
      '8d0d2f52-0000-4000-8000-000000000001',
      '2026-09-14T10:47:12.345Z',
      'select * from places where id = $1 and score > 0.75',
      'area 10.77,106.70 (two decimals)',
      'took 12.345ms of 67.890ms',
    ]) {
      expect(redactCoordinateText(text)).toBe(text);
    }
  });
});

describe('redactCoordinatesDeep containers (#588)', () => {
  it('replaces container values whatever their shape', () => {
    expect(
      redactCoordinatesDeep({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [106.7, 10.7] },
        properties: { name: 'Quán A', coordinates: [[1, 2]] },
        viewport: { north: 10.8, south: 10.7, east: 106.8, west: 106.6 },
        place: { location: { latitude: 10.7, longitude: 106.7 } },
        bbox: null,
      }),
    ).toEqual({
      type: 'Feature',
      geometry: REDACTED,
      properties: { name: 'Quán A', coordinates: REDACTED },
      viewport: REDACTED,
      place: { location: { latitude: REDACTED, longitude: REDACTED } },
      bbox: null,
    });
    expect(redactCoordinatesDeep([['bounds', '1,2,3,4']])).toEqual([['bounds', REDACTED]]);
  });
});
