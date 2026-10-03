import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPLAY_BUFFER_SIZE,
  type ResyncNotice,
  type Subscription,
  type SubscriptionSink,
} from '../../../libs/modules/realtime/application/room-event-bus';
import type { ResumePoint } from '../../../libs/modules/realtime/domain/room-event-cursor';
import type { SequencedRoomEvent } from '../../../libs/modules/realtime/domain/room-event';
import { RedisRoomEventBus } from '../../../libs/modules/realtime/infrastructure/redis-room-event-bus';
import { runRoomEventGenerationRotation } from '../../../libs/modules/realtime/infrastructure/rotate-room-event-generations';
import {
  ROOM_EVENTS_COMMANDS_OPTIONS,
  ROOM_EVENTS_SUBSCRIBER_OPTIONS,
} from '../../../libs/modules/realtime/presentation/realtime.module';

/**
 * ADR-0027 D6 — the bus against a real Redis: the Lua scripts, two
 * independently connected bus instances (two api instances), socket ordering
 * and connection loss. Nothing here touches the DEV stack.
 */

let redis: StartedTestContainer;
let url: string;
/** Raw access for assertions and fault injection; not a bus connection. */
let admin: IORedis;
const clients: IORedis[] = [];

function connect(options: Record<string, unknown> = {}): IORedis {
  const client = new IORedis(url, { maxRetriesPerRequest: 1, ...options });
  client.on('error', () => undefined);
  clients.push(client);
  return client;
}

/** A bus instance with its own two connections, as the module wires it. */
function instance(
  hooks: {
    beforeSnapshot?: (() => Promise<void>) | undefined;
    afterSubscribe?: (() => Promise<void>) | undefined;
  } = {},
) {
  // Exactly the production options: lazy connect, no offline queue, no
  // resend, no auto-resubscribe (the bus connects the commands client itself).
  const commands = connect(ROOM_EVENTS_COMMANDS_OPTIONS);
  const subscriber = connect(ROOM_EVENTS_SUBSCRIBER_OPTIONS);
  const wrappedCommands = new Proxy(commands, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const isSnapshot = (prop === 'evalsha' || prop === 'eval') && args.length === 8;
        if (isSnapshot && hooks.beforeSnapshot) {
          const hook = hooks.beforeSnapshot;
          hooks.beforeSnapshot = undefined;
          await hook();
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const wrappedSubscriber = new Proxy(subscriber, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop !== 'subscribe') return value.bind(target);
      return async (...args: unknown[]) => {
        const out = await (value as (...a: unknown[]) => unknown).apply(target, args);
        if (hooks.afterSubscribe) {
          const hook = hooks.afterSubscribe;
          hooks.afterSubscribe = undefined;
          await hook();
        }
        return out;
      };
    },
  });
  const bus = new RedisRoomEventBus(wrappedCommands as never, wrappedSubscriber as never);
  return { bus, commands, subscriber };
}

function sink() {
  const events: SequencedRoomEvent[] = [];
  const resyncs: ResyncNotice[] = [];
  const failures: Error[] = [];
  const order: string[] = [];
  const value: SubscriptionSink = {
    event: (e) => {
      events.push(e);
      order.push(`e${e.seq}`);
    },
    resync: (n) => {
      resyncs.push(n);
      order.push(`resync:${n.reason}`);
    },
    fail: (e) => failures.push(e),
  };
  return { events, resyncs, failures, order, value };
}

/** What the SSE service does: resync, replay, then activate. */
function emit(subscription: Subscription, s: ReturnType<typeof sink>) {
  if (subscription.resync) s.value.resync(subscription.resync);
  for (const e of subscription.replay) s.value.event(e);
  subscription.activate();
}

const until = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return predicate();
};
const at = (generation: string, seq: number): ResumePoint => ({
  kind: 'cursor',
  cursor: { generation, seq },
});
const meta = (roomId: string) => `room:{${roomId}}:v2:meta`;
const buffer = (roomId: string) => `room:{${roomId}}:v2:buffer`;

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  url = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  admin = connect();
}, 180_000);

afterAll(async () => {
  for (const client of clients) client.disconnect();
  await redis?.stop();
});

