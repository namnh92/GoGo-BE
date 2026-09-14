import type { ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { sentryInitOptions } from './sentry';

/**
 * #588 — a real HTTP request, with a JSON body carrying positions, fails inside
 * a handler on a server instrumented by the exact options `sentry.ts` builds
 * (its integration list, the SDK's HTTP server instrumentation, OpenTelemetry
 * setup as in `main.ts`), and is reported through the app's exception filter.
 * Only the transport is replaced, by an in-memory one.
 *
 * Two layers are asserted separately: the SDK never captures the body onto the
 * request scope (capture off), and the envelope carries no body (event-level
 * drop). Re-enabling capture breaks the first; re-enabling capture and removing
 * the event-level drop breaks the second.
 */

const LAT = '10.776912';
const LNG = '106.700981';
const BODY_MARKER = 'body-marker-591';

const sent: unknown[] = [];
let app: FastifyInstance;
let origin = '';
let bodyOnScope: unknown = 'not read';

type EventLike = {
  request?: {
    url?: string;
    method?: string;
    query_string?: string;
    headers?: Record<string, string>;
    data?: unknown;
    cookies?: unknown;
  };
  extra?: Record<string, unknown>;
  exception?: { values: { type: string; value: string }[] };
};

function events(): EventLike[] {
  return sent.flatMap((envelope) =>
    (envelope as [unknown, [{ type: string }, EventLike][]])[1]
      .filter(([header]) => header.type === 'event')
      .map(([, event]) => event),
  );
}

beforeAll(async () => {
  Sentry.init({
    ...sentryInitOptions({ dsn: 'https://public@o0.ingest.sentry.io/0', environment: 'test' }),
    transport: () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });

  app = Fastify({
    logger: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' ? incoming : 'unknown';
    },
  });
  const filter = new AppExceptionFilter();
  app.setErrorHandler((error, request, reply) => {
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ArgumentsHost;
    filter.catch(error, host);
  });
  app.patch('/v1/rooms/:id/constraints', async (request) => {
    // What the SDK stored for this request while the body was being read.
    const metadata = Sentry.getIsolationScope().getScopeData().sdkProcessingMetadata as {
      normalizedRequest?: { data?: unknown; url?: string };
    };
    bodyOnScope = metadata.normalizedRequest
      ? metadata.normalizedRequest.data
      : 'no request on scope';
    expect(request.body).toMatchObject({ note: BODY_MARKER });
    throw new Error('constraint write failed');
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app?.close();
  await Sentry.close(2000);
});

describe('a real request never sends its body or position to Sentry (#588)', () => {
  it('reports the failure with diagnostics and without the body', async () => {
    const response = await fetch(
      `${origin}/v1/rooms/r1/constraints?lat=${LAT}&lng=${LNG}&dryRun=1`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'GoGo/0.1.0',
          'x-request-id': 'req-591',
          referer: `https://cms-dev.gogo.id.vn/rooms?from=https%3A%2F%2Fwww.google.com%2Fmaps%2F%40${LAT}%2C${LNG}`,
          cookie: 'gogo_session=abc',
        },
        body: JSON.stringify({
          note: BODY_MARKER,
          originLat: Number(LAT),
          originLng: Number(LNG),
          url: `https://www.google.com/maps/place/Cafe/@${LAT},${LNG},17z`,
          geometry: { type: 'Point', coordinates: [Number(LNG), Number(LAT)] },
        }),
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'INTERNAL', request_id: 'req-591' });
    await Sentry.flush(2000);

    // Event layer.
    const reported = events();
    expect(reported).toHaveLength(1);
    const [event] = reported;
    const payload = JSON.stringify(sent);
    expect(payload).not.toContain(BODY_MARKER);
    expect(payload).not.toContain(LAT);
    expect(payload).not.toContain(LNG);
    expect(event?.request?.data).toBeUndefined();
    expect(event?.request?.cookies).toBeUndefined();

    expect(event?.request?.method).toBe('PATCH');
    expect(event?.request?.url).toBe(
      `${origin}/v1/rooms/r1/constraints?lat=[redacted]&lng=[redacted]&dryRun=1`,
    );
    expect(event?.request?.query_string).toBe('lat=[redacted]&lng=[redacted]&dryRun=1');
    expect(event?.request?.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'GoGo/0.1.0',
      'x-request-id': 'req-591',
    });
    expect(event?.request?.headers).not.toHaveProperty('referer');
    expect(event?.request?.headers).not.toHaveProperty('cookie');
    expect(event?.extra?.request_id).toBe('req-591');
    expect(event?.exception?.values.at(-1)).toMatchObject({
      type: 'Error',
      value: 'constraint write failed',
    });

    // Capture layer, checked last so the event layer above is exercised on its
    // own: the SDK instrumented this request but kept no body on its scope.
    expect(bodyOnScope).toBeUndefined();

    const client = Sentry.getClient();
    const names = (client?.getOptions().integrations ?? []).map((integration) => integration.name);
    expect(names.filter((name) => /^Http(?:$|\.)/.test(name))).toEqual(['Http']);
  });
});
