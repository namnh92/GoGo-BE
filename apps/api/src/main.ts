import 'reflect-metadata';
import * as Sentry from '@sentry/node';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { createLogger } from '@gogo/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { CSRF_HEADER } from '@gogo/modules';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

/** '1' → hop count, 'false' → no trust, otherwise a CIDR/IP allowlist. */
function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim();
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createApp(): Promise<NestFastifyApplication> {
  const config = loadEnv();
  if (config.SENTRY_DSN) {
    // Error monitoring (FND-007). captureException elsewhere is a safe no-op
    // until this init runs.
    Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV });
  }
  const logger = createLogger({
    level: config.LOG_LEVEL,
    name: 'gogo-api',
    pretty: config.NODE_ENV === 'development',
  });

  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    // Only the configured proxy hop(s) may set X-Forwarded-For; trusting all
    // hops would make req.ip client-controlled and defeat IP rate limits.
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    // FND-007: every request carries a request id; incoming x-request-id is
    // honored so traces span BFF and jobs.
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', String(req.id));
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, config.COOKIE_SECRET ? { secret: config.COOKIE_SECRET } : {});
  // Coarse flood net, keyed by IP, applied before authentication resolves —
  // so it has to accommodate a whole office of admins behind one address
  // (BE-IMP-005). The limits that actually matter are the per-action
  // `@RateLimit` specs plus the per-actor baseline in RateLimitGuard, both of
  // which run after the actor is known and are unchanged by this ceiling.
  await app.register(rateLimit, {
    max: 1200,
    timeWindow: '1 minute',
    errorResponseBuilder: (req) => ({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded',
      field_errors: [],
      request_id: String(req.id),
      retryable: true,
    }),
  });

  // PI-BE-011: CMS bulk import upload. Limits are enforced by the parser too;
  // these stop a hostile body before it is ever buffered.
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 12, fieldSize: 64 * 1024 },
  });

  // BE-IMP-003. Browser clients (CMS, Web) send session cookies, so the origin
  // list is an explicit allowlist — never `true`/`*`. Wildcard origin plus
  // credentials hands the session to any page that asks.
  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'idempotency-key',
      'x-request-id',
      CSRF_HEADER,
    ],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();

  return app;
}

async function bootstrap(): Promise<void> {
  const config = loadEnv();
  const app = await createApp();
  await app.listen({ port: config.API_PORT, host: config.API_HOST });
}

/* istanbul ignore next -- entrypoint */
if (require.main === module) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
