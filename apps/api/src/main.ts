import 'reflect-metadata';
import * as Sentry from '@sentry/node';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createLogger } from '@gogo/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

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
    trustProxy: true,
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
  // Baseline global rate limit; per-action limits (login/OTP/join/invite/
  // suggestion/report) are attached at the route level per security rules.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (req) => ({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded',
      field_errors: [],
      request_id: String(req.id),
      retryable: true,
    }),
  });

  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: true,
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
