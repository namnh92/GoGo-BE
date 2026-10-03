import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOM_EVENT_BUS } from '../../../libs/modules/realtime/application/room-event-bus';
import { RoomEventsService } from '../../../libs/modules/realtime/application/room-events.service';
import { RedisRoomEventBus } from '../../../libs/modules/realtime/infrastructure/redis-room-event-bus';
import { RoomEventsController } from '../../../libs/modules/realtime/presentation/room-events.controller';
import { RoomMemberGuard } from '../../../libs/modules/realtime/presentation/room-member.guard';
import { REALTIME_ENABLED } from '../../../libs/modules/realtime/presentation/realtime.tokens';
import * as realtimeModule from '../../../libs/modules/realtime/presentation/realtime.module';
import { RoomPolicy } from '../../../libs/modules/rooms/presentation/room-policy';

/**
 * GoGo-BE#638 / ADR-0027 — reconnect over real HTTP SSE against a real Redis,
 * with the publisher on a *second, independently connected* bus (another api
 * instance). Uses only what the pre-ADR code also exposes (the controller, the
 * bus constructor, `publish`), so the same file runs against `develop` for the
 * FAIL-before evidence.
 *
 * The attach window is hit deterministically: the SSE instance's command
 * connection is wrapped, and the moment its attach read (the replay read)
 * returns, the other instance publishes — the mutation the client must see.
 */

/* Namespace access: absent on the pre-ADR code this file also runs against. */
const { ROOM_EVENTS_COMMANDS_OPTIONS, ROOM_EVENTS_SUBSCRIBER_OPTIONS } = realtimeModule as Partial<
  typeof realtimeModule
>;

let redis: StartedTestContainer;
let url: string;
let app: NestFastifyApplication;
let baseUrl: string;
let publisher: RedisRoomEventBus;
/** The SSE instance's subscriber connection — SA-F-03 kills it. */
let streamingSubscriber: IORedis;
const clients: IORedis[] = [];
/** Runs once, right after the SSE instance's next attach read resolves. */
let afterAttachRead: (() => Promise<void>) | null = null;

/** Recognizes the attach read of either bus generation: ZRANGEBYSCORE (pre-ADR) or the snapshot script. */
function isAttachRead(method: string, args: unknown[]): boolean {
  if (method === 'zrangebyscore') return true;
  // Snapshot script: sha/script, numKeys 2, 2 keys + 4 args (publish has 5 args).
  return (method === 'evalsha' || method === 'eval') && args.length === 8;
}

function hooked(client: IORedis): IORedis {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise) || !afterAttachRead) return result;
        if (!isAttachRead(String(prop), args)) return result;
        const hook = afterAttachRead;
        afterAttachRead = null;
        return result.then(async (reply) => {
          await hook();
          return reply;
        });
      };
    },
  });
}

function connect(options: Record<string, unknown> = {}): IORedis {
  const client = new IORedis(url, { maxRetriesPerRequest: 1, ...options });
  client.on('error', () => undefined);
  clients.push(client);
  return client;
}

type Frame = { type: string; id: string | null; data: Record<string, unknown> | null; at: number };

