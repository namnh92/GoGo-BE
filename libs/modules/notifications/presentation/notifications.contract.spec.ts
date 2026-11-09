import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { NotificationsController } from './notifications.controller';
import type { NotificationInboxService } from '../application/notification-inbox.service';
import type { PushSubscriptionsService } from '../application/push-subscriptions.service';
import { idempotencyScope } from '../../shared/idempotency.interceptor';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  type?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, SchemaObject>;
  'x-extensible-enum'?: string[];
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  components: { schemas: Record<string, SchemaObject> };
};

describe('Notification payload contract (#753)', () => {
  it('declares campaign as an inbox kind', () => {
    expect(doc.components.schemas.NotificationKind?.['x-extensible-enum']).toContain('campaign');
  });

  it('declares every display fact as an additive optional payload property', () => {
    const payload = doc.components.schemas.Notification?.properties?.payload;
    expect(payload).toBeDefined();
    if (!payload) throw new Error('Notification.payload is missing');

    expect(payload.properties?.roomName?.type).toBe('string');
    expect(payload.properties?.inviterName?.type).toBe('string');
    expect(payload.properties?.preferenceProgress).toMatchObject({
      type: 'object',
      required: ['completedCount', 'memberCount'],
      properties: {
        completedCount: { type: 'integer' },
        memberCount: { type: 'integer' },
      },
    });
    expect(payload.properties?.stopCount?.type).toBe('integer');
    expect(payload.properties?.planChange).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['edit', 'regenerate'] },
        stopCount: { type: 'integer' },
        optionalStopCount: { type: 'integer' },
        addedStopCount: { type: 'integer' },
        removedStopCount: { type: 'integer' },
        movedStopCount: { type: 'integer' },
        durationChangedStopCount: { type: 'integer' },
        lockChangedStopCount: { type: 'integer' },
        optionalChangedStopCount: { type: 'integer' },
      },
    });
    expect(payload.properties?.planChange?.required).toEqual(['action']);
    expect(payload.properties?.title?.type).toBe('string');
    expect(payload.properties?.body?.type).toBe('string');

    for (const field of [
      'roomName',
      'inviterName',
      'preferenceProgress',
      'stopCount',
      'planChange',
      'title',
      'body',
    ]) {
      expect(payload.required ?? []).not.toContain(field);
    }
  });
});

const spec = parseYaml(readFileSync(SPEC, 'utf8'));
const account = {
  type: 'user' as const,
  sessionId: 'test-session',
  id: '00000000-0000-4000-8000-000000000001',
};
function fixture() {
  const inbox = {
    summary: vi.fn().mockResolvedValue({ unreadCount: 2 }),
    list: vi.fn(),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    readAll: vi
      .fn()
      .mockResolvedValue({ status: 202, body: { operationId: account.id, status: 'running' } }),
    operation: vi.fn(),
  };
  const controller = new NotificationsController(
    inbox as unknown as NotificationInboxService,
    {} as PushSubscriptionsService,
  );
  const reply = { header: vi.fn().mockReturnThis(), code: vi.fn().mockReturnThis() };
  return { inbox, controller, reply: reply as unknown as FastifyReply, headers: reply };
}
describe('shared inbox public contract', () => {
  it('publishes additive MINOR operations, statuses and required retry header', () => {
    expect(spec.info.version).toBe('7.8.0-alpha.1');
    const read = spec.paths['/me/notifications/read-all'].post;
    expect(Object.keys(read.responses)).toEqual(
      expect.arrayContaining([
        '200',
        '202',
        '400',
        '401',
        '403',
        '409',
        '410',
        '422',
        '429',
        '503',
      ]),
    );
    expect(read.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', required: true }),
    );
    expect(spec.paths['/me/notifications/{id}/read'].post.responses['201']).toBeDefined();
    expect(spec.components.schemas.NotificationKind.type).toBe('string');
    expect(spec.components.schemas.NotificationKind.enum).toBeUndefined();
    expect(spec.paths['/me/notification-settings'].patch).toBeUndefined();
  });
  it('delegates summary with private/no-store, read-all with 202 and Location', async () => {
    const { controller, inbox, reply, headers } = fixture();
    await controller.summary(account, reply);
    expect(inbox.summary).toHaveBeenCalledWith(account.id);
    expect(headers.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    const req = {
      method: 'POST',
      url: '/v1/me/notifications/read-all',
      body: { through: 'token' },
    } as FastifyRequest;
    await controller.readAll(account, 'test-key-1234', { through: 'token' }, req, reply);
    expect(headers.code).toHaveBeenCalledWith(202);
    expect(headers.header).toHaveBeenCalledWith(
      'Location',
      `/v1/me/notifications/read-all/${account.id}`,
    );
    expect(inbox.readAll).toHaveBeenCalledWith(
      account.id,
      'token',
      expect.objectContaining({ actorScope: `user:${account.id}` }),
    );
  });
  it('rejects guests and missing/invalid Idempotency-Key before calling the application', async () => {
    const { controller, inbox, reply } = fixture();
    expect(() =>
      controller.summary({ type: 'guest', id: account.id, sessionId: 'guest-session' }, reply),
    ).toThrow(expect.objectContaining({ code: 'USER_ONLY' }));
    const req = { method: 'POST', url: '/v1/me/notifications/read-all' } as FastifyRequest;
    await expect(
      controller.readAll(account, undefined, { through: 'token' }, req, reply),
    ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY', httpStatus: 400 });
    expect(() => idempotencyScope(req, 'bad key')).toThrow(
      expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' }),
    );
    expect(inbox.readAll).not.toHaveBeenCalled();
  });
  it('keeps old list and single-read request and success shapes', async () => {
    const { controller, inbox } = fixture();
    await controller.list(account, '2026-11-08T00:00:00.000Z');
    expect(inbox.list).toHaveBeenCalledWith(account.id, '2026-11-08T00:00:00.000Z');
    expect(await controller.markRead(account, account.id)).toEqual({ read: true });
  });
});
