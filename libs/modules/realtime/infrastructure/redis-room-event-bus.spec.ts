import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MetricsRegistry } from '@gogo/observability';
import { describe, expect, it, vi } from 'vitest';
import type { ResyncNotice, SubscriptionSink } from '../application/room-event-bus';
import type { PublishInput, SequencedRoomEvent } from '../domain/room-event';
import {
  AttachDeadlineError,
  RedisRoomEventBus,
  type RedisCommandsLike,
  type RedisSubscriberLike,
} from './redis-room-event-bus';

const GEN = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'room:{room-1}:v2:events';

/**
 * A command connection that understands the bus's two scripts by arity — the
 * real Lua runs in the Testcontainers suite; this proves the TypeScript around
 * it (telemetry, retry policy, NOSCRIPT fallback).
 */
function fakeCommands() {
  let seq = 0;
  const buffer: string[] = [];
  const calls: string[] = [];
  const known = new Set<string>();
  const run = (keysAndArgs: (string | number)[]) => {
    // publish: meta, buffer, candidate, json, size, ttl, channel (7)
    if (keysAndArgs.length === 7) {
      seq += 1;
      const message = `{"generation":"${GEN}","seq":${seq},"event":${keysAndArgs[3]}}`;
      buffer.push(message);
      return [GEN, String(seq)];
    }
    // snapshot: meta, buffer, candidate, generation, seq, limit (6)
    const after = Number(keysAndArgs[4]);
    const events = keysAndArgs[3] === GEN ? buffer.slice(after) : [];
    return [GEN, String(seq), events];
  };
  const commands: RedisCommandsLike & { calls: string[]; buffer: string[] } = {
    calls,
    buffer,
    async evalsha(sha, _numKeys, ...rest) {
      calls.push('evalsha');
      if (!known.has(sha)) throw new Error('NOSCRIPT No matching script.');
      return run(rest);
    },
    async eval(script, _numKeys, ...rest) {
      calls.push('eval');
      known.add(createHash('sha1').update(script).digest('hex'));
      return run(rest);
    },
  };
  return commands;
}

type Deferred = { resolve: () => void; reject: (e: Error) => void; promise: Promise<unknown> };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

/** A subscriber whose SUBSCRIBE/UNSUBSCRIBE ACKs the test releases by hand. */
function manualSubscriber() {
  const emitter = new EventEmitter();
  const log: string[] = [];
  const pending: { op: string; d: Deferred }[] = [];
  const subscriber: RedisSubscriberLike & {
    log: string[];
    pending: typeof pending;
    emit(event: string, ...args: unknown[]): boolean;
    deliver(message: SequencedRoomEvent): void;
    listeners(): number;
  } = {
    log,
    pending,
    subscribe(channel) {
      log.push(`subscribe ${channel}`);
      const d = deferred();
      pending.push({ op: 'subscribe', d });
      return d.promise;
    },
    unsubscribe(channel) {
      log.push(`unsubscribe ${channel}`);
      const d = deferred();
      pending.push({ op: 'unsubscribe', d });
      return d.promise;
    },
    on(event: string, handler: (...args: never[]) => void) {
      emitter.on(event, handler as (...args: unknown[]) => void);
      return subscriber;
    },
    emit: (event, ...args) => emitter.emit(event, ...args),
    deliver: (message) => emitter.emit('message', CHANNEL, JSON.stringify(message)),
    listeners: () => emitter.listenerCount('message'),
  };
  return subscriber;
}

/** A subscriber that ACKs immediately. */
function autoSubscriber() {
  const s = manualSubscriber();
  const original = { subscribe: s.subscribe, unsubscribe: s.unsubscribe };
  s.subscribe = (channel) => {
    const p = original.subscribe(channel);
    s.pending.shift()!.d.resolve();
    return p;
  };
  s.unsubscribe = (channel) => {
    const p = original.unsubscribe(channel);
    s.pending.shift()!.d.resolve();
    return p;
  };
  return s;
}

function sink() {
  const events: SequencedRoomEvent[] = [];
  const resyncs: ResyncNotice[] = [];
  const failures: Error[] = [];
  const value: SubscriptionSink = {
    event: (e) => events.push(e),
    resync: (n) => resyncs.push(n),
    fail: (e) => failures.push(e),
  };
  return { events, resyncs, failures, value };
}

