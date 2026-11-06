import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { CmsContentController } from '../../../libs/modules/cms/presentation/cms.controllers';
import { CmsContentService } from '../../../libs/modules/cms/application/cms-content.service';
import { RateLimit } from '../../../libs/modules/identity/presentation/decorators';
import { RateLimitGuard } from '../../../libs/modules/identity/presentation/rate-limit.guard';
import { InMemoryRateLimitStore } from '../../../libs/modules/identity/presentation/rate-limit.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';

const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function ready(module: Parameters<typeof NestFactory.create>[0]) {
  const app = await NestFactory.create<NestFastifyApplication>(
    module,
    new FastifyAdapter({ genReqId: () => 'group02-request' }),
    { logger: false },
  );
  apps.push(app);
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new AppExceptionFilter());
  return app;
}

describe('F-01 taxonomy HTTP validation', () => {
  async function setup() {
    const rows: { id: string; kind: string; key: string; labels: Record<string, string> }[] = [];
    const content = {
      createTaxonomy: async (_actor: string, input: Omit<(typeof rows)[number], 'id'>) => {
        const row = { id: randomUUID(), ...input };
        rows.push(row);
        return { id: row.id };
      },
      listTaxonomies: async ({ kind }: { kind?: string }) =>
        rows.filter((r) => !kind || r.kind === kind),
    };
    @Module({
      controllers: [CmsContentController],
      providers: [{ provide: CmsContentService, useValue: content }],
    })
    class Harness {}
    const app = await ready(Harness);
    app.useGlobalGuards({
      canActivate(context) {
        context.switchToHttp().getRequest().actor = { type: 'admin', id: randomUUID() };
        return true;
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  it.each(['amenity', 'checkin_tag'])('creates and lists %s with its labels', async (kind) => {
    const app = await setup();
    const payload = { kind, key: 'group02_test', labels: { vi: 'Tiện ích', en: 'Feature' } };
    const created = await app.inject({ method: 'POST', url: '/v1/cms/taxonomies', payload });
    expect(created.statusCode).toBe(201);
    const listed = await app.inject({ method: 'GET', url: `/v1/cms/taxonomies?kind=${kind}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([{ id: created.json().id, ...payload }]);
  });

  it('accepts exactly the domain/OpenAPI kind sets and rejects an unknown kind', async () => {
    const app = await setup();
    const doc = parse(
      readFileSync(path.resolve(__dirname, '../../../openapi/gogo.v1.yaml'), 'utf8'),
    );
    const contract = doc.paths['/cms/taxonomies'];
    expect(
      new Set(contract.post.requestBody.content['application/json'].schema.properties.kind.enum),
    ).toEqual(new Set(schema.taxonomyKind.enumValues));
    expect(
      new Set(contract.get.parameters.find((p: { name: string }) => p.name === 'kind').schema.enum),
    ).toEqual(new Set(schema.taxonomyKind.enumValues));
    for (const kind of schema.taxonomyKind.enumValues) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/cms/taxonomies',
            payload: { kind, key: 'parity_test', labels: { vi: 'Test' } },
          })
        ).statusCode,
      ).toBe(201);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/cms/taxonomies',
          payload: { kind: 'unknown', key: 'unknown_test', labels: {} },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/cms/taxonomies?kind=unknown' })).statusCode,
    ).toBe(400);
  });
});

@Controller('places')
class SearchHarnessController {
  @Get('search')
  @RateLimit({ action: 'places.search', limit: 60, windowSeconds: 60, keyBy: 'ip' })
  search() {
    return { results: [], meta: {} };
  }
}

describe('F-03 counted search HTTP degradation', () => {
  async function setup(countLimit?: number) {
    @Module({ controllers: [SearchHarnessController] })
    class Harness {}
    const app = await ready(Harness);
    const store = new InMemoryRateLimitStore();
    const hit = vi.spyOn(store, 'hit');
    app.useGlobalGuards(
      new RateLimitGuard(
        new Reflector(),
        store,
        new InMemoryRateLimitStore(),
        countLimit === undefined ? {} : { SEARCH_COUNT_PER_MINUTE: countLimit },
      ),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return {
      hit,
      request: (counted = true) =>
        app.inject({
          method: 'GET',
          url: `/v1/places/search${counted ? '?includeTotal=true' : ''}`,
        }),
    };
  }

  function unavailable(response: Awaited<ReturnType<NestFastifyApplication['inject']>>) {
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: 'SEARCH_COUNT_UNAVAILABLE',
      message: expect.any(String),
      field_errors: [],
      request_id: 'group02-request',
      retryable: true,
    });
  }

  it('degrades request 21 and allows uncounted fallback; rejected counts consume ordinary quota', async () => {
    const { request, hit } = await setup();
    for (let i = 0; i < 20; i++) expect((await request()).statusCode).toBe(200);
    unavailable(await request());
    expect((await request(false)).statusCode).toBe(200);
    expect(hit.mock.calls.filter(([key]) => key.startsWith('places.search|'))).toHaveLength(22);
    for (let i = 22; i < 60; i++) expect((await request(false)).statusCode).toBe(200);
    const both = await request();
    expect(both.statusCode).toBe(429);
    expect(both.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(both.headers['retry-after']).toBe('60');
    expect(hit.mock.calls.filter(([key]) => key.startsWith('places.search.count|'))).toHaveLength(
      21,
    );
  });

  it('honours configured limits and resets both windows', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { request } = await setup(2);
    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(200);
    unavailable(await request());
    expect((await request(false)).statusCode).toBe(200);
    now += 60_001;
    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(200);
    unavailable(await request());
  });

  it('keeps ordinary search exhaustion at RATE_LIMITED', async () => {
    const { request } = await setup();
    for (let i = 0; i < 60; i++) expect((await request(false)).statusCode).toBe(200);
    const response = await request(false);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });
});
