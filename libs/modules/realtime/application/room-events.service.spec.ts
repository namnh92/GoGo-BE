import { PassThrough } from 'node:stream';
import { SseStream } from '@nestjs/core/router/sse-stream';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../identity/domain/actor';
import type { RoomPolicy } from '../../rooms/presentation/room-policy';
import { InMemoryRoomEventBus } from '../infrastructure/in-memory-room-event-bus';
import {
  domainFrame,
  MAX_STREAMS_PER_ACTOR,
  resyncFrame,
  RoomEventsService,
  type SseMessage,
} from './room-events.service';

const GEN = '0f8b2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

/** Writes messages through the framework's real SSE serializer. */
async function wire(messages: SseMessage[]): Promise<string> {
  const stream = new SseStream();
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  stream.pipe(out);
  for (const message of messages) {
    await new Promise<void>((resolve) => stream.writeMessage(message as never, () => resolve()));
  }
  await new Promise((resolve) => setImmediate(resolve));
  return text;
}

const event = {
  generation: GEN,
  seq: 3,
  event: {
    event_id: '9b2f7a1c-0000-4000-8000-000000000001',
    event_type: 'vote.changed' as const,
    event_version: 1,
    occurred_at: '2026-10-03T00:00:00.000Z',
    actor_id: null,
    resource_type: 'room',
    resource_id: 'r',
    correlation_id: null,
    payload_schema_version: 1,
    payload: {},
  },
};

describe('SSE frames (ADR-0027, real NestJS SseStream)', () => {
  it('a domain event carries the opaque cursor as its id', async () => {
    const text = await wire([domainFrame(event)]);
    expect(text).toContain(`id: v2:${GEN}:3\n`);
    expect(text).toContain('event: vote.changed\n');
  });

  it('frames other than domain events carry no SSE id at all — never the framework counter', async () => {
    const text = await wire([
      resyncFrame('room-1', {
        reason: 'invalid_or_legacy_cursor',
        checkpoint: { generation: GEN, seq: 5 },
      }),
      { comment: 'ping' },
      resyncFrame('room-1', {
        reason: 'replay_unavailable',
        checkpoint: { generation: GEN, seq: 6 },
      }),
    ]);
    const frames = text.split('\n\n').filter((f) => f.trim());
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame).not.toMatch(/^id:/m);
    expect(frames[1]!.trim()).toBe(': ping');
    const data = JSON.parse(/^data: (.*)$/m.exec(frames[0]!)![1]!);
    expect(data).toEqual({
      roomId: 'room-1',
      reason: 'invalid_or_legacy_cursor',
      checkpoint: { cursor: `v2:${GEN}:5`, generation: GEN, seq: 5 },
    });
    expect(frames[0]).toMatch(/^event: resync$/m);
  });
});

describe('stream ceiling (GoGo-BE#683)', () => {
  const policy = { requireMember: async () => undefined } as unknown as RoomPolicy;
  const actor = (id: string, type: Actor['type'] = 'user'): Actor => ({
    type,
    id,
    sessionId: `s-${id}`,
  });

  function setup() {
    const metrics = { increment: vi.fn(), observe: vi.fn(), time: vi.fn() };
    const service = new RoomEventsService(policy, new InMemoryRoomEventBus(), metrics);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return { service, metrics, warn };
  }

  afterEach(() => vi.restoreAllMocks());

  it('counts and logs a refusal at the cap, with no actor id in the log', async () => {
    const { service, metrics, warn } = setup();
    const a = actor('actor-secret-id', 'guest');
    for (let i = 0; i < MAX_STREAMS_PER_ACTOR; i++) await service.stream(a, 'room-1', null);

    await expect(service.stream(a, 'room-1', null)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith('realtime_stream_refusals_total', {
      reason: 'actor_cap',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // One argument: the pino bridge drops a string passed after an object.
    expect(warn.mock.calls[0]).toHaveLength(1);
    const [fields] = warn.mock.calls[0]!;
    expect(fields).toEqual({
      msg: 'room event stream refused: actor stream cap',
      event: 'realtime.stream_refused',
      reason: 'actor_cap',
      actor_kind: 'guest',
      open_streams: MAX_STREAMS_PER_ACTOR,
      room_id: 'room-1',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('actor-secret-id');
  });

  it('records nothing below the cap, or for another actor', async () => {
    const { service, metrics, warn } = setup();
    for (let i = 0; i < MAX_STREAMS_PER_ACTOR; i++)
      await service.stream(actor('a'), 'room-1', null);
    await service.stream(actor('b'), 'room-1', null);

    expect(metrics.increment).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('stream slots (GoGo-BE#685)', () => {
  const actor: Actor = { type: 'user', id: 'a', sessionId: 's-a' };

  function service(
    policy: { requireMember: () => Promise<unknown> } = { requireMember: async () => undefined },
  ) {
    return new RoomEventsService(policy as unknown as RoomPolicy, new InMemoryRoomEventBus());
  }

  afterEach(() => vi.restoreAllMocks());

  it('refuses over the cap before any await, so the rejection beats the SSE headers', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let membershipChecks = 0;
    const svc = service({
      requireMember: async () => {
        membershipChecks += 1;
      },
    });
    for (let i = 0; i < MAX_STREAMS_PER_ACTOR; i++) await svc.stream(actor, 'room-1', null);
    membershipChecks = 0;

    await expect(svc.stream(actor, 'room-1', null)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // The refusal did not wait on the database round trip.
    expect(membershipChecks).toBe(0);
  });

  it('gives the slot back when the membership re-check fails', async () => {
    let member = false;
    const svc = service({
      requireMember: async () => {
        if (!member) throw new Error('NOT_A_MEMBER');
      },
    });
    for (let i = 0; i < MAX_STREAMS_PER_ACTOR; i++) {
      await expect(svc.stream(actor, 'room-1', null)).rejects.toThrow('NOT_A_MEMBER');
    }
    member = true;
    // Five refusals must not have spent the five slots.
    await expect(svc.stream(actor, 'room-1', null)).resolves.toBeDefined();
  });

  it('gives the slot back when the client leaves before the stream is subscribed', async () => {
    const svc = service();
    const leaving: AbortController[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_ACTOR; i++) {
      const controller = new AbortController();
      leaving.push(controller);
      // Resolved but never subscribed: Nest skips subscribing when the socket
      // closed while the handler was resolving.
      await svc.stream(actor, 'room-1', null, controller.signal);
    }
    for (const controller of leaving) controller.abort();

    await expect(svc.stream(actor, 'room-1', null)).resolves.toBeDefined();
  });

  it('releases a slot once, however many terminal paths fire', async () => {
    const svc = service();
    const controller = new AbortController();
    const stream = await svc.stream(actor, 'room-1', null, controller.signal);
    const sub = stream.subscribe();
    sub.unsubscribe();
    controller.abort();
    // One slot freed, not two: the other four plus one more fill the cap exactly.
    for (let i = 0; i < MAX_STREAMS_PER_ACTOR; i++) await svc.stream(actor, 'room-1', null);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(svc.stream(actor, 'room-1', null)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