const input: PublishInput = {
  roomId: 'room-1',
  type: 'room.status_changed',
  actorId: 'u1',
  payload: { status: 'matching' },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RedisRoomEventBus runtime telemetry (#414)', () => {
  it('publish is one ok call — one script, falling back from NOSCRIPT exactly once', async () => {
    const registry = new MetricsRegistry();
    const commands = fakeCommands();
    const bus = new RedisRoomEventBus(commands, autoSubscriber(), registry);
    const out = await bus.publish(input);
    expect(out.seq).toBe(1);
    expect(out.generation).toBe(GEN);
    expect(commands.calls).toEqual(['evalsha', 'eval']);
    await bus.publish(input);
    expect(commands.calls).toEqual(['evalsha', 'eval', 'evalsha']);
    expect(registry.render()).toContain(
      'provider_requests_total{operation="upstash.redis.room_events.publish",provider="upstash",service="upstash.redis",status="ok"} 2',
    );
    expect(registry.render()).not.toContain('room-1');
  });

  it('subscribe is one ok call covering the SUBSCRIBE and the snapshot', async () => {
    const registry = new MetricsRegistry();
    const commands = fakeCommands();
    const subscriber = autoSubscriber();
    const bus = new RedisRoomEventBus(commands, subscriber, registry);
    await bus.publish(input);
    const sub = await bus.subscribe(
      'room-1',
      { kind: 'cursor', cursor: { generation: GEN, seq: 0 } },
      sink().value,
    );
    expect(sub.replay).toHaveLength(1);
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`]);
    expect(registry.render()).toContain(
      'provider_requests_total{operation="upstash.redis.room_events.subscribe",provider="upstash",service="upstash.redis",status="ok"} 1',
    );
    sub.unsubscribe();
  });

  it('a failed publish is recorded as error, rethrown, and never retried', async () => {
    const registry = new MetricsRegistry();
    const commands = fakeCommands();
    let attempts = 0;
    commands.evalsha = () => {
      attempts += 1;
      return Promise.reject(new Error('READONLY'));
    };
    const bus = new RedisRoomEventBus(commands, autoSubscriber(), registry);
    await expect(bus.publish(input)).rejects.toThrow('READONLY');
    expect(attempts).toBe(1);
    expect(registry.render()).toContain('operation="upstash.redis.room_events.publish"');
    expect(registry.render()).toContain('status="error"} 1');
  });

  it('an ambiguous publish reply (script ran, reply lost) is not republished under a new id', async () => {
    const commands = fakeCommands();
    const realEval = commands.eval.bind(commands);
    commands.evalsha = async (_sha, numKeys, ...rest) => {
      commands.calls.push('evalsha');
      await realEval('x', numKeys, ...rest); // the script ran…
      throw new Error('Connection is closed.'); // …and the reply was lost
    };
    const bus = new RedisRoomEventBus(commands, autoSubscriber());
    await expect(bus.publish(input)).rejects.toThrow('Connection is closed.');
    expect(commands.calls.filter((c) => c === 'evalsha')).toHaveLength(1);
    expect(commands.buffer).toHaveLength(1);
  });
});

describe('RedisRoomEventBus channel lifecycle (ADR-0027 D5)', () => {
  it('concurrent attaches share one SUBSCRIBE and fail together; nothing leaks', async () => {
    const subscriber = manualSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber);
    const a = bus.subscribe('room-1', { kind: 'fresh' }, sink().value);
    const b = bus.subscribe('room-1', { kind: 'fresh' }, sink().value);
    await flush();
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`]);
    subscriber.pending.shift()!.d.reject(new Error('subscribe refused'));
    await expect(a).rejects.toThrow('subscribe refused');
    await expect(b).rejects.toThrow('subscribe refused');
    await flush();
    // The last rollback queued the UNSUBSCRIBE; its rejection is handled.
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`, `unsubscribe ${CHANNEL}`]);
    subscriber.pending.shift()!.d.reject(new Error('unsubscribe refused'));
    await flush();
    expect(bus.channelMembers().size).toBe(0);

    // A later attach subscribes afresh and works.
    const c = bus.subscribe('room-1', { kind: 'fresh' }, sink().value);
    await flush();
    subscriber.pending.shift()!.d.resolve();
    await expect(c).resolves.toBeTruthy();
    expect(bus.channelMembers().get(CHANNEL)).toBe(1);
  });

  it('a late ACK after the attach deadline leaves no member and no subscription behind', async () => {
    const subscriber = manualSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber, undefined, {
      attachDeadlineMs: 20,
    });
    const s = sink();
    await expect(bus.subscribe('room-1', { kind: 'fresh' }, s.value)).rejects.toBeInstanceOf(
      AttachDeadlineError,
    );
    expect(bus.channelMembers().get(CHANNEL) ?? 0).toBe(0);
    subscriber.pending.shift()!.d.resolve(); // the late ACK
    await flush();
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`, `unsubscribe ${CHANNEL}`]);
    subscriber.pending.shift()!.d.resolve();
    await flush();
    expect(bus.channelMembers().size).toBe(0);
    subscriber.deliver({ generation: GEN, seq: 1, event: { event_id: 'x' } as never });
    expect(s.events).toHaveLength(0);
  });

  it('last detach then new attach while UNSUBSCRIBE is in flight: SUBSCRIBE runs after it; the new stream hears', async () => {
    const subscriber = manualSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber);
    const first = bus.subscribe('room-1', { kind: 'fresh' }, sink().value);
    await flush();
    subscriber.pending.shift()!.d.resolve();
    (await first).unsubscribe(); // last detach
    await flush(); // UNSUBSCRIBE sent, not yet ACKed
    const s = sink();
    const second = bus.subscribe('room-1', { kind: 'fresh' }, s.value);
    await flush();
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`, `unsubscribe ${CHANNEL}`]);
    subscriber.pending.shift()!.d.resolve(); // the stale UNSUBSCRIBE ACK
    await flush();
    expect(subscriber.log).toEqual([
      `subscribe ${CHANNEL}`,
      `unsubscribe ${CHANNEL}`,
      `subscribe ${CHANNEL}`,
    ]);
    subscriber.pending.shift()!.d.resolve();
    const attached = await second;
    attached.activate();
    expect(bus.channelMembers().get(CHANNEL)).toBe(1);
    const published = await bus.publish(input);
    subscriber.deliver(published);
    expect(s.events.map((e) => e.seq)).toEqual([published.seq]);
  });

  it('last detach then immediate re-attach: the superseded UNSUBSCRIBE is skipped', async () => {
    const subscriber = manualSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber);
    const first = bus.subscribe('room-1', { kind: 'fresh' }, sink().value);
    await flush();
    subscriber.pending.shift()!.d.resolve();
    (await first).unsubscribe();
    const s = sink();
    const second = bus.subscribe('room-1', { kind: 'fresh' }, s.value);
    await flush();
    // SUBSCRIBE is idempotent server-side; an UNSUBSCRIBE here would deafen the new stream.
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`, `subscribe ${CHANNEL}`]);
    subscriber.pending.shift()!.d.resolve();
    (await second).activate();
    const published = await bus.publish(input);
    subscriber.deliver(published);
    expect(s.events.map((e) => e.seq)).toEqual([published.seq]);
  });

  it('subscriber disconnect terminates every stream and a stale release cannot unsubscribe the new connection', async () => {
    const subscriber = autoSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber);
    const s1 = sink();
    const s2 = sink();
    const a = await bus.subscribe('room-1', { kind: 'fresh' }, s1.value);
    const b = await bus.subscribe('room-1', { kind: 'fresh' }, s2.value);
    a.activate();
    b.activate();
    subscriber.emit('close');
    subscriber.emit('end');
    expect(s1.failures).toHaveLength(1);
    expect(s2.failures).toHaveLength(1);
    expect(bus.channelMembers().size).toBe(0);

    const s3 = sink();
    const c = await bus.subscribe('room-1', { kind: 'fresh' }, s3.value);
    c.activate();
    a.unsubscribe(); // stale releases from the dead connection
    b.unsubscribe();
    await flush();
    expect(subscriber.log.filter((l) => l.startsWith('unsubscribe'))).toHaveLength(0);
    expect(bus.channelMembers().get(CHANNEL)).toBe(1);
  });

  it('a disconnect during attach fails the stream instead of returning a deaf one', async () => {
    const subscriber = manualSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber);
    const s = sink();
    const pending = bus.subscribe('room-1', { kind: 'fresh' }, s.value);
    await flush();
    subscriber.emit('close');
    expect(s.failures).toHaveLength(1);
    subscriber.pending.shift()!.d.resolve(); // late ACK from the dead connection
    await expect(pending).rejects.toThrow();
    expect(bus.channelMembers().size).toBe(0);
  });

  it('keeps one message listener however many streams attach', async () => {
    const subscriber = autoSubscriber();
    const bus = new RedisRoomEventBus(fakeCommands(), subscriber);
    const subs = await Promise.all(
      Array.from({ length: 20 }, () => bus.subscribe('room-1', { kind: 'fresh' }, sink().value)),
    );
    expect(subscriber.listeners()).toBe(1);
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`]);
    for (const sub of subs) sub.unsubscribe();
    await flush();
    expect(subscriber.log).toEqual([`subscribe ${CHANNEL}`, `unsubscribe ${CHANNEL}`]);
  });

  it('no unhandled rejection when everything fails at once', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const subscriber = manualSubscriber();
      const bus = new RedisRoomEventBus(fakeCommands(), subscriber, undefined, {
        attachDeadlineMs: 10,
      });
      const attempts = Array.from({ length: 5 }, () =>
        bus.subscribe('room-1', { kind: 'fresh' }, sink().value).catch((e: Error) => e),
      );
      await Promise.all(attempts);
      for (const p of subscriber.pending.splice(0)) p.d.reject(new Error('late failure'));
      await flush();
      for (const p of subscriber.pending.splice(0)) p.d.reject(new Error('unsubscribe failure'));
      await flush();
      await new Promise((r) => setTimeout(r, 20));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
