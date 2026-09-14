import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sentryInitOptions } from './sentry';

/**
 * #588 — the payload that would leave for Sentry, captured by an in-memory
 * transport, carries no exact position from any path traced in
 * `docs/verification/SEC-588.md`, and still carries what an operator needs to
 * diagnose the error.
 */

const LAT = '10.776912';
const LNG = '106.700981';
/** A Google Maps link's `@lat,lng` has four decimals; `10.7769` is a prefix of LAT. */
const LAT4 = '10.7769';
const LNG4 = '106.7009';

const sent: unknown[] = [];

type Exception = { type: string; value: string; stacktrace?: { frames: unknown[] } };
type EventLike = {
  request: {
    url: string;
    method: string;
    query_string: string;
    headers: Record<string, string>;
    data?: unknown;
    cookies?: unknown;
  };
  extra: Record<string, unknown>;
  exception: { values: Exception[] };
  breadcrumbs?: { category: string; message?: string; data?: Record<string, unknown> }[];
};

function events(): EventLike[] {
  return sent.flatMap((envelope) =>
    (envelope as [unknown, [{ type: string }, EventLike][]])[1]
      .filter(([header]) => header.type === 'event')
      .map(([, event]) => event),
  );
}

beforeAll(() => {
  const options = sentryInitOptions({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    environment: 'test',
  });
  Sentry.init({
    ...options,
    // The integrations that copy request data and error causes into an event.
    // Global handlers and HTTP instrumentation have no place in a unit test
    // process; that the real `Http` integration never captures bodies is
    // pinned by `sentry-options.spec.ts`.
    defaultIntegrations: false,
    integrations: [Sentry.requestDataIntegration(), Sentry.linkedErrorsIntegration()],
    skipOpenTelemetrySetup: true,
    transport: () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
});

afterAll(async () => {
  await Sentry.close();
});

describe('Sentry events never carry an exact position (#588)', () => {
  it('keeps positions out of every traced path and keeps the diagnostics', async () => {
    Sentry.withIsolationScope((scope) => {
      // What the SDK's HTTP integration puts on the scope for a request. `data`
      // is set here as if a body had been captured, to prove the event-level
      // drop as well as the capture-level one.
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: `https://api-dev.gogo.id.vn/v1/places/search?q=cafe&bounds=10.70,106.60,10.85,106.80&lat=${LAT}&lng=${LNG}&page=2`,
          method: 'GET',
          query_string: `q=cafe&bounds=10.70,106.60,10.85,106.80&lat=${LAT}&lng=${LNG}&page=2`,
          headers: {
            host: 'api-dev.gogo.id.vn',
            referer: `https://cms-dev.gogo.id.vn/places/new?from=https%3A%2F%2Fwww.google.com%2Fmaps%2F%40${LAT4}%2C${LNG4}%2C17z`,
            cookie: 'gogo_cms_session=abc',
            'user-agent': 'GoGo/0.1.0',
            'x-request-id': 'req-588',
          },
          cookies: { gogo_cms_session: 'abc' },
          data: JSON.stringify({
            url: `https://www.google.com/maps/place/Cafe/@${LAT4},${LNG4},17z/data=!3m1!4b1!8m2!3d${LAT}!4d${LNG}`,
            geometry: { type: 'Point', coordinates: [Number(LNG), Number(LAT)] },
            location: { lat: Number(LAT), lng: Number(LNG) },
            csv: `name,lat,lng\nQuán A,${LAT},${LNG}`,
            constraint: { originLat: Number(LAT), originLng: Number(LNG), budgetAmount: 500000 },
          }),
        },
      });
      Sentry.addBreadcrumb({
        category: 'console',
        level: 'error',
        message: `retrying near ${LAT}, ${LNG} after timeout`,
        data: {
          arguments: ['retrying', { location: { latitude: Number(LAT), longitude: Number(LNG) } }],
        },
      });
      Sentry.addBreadcrumb({
        category: 'http',
        type: 'http',
        data: {
          url: 'https://places.googleapis.com/v1/places:searchText',
          'http.method': 'GET',
          'http.query': `?viewport=10.70,106.60,10.85,106.80&radius=500`,
          status_code: 502,
        },
      });

      // A failed insert: Drizzle's message lists the bound WKT, and the pg
      // cause echoes the geometry it could not parse.
      const cause = Object.assign(
        new Error(`parse error - invalid geometry: POINT(${LNG} ${LAT}) near position 12`),
        { detail: `Failing row contains (a1, Quán A, ${LAT}, ${LNG}).` },
      );
      Sentry.captureException(
        new Error(
          `Failed query: insert into places (name, geom) values ($1, ST_GeomFromText($2, 4326))\nparams: Quán A,SRID=4326;POINT(${LNG} ${LAT})`,
          { cause },
        ),
        { extra: { request_id: 'req-588' } },
      );
      // A message that quotes an import row and a GeoJSON body.
      Sentry.captureException(
        new Error(
          `import row 3 rejected: "Quán A",${LAT},${LNG}; Key (lat, lng)=(${LAT}, ${LNG}) already exists; body {"type":"Feature","geometry":{"type":"Point","coordinates":[${LNG},${LAT}]},"properties":{"name":"Quán A"}}`,
        ),
        { extra: { request_id: 'req-588' } },
      );
    });
    await Sentry.flush(2000);

    const payload = JSON.stringify(sent);
    expect(events()).toHaveLength(2);
    for (const value of [LAT, LNG, LAT4, LNG4]) expect(payload).not.toContain(value);

    const [insert, importRow] = events();
    if (!insert || !importRow) throw new Error('expected two events');

    // Structural: no body, no cookies, no referer; allowlisted headers kept.
    expect(insert.request.data).toBeUndefined();
    expect(insert.request.cookies).toBeUndefined();
    expect(insert.request.headers.referer).toBeUndefined();
    expect(insert.request.headers.cookie).toBeUndefined();
    expect(insert.request.headers['user-agent']).toBe('GoGo/0.1.0');
    expect(insert.request.headers['x-request-id']).toBe('req-588');

    // Pattern: positions gone, everything else in the URL kept.
    expect(insert.request.method).toBe('GET');
    expect(insert.request.url).toBe(
      'https://api-dev.gogo.id.vn/v1/places/search?q=cafe&bounds=[redacted]&lat=[redacted]&lng=[redacted]&page=2',
    );
    expect(insert.request.query_string).toBe(
      'q=cafe&bounds=[redacted]&lat=[redacted]&lng=[redacted]&page=2',
    );
    expect(insert.extra.request_id).toBe('req-588');

    const [causeValue, topValue] = insert.exception.values;
    expect(topValue?.type).toBe('Error');
    expect(topValue?.value).toContain('ST_GeomFromText($2, 4326)');
    expect(topValue?.value).toContain('params: [redacted]');
    expect(topValue?.stacktrace?.frames.length).toBeGreaterThan(0);
    expect(causeValue?.value).toContain('parse error - invalid geometry: POINT([redacted])');

    const importValue = importRow.exception.values.at(-1)?.value ?? '';
    expect(importValue).toContain('import row 3 rejected: "Quán A",[redacted];');
    expect(importValue).toContain('Key (lat, lng)=([redacted]) already exists');
    expect(importValue).toContain('"geometry":"[redacted]","properties":{"name":"Quán A"}');

    const crumbs = insert.breadcrumbs ?? [];
    const http = crumbs.find((crumb) => crumb.category === 'http');
    expect(http?.data?.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(http?.data?.['http.query']).toBe('?viewport=[redacted]&radius=500');
    expect(http?.data?.status_code).toBe(502);
    const console = crumbs.find((crumb) => crumb.category === 'console');
    expect(console?.message).toBe('retrying near [redacted] after timeout');
  });
});
