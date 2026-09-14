import type * as SentryNode from '@sentry/node';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof SentryNode>();
  return {
    ...actual,
    httpIntegration: vi.fn((options: unknown) => ({ name: 'Http', options })),
  };
});

import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { sanitizeRequest, sentryInitOptions } from './sentry';

/** #588 — the structural half of the boundary, checked without a network. */
describe('Sentry options (#588)', () => {
  it('replaces the Http integration with one that never captures request bodies', () => {
    const options = sentryInitOptions({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      environment: 'test',
    });
    expect(Sentry.httpIntegration).toHaveBeenCalledWith({ maxIncomingRequestBodySize: 'none' });
    expect(options.integrations).toEqual([
      { name: 'Http', options: { maxIncomingRequestBodySize: 'none' } },
    ]);
    expect(options.sendDefaultPii).toBe(false);
    expect(options).not.toHaveProperty('includeLocalVariables');
    expect(options).not.toHaveProperty('tracesSampleRate');
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
