import { describe, expect, it } from 'vitest';
import type { PublishInput, SequencedRoomEvent } from '../domain/room-event';
import { RedisRoomEventBus, type RedisPubSubLike } from './redis-room-event-bus';

/**
 * #638 — a reconnecting stream must not lose the events published while it is
 * being attached. A tiny Redis model: one sorted set per key, and PUBLISH
 * reaching only connections whose SUBSCRIBE has been acknowledged, which is
 * how Redis behaves.
 */
type Handler = (channel: string, message: string) => void;

class FakeRedisServer {
  readonly counters = new Map<string, number>();
  readonly zsets = new Map<string, { score: number; member: string }[]>();
  readonly subscribed = new Map<FakeConnection, Set<string>>();

  deliver(channel: string, message: string): number {
    let receivers = 0;
    for (const [conn, channels] of this.subscribed) {
      if (!channels.has(channel)) continue;
      receivers += 1;
      // Pub/sub messages arrive as socket I/O, never inside the publisher's call.
      setImmediate(() => conn.emit(channel, message));
    }
    return receivers;
  }
}

class FakeConnection implements RedisPubSubLike {
  private readonly handlers = new Set<Handler>();
  /** Runs once, after the next command of the given name resolves. */
  readonly after = new Map<string, () => Promise<void>>();
  failNextSubscribe = false;
  subscribeCalls = 0;

  constructor(private readonly server: FakeRedisServer) {}

  private async done<T>(name: string, value: T): Promise<T> {
    const hook = this.after.get(name);
    if (hook) {
      this.after.delete(name);
      await hook();
    }
    return value;
  }

  emit(channel: string, message: string) {
    for (const handler of this.handlers) handler(channel, message);
  }

  async incr(key: string) {
    const next = (this.server.counters.get(key) ?? 0) + 1;
    this.server.counters.set(key, next);
    return this.done('incr', next);
  }
  async publish(channel: string, message: string) {
    return this.done('publish', this.server.deliver(channel, message));
  }
  async zadd(key: string, score: number, member: string) {
    const set = this.server.zsets.get(key) ?? [];
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score);
    this.server.zsets.set(key, set);
    return this.done('zadd', 1);
  }
  async zremrangebyrank() {
    return this.done('zremrangebyrank', 0);
  }
  async zrangebyscore(key: string, min: number | string) {
    const floor = Number(min);
    const members = (this.server.zsets.get(key) ?? [])
      .filter((item) => item.score >= floor)
      .map((item) => item.member);
    return this.done('zrangebyscore', members);
  }
  async expire() {
    return this.done('expire', 1);
  }
  async subscribe(channel: string) {
    this.subscribeCalls += 1;
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false;
      throw new Error('Reached the max retries per request limit');
    }
    const channels = this.server.subscribed.get(this) ?? new Set<string>();
    channels.add(channel);
    this.server.subscribed.set(this, channels);
    return this.done('subscribe', 1);
  }
  async unsubscribe(channel: string) {
    this.server.subscribed.get(this)?.delete(channel);
    return 1;
  }
  on(_event: 'message', handler: Handler) {
    this.handlers.add(handler);
  }
  off(_event: 'message', handler: Handler) {
    this.handlers.delete(handler);
  }
}

const ROOM = 'room-638';
const change = (n: number): PublishInput => ({
  roomId: ROOM,
  type: 'participant.selection_changed',
  actorId: 'host',
  payload: { n },
});

/** Two api instances on one Redis: the receiver's and the sender's. */
function cluster() {
  const server = new FakeRedisServer();
  const receiverCommands = new FakeConnection(server);
  const receiverSubscriber = new FakeConnection(server);
  const receiver = new RedisRoomEventBus(receiverCommands, receiverSubscriber);
  const sender = new RedisRoomEventBus(new FakeConnection(server), new FakeConnection(server));
  return { receiver, receiverCommands, receiverSubscriber, sender };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** What a stream would emit: replay first, then live, as the service does. */
async function attach(bus: RedisRoomEventBus, afterSeq: number | null) {
  const live: SequencedRoomEvent[] = [];
  const sub = await bus.subscribe(ROOM, afterSeq, (event) => live.push(event));
  return { sub, seen: () => [...sub.replay, ...live].map((event) => event.seq) };
}

describe('RedisRoomEventBus reconnect (#638)', () => {
  it('delivers an event published while the reconnecting stream is being attached', async () => {
    const { receiver, receiverCommands, receiverSubscriber, sender } = cluster();
    await sender.publish(change(1)); // the client saw seq 1 before it dropped

    // Another instance publishes seq 2 in the middle of the attach: right after
    // whichever of the replay read or the SUBSCRIBE the bus performs first.
    let fired = false;
    const concurrent = async () => {
      if (fired) return;
      fired = true;
      await sender.publish(change(2));
    };
    receiverCommands.after.set('zrangebyscore', concurrent);
    receiverSubscriber.after.set('subscribe', concurrent);

    const stream = await attach(receiver, 1);
    await settle();

    expect(fired).toBe(true);
    expect(stream.sub.resync).toBe(false);
    expect(stream.seen()).toEqual([2]);

    // And the stream is live afterwards, with no duplicate of seq 2.
    await sender.publish(change(3));
    await settle();
    expect(stream.seen()).toEqual([2, 3]);
    stream.sub.unsubscribe();
  });

  it('a failed SUBSCRIBE does not leave the next stream on that room deaf', async () => {
    const { receiver, receiverSubscriber, sender } = cluster();
    receiverSubscriber.failNextSubscribe = true;

    await expect(receiver.subscribe(ROOM, null, () => undefined)).rejects.toThrow('max retries');

    // The client reconnects; this attach must actually subscribe the channel.
    const stream = await attach(receiver, null);
    await sender.publish(change(1));
    await settle();

    expect(receiverSubscriber.subscribeCalls).toBe(2);
    expect(stream.seen()).toEqual([1]);
    stream.sub.unsubscribe();
  });

  it('a second stream attached while the first SUBSCRIBE is in flight hears the room', async () => {
    const { receiver, receiverSubscriber, sender } = cluster();
    let release!: () => void;
    receiverSubscriber.after.set('subscribe', () => new Promise<void>((r) => (release = r)));

    const first = attach(receiver, null);
    await settle();
    const second = attach(receiver, null);
    // The second stream must not report itself attached before the channel is.
    let secondResolved = false;
    void second.then(() => (secondResolved = true));
    await settle();
    expect(secondResolved).toBe(false);

    release();
    const [a, b] = await Promise.all([first, second]);
    await sender.publish(change(1));
    await settle();
    expect(a.seen()).toEqual([1]);
    expect(b.seen()).toEqual([1]);
    a.sub.unsubscribe();
    b.sub.unsubscribe();
  });
});
