import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserContentController } from '../../../libs/modules/reviews/presentation/user-content.controller';
import { UserContentService } from '../../../libs/modules/reviews/application/user-content.service';
import { DEFAULT_CATEGORIES } from '../../../libs/modules/notifications/domain/notification-registry';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';

const actor = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: 'settings-http',
};
const initial = () => ({
  push_enabled: true,
  source: 'default',
  updated_at: null as string | null,
  version: '0',
  categories: { ...DEFAULT_CATEGORIES },
  quiet_hours_enabled: false,
  timezone: null as string | null,
});
let stored = initial();
// Substitute database results only. The service, shared settings reader/writer,
// Nest DTO validation and Fastify response serialization are production code.
const execute = async (query: SQL) => {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  if (sql.includes('select writes_frozen'))
    return { rows: [{ writes_frozen: false, recipient_keys_enabled: true }] };
  if (sql.includes('select id from users')) return { rows: [{ id: actor.id }] };
  if (sql.includes('from users u left join notification_settings'))
    return { rows: [{ ...stored }] };
  if (sql.includes('insert into notification_settings')) {
    stored = {
      ...stored,
      push_enabled: params[1] as boolean,
      source: params[2] as string,
      version: String(Number(stored.version) + Number(params[3])),
      updated_at: '2026-11-10T00:00:00Z',
      quiet_hours_enabled: params[4] as boolean,
      timezone: params[5] as string | null,
    };
  }
  return { rows: [] };
};
const db = {
  execute,
  transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  insert: () => ({ values: async () => undefined }),
};
const service = new UserContentService(db as unknown as Db, {} as never, {} as never, null);

@Module({
  controllers: [UserContentController],
  providers: [{ provide: UserContentService, useValue: service }],
})
class Harness {}

describe('PR4 settings HTTP response without database infrastructure', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRequest', async (request) => {
      Object.assign(request, { actor });
    });
    app = await NestFactory.create<NestFastifyApplication>(Harness, adapter, { logger: false });
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    stored = initial();
  });

  it('returns default-off quietHours through the canonical GET settings reader', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me/notification-settings' });
    expect(response.statusCode).toBe(200);
    expect(response.json().quietHours).toEqual({ enabled: false, timezone: null });
    expect(response.headers.etag).toBe('"notification-settings-0"');
  });

  it('preserves quietHours through legacy PUT and returns the new version ETag', async () => {
    stored.quiet_hours_enabled = true;
    stored.timezone = 'Asia/Ho_Chi_Minh';
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-settings',
      payload: { pushEnabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().quietHours).toEqual({ enabled: true, timezone: 'Asia/Ho_Chi_Minh' });
    expect(response.headers.etag).toBe('"notification-settings-1"');
    expect(response.headers['cache-control']).toBe('private, no-store');
    const read = await app.inject({ method: 'GET', url: '/v1/me/notification-settings' });
    expect(read.json()).toEqual(response.json());
    expect(read.headers.etag).toBe(response.headers.etag);
  });
});