describe('RedisRoomEventBus on real Redis (ADR-0027)', () => {
  it('two real publishers race: every subscriber and the replay see one strictly increasing, duplicate-free sequence', async () => {
    const roomId = randomUUID();
    const a = instance();
    const b = instance();
    const listeners = [sink(), sink()];
    const subs = [
      await a.bus.subscribe(roomId, { kind: 'fresh' }, listeners[0]!.value),
      await b.bus.subscribe(roomId, { kind: 'fresh' }, listeners[1]!.value),
    ];
    subs.forEach((s, i) => emit(s, listeners[i]!));
    const generation = (await admin.hget(meta(roomId), 'generation'))!;

    const rounds = 10;
    const perRound = 20;
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        Array.from({ length: perRound }, (_, i) =>
          (i % 2 ? a : b).bus.publish({ roomId, type: 'vote.changed', payload: { round, i } }),
        ),
      );
    }
    const total = rounds * perRound;
    for (const l of listeners) {
      expect(await until(() => l.events.length === total)).toBe(true);
      expect(l.events.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(new Set(l.events.map((e) => e.event.event_id)).size).toBe(total);
      expect(l.resyncs).toEqual([]);
    }
    // The buffer's order is the publication order every listener saw.
    const replaySink = sink();
    const replay = await b.bus.subscribe(
      roomId,
      at(generation, total - REPLAY_BUFFER_SIZE),
      replaySink.value,
    );
    expect(replay.replay.map((e) => e.event.event_id)).toEqual(
      listeners[0]!.events.slice(-REPLAY_BUFFER_SIZE).map((e) => e.event.event_id),
    );
    replay.unsubscribe();
    subs.forEach((s) => s.unsubscribe());
  });

  it('publish at every attach boundary: replay precedes live, each event delivered once', async () => {
    const roomId = randomUUID();
    const pub = instance();
    const first = await pub.bus.publish({ roomId, type: 'vote.changed' });
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    const published: string[] = [];
    const remember = async () => {
      published.push((await pub.bus.publish({ roomId, type: 'vote.changed' })).event.event_id);
    };
    const reader = instance({ afterSubscribe: remember, beforeSnapshot: remember });
    const s = sink();
    await remember(); // before SUBSCRIBE: replay only
    const subscription = await reader.bus.subscribe(roomId, at(first.generation, 1), s.value);
    await remember(); // after the snapshot, before activate: live, queued
    emit(subscription, s);
    await remember(); // after activate
    expect(await until(() => s.events.length === 6)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.events.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(new Set(s.events.map((e) => e.event.event_id)).size).toBe(6);
    expect(s.resyncs).toEqual([]);
    subscription.unsubscribe();
  });

  it('a replayed event re-delivered beyond 30 s is not re-emitted; memory stays bounded', async () => {
    const roomId = randomUUID();
    const pub = instance();
    const first = await pub.bus.publish({ roomId, type: 'vote.changed' });
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    const reader = instance();
    const s = sink();
    const subscription = await reader.bus.subscribe(roomId, at(first.generation, 1), s.value);
    emit(subscription, s);
    const raw = await admin.zrange(buffer(roomId), '0', '-1');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      for (const message of raw) await admin.publish(`room:{${roomId}}:v2:events`, message);
      Date.now = () => realNow() + 3_600_000;
      for (const message of raw) await admin.publish(`room:{${roomId}}:v2:events`, message);
    } finally {
      Date.now = realNow;
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(s.events.map((e) => e.seq)).toEqual([2, 3]);
    subscription.unsubscribe();
  });

  it('resume decisions on real keys: trim, expiry, empty-buffer gap, ahead, missing metadata, malformed, legacy', async () => {
    const roomId = randomUUID();
    const pub = instance();
    const reader = instance();
    let last!: SequencedRoomEvent;
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 5; i++)
      last = await pub.bus.publish({ roomId, type: 'vote.changed' });
    const { generation } = last;
    expect(await admin.zcard(buffer(roomId))).toBe(REPLAY_BUFFER_SIZE);
    expect(await admin.ttl(meta(roomId))).toBe(-1); // metadata never expires
    expect(await admin.ttl(buffer(roomId))).toBeGreaterThan(0);

    const decide = async (resume: ResumePoint) => {
      const s = await reader.bus.subscribe(roomId, resume, sink().value);
      s.unsubscribe();
      return s;
    };
    const high = REPLAY_BUFFER_SIZE + 5;
    // Trim boundary: oldest retained is 6, so cursor 5 is exactly covered, 4 is not.
    expect((await decide(at(generation, 5))).replay).toHaveLength(REPLAY_BUFFER_SIZE);
    expect((await decide(at(generation, 4))).resync?.reason).toBe('replay_unavailable');
    expect((await decide(at(generation, high))).replay).toEqual([]);
    expect((await decide(at(generation, high + 1))).resync?.reason).toBe(
      'invalid_or_legacy_cursor',
    );
    expect((await decide({ kind: 'invalid' })).resync).toEqual({
      reason: 'invalid_or_legacy_cursor',
      checkpoint: { generation, seq: high },
    });

    // Buffer-only expiry: metadata survives, so H > cursor with an empty buffer is a gap.
    await admin.del(buffer(roomId));
    expect((await decide(at(generation, high - 1))).resync?.reason).toBe('replay_unavailable');
    expect((await decide(at(generation, high))).resync).toBeNull();

    // Missing metadata: a fresh generation, the orphaned buffer discarded.
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    await admin.del(meta(roomId));
    const reset = await decide(at(generation, high + 1));
    expect(reset.resync?.reason).toBe('generation_changed');
    expect(reset.resync?.checkpoint.seq).toBe(0);
    expect(reset.resync?.checkpoint.generation).not.toBe(generation);
    expect(await admin.zcard(buffer(roomId))).toBe(0);
    const next = await pub.bus.publish({ roomId, type: 'vote.changed' });
    expect(next.seq).toBe(1);
    expect(next.generation).toBe(reset.resync?.checkpoint.generation);
  });

  it('F-04 on real Redis: metadata deleted and new seq 1 published during attach → resync, never filtered', async () => {
    for (const newEvents of [1, 3]) {
      const roomId = randomUUID();
      const pub = instance();
      await pub.bus.publish({ roomId, type: 'vote.changed' });
      const two = await pub.bus.publish({ roomId, type: 'vote.changed' });
      const reader = instance({
        afterSubscribe: async () => {
          await admin.del(meta(roomId), buffer(roomId));
          for (let i = 0; i < newEvents; i++)
            await pub.bus.publish({ roomId, type: 'vote.changed' });
        },
      });
      const s = sink();
      const subscription = await reader.bus.subscribe(roomId, at(two.generation, 2), s.value);
      emit(subscription, s);
      await new Promise((r) => setTimeout(r, 150));
      expect(s.order[0]).toBe('resync:generation_changed');
      expect(s.events).toEqual([]); // all covered by the checkpoint the refetch restores
      const after = await pub.bus.publish({ roomId, type: 'vote.changed' });
      expect(await until(() => s.events.length === 1)).toBe(true);
      expect(s.events[0]!.seq).toBe(newEvents + 1);
      expect(s.events[0]!.event.event_id).toBe(after.event.event_id);
      subscription.unsubscribe();
    }
  });

  it('a reset while a stream is live is reported as generation_changed before the new events', async () => {
    const roomId = randomUUID();
    const pub = instance();
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    const reader = instance();
    const s = sink();
    emit(await reader.bus.subscribe(roomId, { kind: 'fresh' }, s.value), s);
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    await admin.del(meta(roomId));
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    expect(await until(() => s.order.length >= 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(s.order[0]).toBe('e2');
    expect(s.order[1]).toBe('resync:generation_changed');
    // Whatever follows is the new generation, contiguous after the checkpoint.
    const checkpoint = s.resyncs[0]!.checkpoint.seq;
    expect(s.events.slice(1).map((e) => e.seq)).toEqual(
      Array.from({ length: 2 - checkpoint }, (_, i) => checkpoint + 1 + i),
    );
  });

  it('restore runbook: rotation after a rolled-back seq answers old cursors with generation_changed', async () => {
    const roomId = randomUUID();
    const other = randomUUID();
    const pub = instance();
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    const three = await pub.bus.publish({ roomId, type: 'vote.changed' });
    await pub.bus.publish({ roomId: other, type: 'vote.changed' });
    // A restore/failover rolls the counter back: seq 3 will be handed out again.
    await admin.hset(meta(roomId), 'seq', '1');
    const live = sink();
    const reader = instance();
    emit(await reader.bus.subscribe(roomId, { kind: 'fresh' }, live.value), live);

    const dry = await runRoomEventGenerationRotation({ url, execute: false });
    expect(dry.matched).toBeGreaterThanOrEqual(2);
    expect(dry.deleted).toBe(0);
    expect(await admin.exists(meta(roomId))).toBe(1);

    const rotated = await runRoomEventGenerationRotation({ url, execute: true, roomId });
    expect(rotated).toMatchObject({ matched: 1, deleted: 1 });
    expect(await admin.exists(meta(other))).toBe(1); // scoped to the one room

    const resumed = await reader.bus.subscribe(roomId, at(three.generation, 3), sink().value);
    expect(resumed.resync?.reason).toBe('generation_changed');
    resumed.unsubscribe();
    // A stream that stayed open learns it from the next event.
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    expect(await until(() => live.resyncs.length === 1)).toBe(true);
    expect(live.resyncs[0]!.reason).toBe('generation_changed');
  });

  it('rejects keys of the wrong type instead of corrupting them', async () => {
    const roomId = randomUUID();
    const pub = instance();
    await admin.set(meta(roomId), 'not-a-hash');
    await expect(pub.bus.publish({ roomId, type: 'vote.changed' })).rejects.toThrow(
      /ROOM_EVENTS_BAD_KEY_TYPE/,
    );
  });

  it('losing the subscriber connection terminates the stream; a new attach works', async () => {
    const roomId = randomUUID();
    const pub = instance();
    const reader = instance();
    const s = sink();
    emit(await reader.bus.subscribe(roomId, { kind: 'fresh' }, s.value), s);
    const id = await reader.subscriber.client('ID');
    await admin.client('KILL', 'ID', String(id));
    expect(await until(() => s.failures.length === 1)).toBe(true);
    // Ended, not deaf-and-heartbeating: nothing more reaches the failed sink.
    await pub.bus.publish({ roomId, type: 'vote.changed' });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.events).toEqual([]);

    await until(() => reader.subscriber.status === 'ready');
    const again = sink();
    emit(await reader.bus.subscribe(roomId, { kind: 'fresh' }, again.value), again);
    const published = await pub.bus.publish({ roomId, type: 'vote.changed' });
    expect(await until(() => again.events.length === 1)).toBe(true);
    expect(again.events[0]!.event.event_id).toBe(published.event.event_id);
  });
});
