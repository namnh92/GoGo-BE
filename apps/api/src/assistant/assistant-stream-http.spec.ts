import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AssistantController,
  AssistantConversationsService,
  AssistantProposalsService,
  AssistantStreamService,
  InMemoryFrameBuffer,
  type MessageRow,
} from '@gogo/modules';
import { AppExceptionFilter } from '../common/filters/app-exception.filter';

const conversationId = '10000000-0000-4000-8000-000000000001';
const messageId = '10000000-0000-4000-8000-000000000002';
const url = `/assistant/conversations/${conversationId}/messages/${messageId}/stream`;
const actor = { type: 'user' as const, id: 'alice', sessionId: 's' };
const row = {
  id: messageId,
  conversation_id: conversationId,
  user_id: actor.id,
  role: 'assistant',
  status: 'streaming',
  locale: 'en',
  text: '',
  frames: null,
  created_at: new Date().toISOString(),
} as MessageRow;
let deleted = false;
const buffer = new InMemoryFrameBuffer();
const read = vi.spyOn(buffer, 'read');
// A real asynchronous lookup, slower than Nest's SSE header timer.
const repo = {
  db: {},
  findMessage: vi.fn(async (userId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return !deleted && userId === actor.id ? row : null;
  }),
  findConversation: async (userId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return !deleted && userId === actor.id ? { id: conversationId } : null;
  },
};
const conversations = new AssistantConversationsService(
  {} as never,
  repo as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  buffer,
  'test',
  undefined,
  {} as never,
);
const streams = new AssistantStreamService(
  repo as never,
  { hydrate: async () => [] } as never,
  buffer,
);
@Module({
  controllers: [AssistantController],
  providers: [
    { provide: AssistantConversationsService, useValue: conversations },
    { provide: AssistantProposalsService, useValue: {} },
    { provide: AssistantStreamService, useValue: streams },
  ],
})
class TestModule {}

let app: NestFastifyApplication;
async function request(url: string, options: { headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: 'GET', url, headers: options.headers ?? {} });
  return {
    status: res.statusCode,
    headers: new Headers(res.headers as Record<string, string>),
    json: async () => res.json(),
    text: async () => res.body,
  };
}
beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new AppExceptionFilter());
  // Production has a global idempotency interceptor, including on GET.
  app.useGlobalInterceptors({ intercept: (_ctx, next) => next.handle() });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (req) => {
      // Injection has no TCP socket; SSE only uses these for transport tuning.
      const socket = req.raw.socket;
      socket.setKeepAlive ??= () => socket;
      socket.setNoDelay ??= () => socket;
      socket.setTimeout ??= () => socket;
      (req as typeof req & { actor: typeof actor }).actor = {
        ...actor,
        id: String(req.headers['x-test-user'] ?? actor.id),
      };
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await buffer.append(
    messageId,
    [
      { type: 'delta', seq: 1, messageId, text: 'private answer' },
      { type: 'done', seq: 2, messageId, status: 'complete' },
    ],
    Date.now() + 60_000,
  );
});
afterAll(async () => {
  await app?.close();
});

describe('assistant stream HTTP admission before SSE headers', () => {
  it.each([undefined, '1'])(
    'returns the history 404 envelope after deletion (resume=%s), even with retained frames',
    async (lastEventId) => {
      deleted = true;
      read.mockClear();
      const history = await request(`/assistant/conversations/${conversationId}/messages`);
      const response = await request(url, {
        headers: lastEventId ? { 'last-event-id': lastEventId } : {},
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      const { request_id: _historyId, ...expected } = await history.json();
      const { request_id, ...body } = await response.json();
      expect(history.status).toBe(404);
      expect(body).toEqual(expected);
      expect(body.code).toBe('NOT_FOUND');
      expect(request_id).toEqual(expect.any(String));
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('gives another user the same 404 for a live conversation without reading its buffer', async () => {
    deleted = false;
    read.mockClear();
    const response = await request(`${url}?lastEventId=1`, {
      headers: { 'x-test-user': 'bob' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found',
      retryable: false,
    });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([undefined, '1'])(
    'keeps live buffered streams and resume working (resume=%s)',
    async (lastEventId) => {
      deleted = false;
      const response = await request(url, {
        headers: lastEventId ? { 'last-event-id': lastEventId } : {},
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('event: done');
      expect(text.includes('private answer')).toBe(!lastEventId);
    },
  );
});
