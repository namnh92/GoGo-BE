import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sentryInitOptions } from './sentry';

/**
 * #588 — the payload that would leave for Sentry, captured by an in-memory
 * transport, carries no exact position from any of the places the SDK copies a
 * request into, and still carries what an operator needs to diagnose the error.
 */

const LAT = '10.776912';
const LNG = '106.700981';

const sent: unknown[] = [];

type EventLike = {
  request: {
    url: string;
    method: string;
    query_string: string;
    headers: Record<string, string>;
    data: string;
  };
  extra: Record<string, unknown>;
  exception: { values: { type: string; value: string; stacktrace: { frames: unknown[] } }[] };
  breadcrumbs: { category: string; message?: string; data?: Record<string, unknown> }[];
};

function lastEvent(): EventLike {
  const envelope = sent.at(-1) as [unknown, [[{ type: string }, EventLike]]];
  const item = envelope[1].find(([header]) => header.type === 'event');
  if (!item) throw new Error('no event item in the envelope');
  return item[1];
}

beforeAll(() => {
  Sentry.init({
    ...sentryInitOptions({ dsn: 'https://public@o0.ingest.sentry.io/0', environment: 'test' }),
    // Only the integration that copies the request into the event; the global
    // handlers and HTTP instrumentation have no place in a unit test process.
    defaultIntegrations: false,
    integrations: [Sentry.requestDataIntegration()],
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
  it('redacts the URL, query, referer, body, breadcrumbs and query-error params', async () => {
    Sentry.withIsolationScope((scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: `https://api-dev.gogo.id.vn/v1/search?q=cafe&lat=${LAT}&lng=${LNG}&radiusM=5000`,
          method: 'GET',
          query_string: `q=cafe&lat=${LAT}&lng=${LNG}&radiusM=5000`,
          headers: {
            host: 'api-dev.gogo.id.vn',
            referer: `https://go-dev.gogo.id.vn/places?lat=${LAT}&lng=${LNG}`,
            'user-agent': 'GoGo/0.1.0',
          },
          data: JSON.stringify({
            originLat: Number(LAT),
            originLng: Number(LNG),
            budgetAmount: 500000,
          }),
        },
      });
      Sentry.addBreadcrumb({
        category: 'http',
        type: 'http',
        data: {
          url: 'https://maps.example.test/v1/nearby',
          'http.method': 'GET',
          'http.query': `?radius=500&lat=${LAT}&lng=${LNG}`,
          status_code: 502,
        },
      });
      Sentry.addBreadcrumb({
        category: 'console',
        message: `retrying /v1/administrative/locate?lat=${LAT}&lng=${LNG} after timeout`,
        data: { arguments: ['retrying', { lat: Number(LAT), lng: Number(LNG) }] },
      });
      Sentry.captureException(
        new Error(
          `Failed query: select id from places where ST_DWithin(geom, ST_MakePoint($1, $2), $3)\nparams: ${LNG},${LAT},5000`,
        ),
        { extra: { request_id: 'req-588' } },
      );
    });
    await Sentry.flush(2000);

    const payload = JSON.stringify(sent);
    expect(sent.length).toBeGreaterThan(0);
    expect(payload).not.toContain(LAT);
    expect(payload).not.toContain(LNG);

    const event = lastEvent();
    expect(event.request.method).toBe('GET');
    expect(event.request.url).toBe(
      'https://api-dev.gogo.id.vn/v1/search?q=cafe&lat=[redacted]&lng=[redacted]&radiusM=5000',
    );
    expect(event.request.query_string).toBe('q=cafe&lat=[redacted]&lng=[redacted]&radiusM=5000');
    expect(event.request.headers['user-agent']).toBe('GoGo/0.1.0');
    expect(event.request.data).toContain('"budgetAmount":500000');
    expect(event.extra.request_id).toBe('req-588');

    const [exception] = event.exception.values;
    expect(exception?.type).toBe('Error');
    expect(exception?.value).toContain('ST_MakePoint($1, $2)');
    expect(exception?.value).toContain('params: [redacted]');
    expect(exception?.stacktrace.frames.length).toBeGreaterThan(0);

    const http = event.breadcrumbs.find((crumb) => crumb.category === 'http');
    expect(http?.data?.url).toBe('https://maps.example.test/v1/nearby');
    expect(http?.data?.['http.query']).toBe('?radius=500&lat=[redacted]&lng=[redacted]');
    expect(http?.data?.status_code).toBe(502);
  });
});
