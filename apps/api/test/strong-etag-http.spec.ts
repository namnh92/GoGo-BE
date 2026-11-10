import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AdministrativeController } from '../../../libs/modules/administrative/presentation/administrative.controller';
import { AdministrativeQueryService } from '../../../libs/modules/administrative/application/administrative-query.service';
import { AdministrativeLocateService } from '../../../libs/modules/administrative/application/administrative-locate.service';
import { SystemNotificationsController } from '../../../libs/modules/notifications/presentation/system-notifications.controller';
import { SystemNotificationsService } from '../../../libs/modules/notifications/application/system-notifications.service';
import { CmsCatalogController } from '../../../libs/modules/cms/presentation/cms.controllers';
import { CmsCatalogService } from '../../../libs/modules/cms/application/cms-catalog.service';
import { PlaceSubmissionService } from '../../../libs/modules/ingestion/application/place-submission.service';

// Only application services are substituted: real Nest handlers and Fastify serialization.
const listPublic = vi.fn();
const setVerification = vi.fn().mockResolvedValue({ etag: '"1:2"', status: 'unverified' });
@Module({
  controllers: [AdministrativeController, SystemNotificationsController, CmsCatalogController],
  providers: [
    {
      provide: AdministrativeQueryService,
      useValue: {
        snapshot: async () => ({ datasetVersion: 'test-v1' }),
        version: () => ({ version: 'test-v1' }),
      },
    },
    { provide: AdministrativeLocateService, useValue: {} },
    { provide: SystemNotificationsService, useValue: { listPublic } },
    { provide: CmsCatalogService, useValue: { setVerification } },
    { provide: PlaceSubmissionService, useValue: {} },
  ],
})
class Harness {}

describe('#831 strong ETag HTTP headers', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRequest', async (request) => {
      Object.assign(request, { actor: { id: 'moderator-test', type: 'admin' } });
    });
    app = await NestFactory.create<NestFastifyApplication>(Harness, adapter, { logger: false });
    app.setGlobalPrefix('v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('preserves the administrative validator and cache policy on 200 and 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/administrative/version' });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toMatch(/^"[^" ]+"$/);
    expect(first.headers['cache-control']).toBe('public, max-age=0, must-revalidate, no-transform');
    const second = await app.inject({
      method: 'GET',
      url: '/v1/administrative/version',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.headers['cache-control']).toBe(first.headers['cache-control']);
  });

  it('preserves the system-notifications validator and public TTL on 200 and 304', async () => {
    for (const notModified of [false, true]) {
      listPublic.mockResolvedValueOnce({
        etag: '"announcement-page"',
        notModified,
        body: { items: [], nextCursor: null },
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/system-notifications',
        headers: notModified ? { 'if-none-match': '"announcement-page"' } : {},
      });
      expect(response.statusCode).toBe(notModified ? 304 : 200);
      expect(response.headers.etag).toBe('"announcement-page"');
      expect(response.headers['cache-control']).toBe('public, max-age=60, no-transform');
      if (notModified) expect(response.body).toBe('');
    }
  });

  it('protects CMS verification validators when the service returns the same result again', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/cms/places/00000000-0000-4000-8000-000000000001/verification',
        headers: { 'if-match': '"1:1"', 'idempotency-key': 'verification-test-831' },
        payload: { status: 'unverified', reason: 'Requires review' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe(response.json().etag);
      expect(response.headers.etag).toBe('"1:2"');
      expect(response.headers['cache-control']).toBe('private, no-store, no-transform');
    }
  });
});
