import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/main';

process.env.DATABASE_URL ??= 'postgres://gogo:gogo@localhost:5432/gogo';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.NODE_ENV = 'test';

describe('api runtime skeleton (BE-BFF-001)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health returns ok with request id header', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('honors incoming x-request-id', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/v1/health',
        headers: { 'x-request-id': 'test-req-id-12345' },
      });
    expect(res.headers['x-request-id']).toBe('test-req-id-12345');
  });

  it('serves the OpenAPI contract and docs page (BE-BFF-012)', async () => {
    const spec = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/openapi.yaml',
    });
    expect(spec.statusCode).toBe(200);
    expect(spec.headers['content-type']).toContain('yaml');
    expect(spec.body).toContain('openapi: 3.1.0');

    const docs = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/docs',
    });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toContain('/v1/openapi.yaml');
  });

  it('unknown route returns error envelope', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/definitely-not-a-route',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
      field_errors: [],
    });
    expect(body.request_id).toBeTruthy();
  });
});
