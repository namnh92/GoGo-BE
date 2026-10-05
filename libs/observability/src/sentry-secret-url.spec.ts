import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sentryInitOptions } from './sentry';

/**
 * BE#675 F-03 — a heartbeat ping URL carries its credential in the path
 * (healthchecks.io style: anyone holding it can report the worker healthy).
 * The SDK's fetch breadcrumb keeps the path, so a job failure captured after a
 * ping would carry the credential to Sentry. Checked on the payload that would
 * leave, captured by an in-memory transport.
 */

const TOKEN = '6f1c2a9e-0b7d-4c3e-9f5a-1d2e3f4a5b6c';
const HEARTBEAT = `https://hc-ping.com/${TOKEN}`;

const sent: unknown[] = [];

beforeAll(() => {
  Sentry.init({
    ...sentryInitOptions({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      environment: 'test',
      secretUrls: [HEARTBEAT, undefined, ''],
    }),
    defaultIntegrations: false,
    integrations: [],
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

describe('secret URLs never reach Sentry (BE#675 F-03)', () => {
  it('redacts a heartbeat ping breadcrumb before a later job failure is sent', async () => {
    // The shape `@sentry/node-core` utils/outgoingFetchRequest.js adds after a fetch.
    Sentry.addBreadcrumb({
      category: 'http',
      type: 'http',
      data: { url: HEARTBEAT, 'http.method': 'GET', status_code: 200, 'http.query': '?rid=1' },
    });
    Sentry.addBreadcrumb({
      category: 'http',
      type: 'http',
      data: { url: 'https://places.googleapis.com/v1/places:searchText', status_code: 200 },
    });
    Sentry.captureException(new Error('outbox tick failed'), {
      tags: { periodic_job: 'gogo:worker:outbox' },
    });
    await Sentry.flush(1_000);

    expect(sent).toHaveLength(1);
    const payload = JSON.stringify(sent);
    expect(payload).not.toContain(TOKEN);
    expect(payload).toContain('https://hc-ping.com/[redacted]');
    expect(payload).not.toContain('?rid=1');
    // Only the configured URL is touched.
    expect(payload).toContain('https://places.googleapis.com/v1/places:searchText');
  });
});
