import type * as SentryNode from '@sentry/node';
import { describe, expect, it, vi } from 'vitest';

const httpCalls: { options: unknown; instance: unknown }[] = [];

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof SentryNode>();
  return {
    ...actual,
    // The real integration, recorded so the final list can be checked by identity.
    httpIntegration: (options: Parameters<typeof actual.httpIntegration>[0]) => {
      const instance = actual.httpIntegration(options);
      httpCalls.push({ options, instance });
      return instance;
    },
  };
});

import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { HTTP_INTEGRATION_NAME, sanitizeRequest, sentryInitOptions } from './sentry';

/** #588 — the structural half of the boundary, checked without a network. */
describe('Sentry options (#588)', () => {
  it('builds the final integration list itself: SDK defaults, one HTTP integration, no body capture', () => {
    const options = sentryInitOptions({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      environment: 'test',
    });

    // The SDK default list is not merged in, so `integrations` is the final list.
    expect(options.defaultIntegrations).toBe(false);
    const integrations = options.integrations as { name: string }[];
    const names = integrations.map((integration) => integration.name);
    expect(new Set(names).size).toBe(names.length);

    const http = integrations.filter((integration) => HTTP_INTEGRATION_NAME.test(integration.name));
    expect(http).toHaveLength(1);
    expect(httpCalls).toHaveLength(1);
    expect(http[0]).toBe(httpCalls[0]?.instance);
    expect(httpCalls[0]?.options).toEqual({ maxIncomingRequestBodySize: 'none' });

    // Every other SDK default is kept.
    const sdkDefaults = Sentry.getDefaultIntegrations({})
      .map((integration) => integration.name)
      .filter((name) => !HTTP_INTEGRATION_NAME.test(name));
    expect(names.filter((name) => !HTTP_INTEGRATION_NAME.test(name))).toEqual(sdkDefaults);
    expect(names.at(-1)).toBe('Http');

    expect(options.sendDefaultPii).toBe(false);
    expect(options).not.toHaveProperty('includeLocalVariables');
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options).not.toHaveProperty('tracesSampler');
  });

  it('keeps only url, method, query string and allowlisted headers', () => {
    const event = {
      type: undefined,
      request: {
        url: '/v1/rooms',
        method: 'POST',
        query_string: 'x=1',
        data: '{"constraint":{"originLat":10.7}}',
        cookies: { session: 'abc' },
        env: { REMOTE_ADDR: '10.0.0.1' },
        headers: {
          'User-Agent': 'GoGo/0.1.0',
          'content-type': 'application/json',
          referer: 'https://cms/places?lat=10.7',
          origin: 'https://cms',
          authorization: 'Bearer x',
          'x-forwarded-for': '1.2.3.4',
          'x-request-id': 'req-1',
        },
      },
    } as ErrorEvent;
    expect(sanitizeRequest(event).request).toEqual({
      url: '/v1/rooms',
      method: 'POST',
      query_string: 'x=1',
      headers: {
        'User-Agent': 'GoGo/0.1.0',
        'content-type': 'application/json',
        'x-request-id': 'req-1',
      },
    });
    expect(sanitizeRequest({ extra: {} } as ErrorEvent)).toEqual({ extra: {} });
  });
});
