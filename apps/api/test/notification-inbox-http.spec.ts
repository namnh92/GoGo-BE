import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@gogo/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotificationInboxService } from '../../../libs/modules/notifications/application/notification-inbox.service';
import { PushSubscriptionsService } from '../../../libs/modules/notifications/application/push-subscriptions.service';
import { NotificationsController } from '../../../libs/modules/notifications/presentation/notifications.controller';
import type { Actor } from '../../../libs/modules/identity/domain/actor';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';

const actor: Actor = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: 'test-session',
};
// Only snapshot and list results are substituted; Nest/Fastify query
// extraction, validation and the application's cursor checks are real.
const execute = vi.fn(async (query) => {
  const text = new PgDialect().sqlToQuery(query).sql;
  return text.includes('from notification_inbox_rollout')
    ? { rows: [{ ready: true, cutoff: '0', unread: 0, as_of: new Date().toISOString() }] }
    : { rows: [] };
});
const inbox = new NotificationInboxService({ execute } as unknown as Db, {
  AUTH_JWT_SECRET: 'inbox-http-regression-secret'.padEnd(48, 'x'),
});
const list = vi.spyOn(inbox, 'list');

@Module({
  controllers: [NotificationsController],
  providers: [
    { provide: NotificationInboxService, useValue: inbox },
    { provide: PushSubscriptionsService, useValue: {} },
  ],
})
class Harness {}

describe('notification list HTTP validation without database infrastructure', () => {
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

  it.each([
    ['', undefined, []],
    ['?kinds=invite', undefined, ['invite']],
    ['?kinds=plan_ready&kinds=invite', undefined, ['plan_ready', 'invite']],
    ['?cursor=2026-11-08T10%3A00%3A00.123Z', '2026-11-08T10:00:00.123Z', []],
  ])('accepts missing query fields and valid kinds/cursors: %s', async (query, cursor, kinds) => {
    const response = await app.inject({ method: 'GET', url: '/v1/me/notifications' + query });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ notifications: [], nextCursor: null });
    expect(list).toHaveBeenLastCalledWith(actor.id, cursor, kinds);
  });

  it('preserves domain cursor errors when kinds is absent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me/notifications?cursor=garbage',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_NOTIFICATION_CURSOR');
  });

  it.each(['unknown', '', 'invite,plan_ready', 'invite&kinds=unknown'])(
    'still rejects invalid kinds: %s',
    async (kinds) => {
      list.mockClear();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/me/notifications?kinds=' + kinds,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_FAILED');
      expect(list).not.toHaveBeenCalled();
    },
  );
});