/** An open SSE stream whose frames accumulate as they arrive. */
async function open(roomId: string, lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/rooms/${roomId}/events`, {
    headers: {
      accept: 'text/event-stream',
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const frames: Frame[] = [];
  let ended = false;
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const lines = part.split('\n').filter(Boolean);
          if (lines.length === 0 || lines.every((l) => l.startsWith(':'))) continue;
          const type = /^event: (.*)$/m.exec(part)?.[1] ?? 'message';
          if (type === 'heartbeat') continue;
          const data = /^data: (.*)$/m.exec(part)?.[1];
          frames.push({
            type,
            id: /^id: (.*)$/m.exec(part)?.[1] ?? null,
            data: data ? (JSON.parse(data) as Record<string, unknown>) : null,
            at: Date.now(),
          });
        }
      }
    } catch {
      /* aborted */
    }
    ended = true;
  })();
  return {
    frames,
    get ended() {
      return ended;
    },
    async until(predicate: (frames: Frame[]) => boolean, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return predicate(frames);
    },
    close() {
      controller.abort();
    },
  };
}

const eventIdOf = (frame: Frame) => frame.data?.event_id as string | undefined;
const domain = (frames: Frame[]) => frames.filter((f) => f.type !== 'resync');
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deletes every key of the room, whatever the bus generation named it. */
async function resetRoom(roomId: string) {
  const admin = connect();
  const keys = await admin.keys(`*${roomId}*`);
  if (keys.length) await admin.del(...keys);
}

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  url = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  // The SSE instance runs with the production connection options (lazy
  // connect, no offline queue, no resend, no auto-resubscribe). On the
  // pre-ADR code these exports do not exist and the defaults apply.
  streamingSubscriber = connect(ROOM_EVENTS_SUBSCRIBER_OPTIONS);
  const streaming = new RedisRoomEventBus(
    hooked(connect(ROOM_EVENTS_COMMANDS_OPTIONS)) as never,
    streamingSubscriber as never,
  );
  publisher = new RedisRoomEventBus(connect() as never, connect() as never);

  @Module({
    controllers: [RoomEventsController],
    providers: [
      RoomEventsService,
      RoomMemberGuard,
      { provide: RoomPolicy, useValue: { requireMember: async () => ({}) } },
      { provide: ROOM_EVENT_BUS, useValue: streaming },
      { provide: REALTIME_ENABLED, useValue: true },
    ],
  })
  class StreamTestModule {}

  app = await NestFactory.create<NestFastifyApplication>(StreamTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('v1');
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (req, _reply, done) => {
    (req as unknown as { actor: unknown }).actor = {
      type: 'user',
      id: randomUUID(),
      sessionId: randomUUID(),
    };
    done();
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 180_000);

afterAll(async () => {
  await app?.close();
  for (const client of clients) client.disconnect();
  await redis?.stop();
});

describe('room event stream reconnect over Redis (GoGo-BE#638, ADR-0027)', () => {
  it('#638: a mutation during the reconnect attach arrives once, in order, under 8 s on the open stream', async () => {
    const roomId = randomUUID();
    const first = await open(roomId);
    await settle();
    const before = await publisher.publish({ roomId, type: 'participant.joined' });
    expect(await first.until((f) => domain(f).length >= 1, 5_000)).toBe(true);
    const cursor = domain(first.frames)[0]!.id!;
    expect(eventIdOf(domain(first.frames)[0]!)).toBe(before.event.event_id);
    first.close();
    await settle();

    let mutationAt = 0;
    let mutationId = '';
    afterAttachRead = async () => {
      mutationAt = Date.now();
      mutationId = (await publisher.publish({ roomId, type: 'room.status_changed' })).event
        .event_id;
    };
    const resumed = await open(roomId, cursor);
    const arrived = await resumed.until(
      (f) => mutationId !== '' && f.some((frame) => eventIdOf(frame) === mutationId),
      8_000,
    );
    expect(mutationAt).toBeGreaterThan(0);
    expect(arrived).toBe(true);
    const hit = resumed.frames.find((frame) => eventIdOf(frame) === mutationId)!;
    expect(hit.at - mutationAt).toBeLessThan(8_000);
    expect(resumed.ended).toBe(false);

    // A later mutation on the same, still-open stream follows it, once each.
    const later = await publisher.publish({ roomId, type: 'vote.changed' });
    expect(
      await resumed.until(
        (f) => f.some((frame) => eventIdOf(frame) === later.event.event_id),
        8_000,
      ),
    ).toBe(true);
    await settle(300);
    const ids = domain(resumed.frames).map(eventIdOf);
    expect(ids).toEqual([mutationId, later.event.event_id]);
    expect(resumed.frames.some((f) => f.type === 'resync')).toBe(false);
    resumed.close();
  });

  it('F-04: resume at old seq 2, room sequence reset, new seq 1 published during attach → resync, never silently filtered', async () => {
    const roomId = randomUUID();
    const first = await open(roomId);
    await settle();
    await publisher.publish({ roomId, type: 'participant.joined' });
    await publisher.publish({ roomId, type: 'participant.joined' });
    expect(await first.until((f) => domain(f).length >= 2, 5_000)).toBe(true);
    const cursor = domain(first.frames)[1]!.id!;
    first.close();
    await settle();

    let newId = '';
    afterAttachRead = async () => {
      await resetRoom(roomId);
      newId = (await publisher.publish({ roomId, type: 'room.status_changed' })).event.event_id;
    };
    const resumed = await open(roomId, cursor);
    const told = await resumed.until((f) => f.some((frame) => frame.type === 'resync'), 8_000);
    expect(told).toBe(true);
    // Nothing from the new sequence may be delivered ahead of the resync.
    expect(resumed.frames[0]!.type).toBe('resync');
    expect(newId).not.toBe('');
    resumed.close();
  });

  it('F-04 (counter already past the cursor): reset, three new events, resume at old seq 2 → resync first', async () => {
    const roomId = randomUUID();
    const first = await open(roomId);
    await settle();
    await publisher.publish({ roomId, type: 'participant.joined' });
    await publisher.publish({ roomId, type: 'participant.joined' });
    expect(await first.until((f) => domain(f).length >= 2, 5_000)).toBe(true);
    const cursor = domain(first.frames)[1]!.id!;
    first.close();
    await settle();

    await resetRoom(roomId);
    for (let i = 0; i < 3; i++) await publisher.publish({ roomId, type: 'vote.changed' });

    const resumed = await open(roomId, cursor);
    expect(await resumed.until((f) => f.length >= 1, 8_000)).toBe(true);
    expect(resumed.frames[0]!.type).toBe('resync');
    resumed.close();
  });

  it('SA-F-03: losing the subscriber connection ends the HTTP stream; a reopen with the last cursor loses nothing', async () => {
    const roomId = randomUUID();
    const first = await open(roomId);
    await settle();
    const seen = await publisher.publish({ roomId, type: 'participant.joined' });
    expect(await first.until((f) => domain(f).length >= 1, 5_000)).toBe(true);
    const cursor = domain(first.frames)[0]!.id!;
    expect(eventIdOf(domain(first.frames)[0]!)).toBe(seen.event.event_id);

    const admin = connect();
    const id = await streamingSubscriber.client('ID');
    await admin.client('KILL', 'ID', String(id));

    // Ended well inside one keep-alive interval (20 s) — never a connected
    // stream that keeps pinging while it receives nothing.
    const deadline = Date.now() + 5_000;
    while (!first.ended && Date.now() < deadline) await settle(20);
    expect(first.ended).toBe(true);

    // Published while the client has no stream: the reopen must replay it.
    const missed = await publisher.publish({ roomId, type: 'vote.changed' });
    const reopened = await open(roomId, cursor);
    expect(
      await reopened.until(
        (f) => f.some((frame) => eventIdOf(frame) === missed.event.event_id),
        8_000,
      ),
    ).toBe(true);
    await settle(300);
    expect(domain(reopened.frames).map(eventIdOf)).toEqual([missed.event.event_id]);
    expect(reopened.frames.some((f) => f.type === 'resync')).toBe(false);
    reopened.close();
  });
});
