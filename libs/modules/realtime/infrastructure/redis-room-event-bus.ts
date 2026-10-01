import { UPSTASH_REDIS_OPERATIONS } from '@gogo/cost-observability';
import { meterRuntimeCall, NoopMetrics, type MetricsPort } from '@gogo/observability';
import {
  REPLAY_BUFFER_SIZE,
  type RoomEventBus,
  type Subscription,
} from '../application/room-event-bus';
import type { PublishInput, RoomEvent, SequencedRoomEvent } from '../domain/room-event';
import { buildEvent } from './in-memory-room-event-bus';

/** Structural slice of ioredis, so the client version stays decoupled. */
export type RedisPubSubLike = {
  incr(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', handler: (channel: string, message: string) => void): unknown;
  off?(event: 'message', handler: (channel: string, message: string) => void): unknown;
  removeListener?(event: 'message', handler: (channel: string, message: string) => void): unknown;
};

const SEQ_TTL_SECONDS = 60 * 60 * 24;
/**
 * The resume window. Long enough for a phone that lost signal in a tunnel,
 * short enough that this stays a buffer rather than an event store — the
 * durable record of what happened is the outbox and the room's own tables.
 */
const BUFFER_TTL_SECONDS = 60 * 15;

const channelOf = (roomId: string) => `room:${roomId}:events`;
const seqKeyOf = (roomId: string) => `room:${roomId}:seq`;
const bufferKeyOf = (roomId: string) => `room:${roomId}:buffer`;

/**
 * Multi-instance bus. Publishing does three things: take a per-room sequence
 * number (`INCR`, monotonic across instances), append to a capped replay
 * buffer, and fan out on a channel.
 *
 * The sequence has to come from Redis rather than each process, or two api
 * instances would hand out the same id for different events and a client
 * resuming from it would silently skip one.
 */
export class RedisRoomEventBus implements RoomEventBus {
  /**
   * How many local streams are on each channel. Redis `UNSUBSCRIBE` is per
   * connection, not per listener, so the last member to disconnect is the only
   * one allowed to close the channel — otherwise one client leaving would go
   * silently deaf for everyone else in the room on this instance.
   */
  private readonly refCounts = new Map<string, number>();

  /** One subscriber connection: ioredis cannot run commands while subscribed. */
  constructor(
    private readonly commands: RedisPubSubLike,
    private readonly subscriber: RedisPubSubLike,
    /** #414 — publish and subscribe are each one runtime call, commands and all. */
    private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  publish(input: PublishInput): Promise<SequencedRoomEvent> {
    return meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.roomEventsPublish, async () => {
      const event = buildEvent(input);
      const seq = await this.commands.incr(seqKeyOf(input.roomId));
      await this.commands.expire(seqKeyOf(input.roomId), SEQ_TTL_SECONDS);

      const sequenced: SequencedRoomEvent = { seq, event };
      const message = JSON.stringify(sequenced);

      const bufferKey = bufferKeyOf(input.roomId);
      await this.commands.zadd(bufferKey, seq, message);
      await this.commands.zremrangebyrank(bufferKey, 0, -(REPLAY_BUFFER_SIZE + 1));
      await this.commands.expire(bufferKey, BUFFER_TTL_SECONDS);

      await this.commands.publish(channelOf(input.roomId), message);
      return sequenced;
    });
  }

  subscribe(
    roomId: string,
    afterSeq: number | null,
    listener: (event: SequencedRoomEvent) => void,
  ): Promise<Subscription> {
    return meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.roomEventsSubscribe, () =>
      this.attach(roomId, afterSeq, listener),
    );
  }

  /**
   * #638 — the SUBSCRIBE in flight per channel. A second stream on the same
   * channel waits for it instead of reporting itself attached to a channel
   * Redis is not yet delivering, and fails with it if it fails.
   */
  private readonly subscribing = new Map<string, Promise<unknown>>();

  /**
   * #638 — order matters. The channel is subscribed *before* the replay window
   * is read: an event published between the two is then either in the buffer
   * (ZADD precedes PUBLISH) or heard live, never neither. The reverse order
   * left a gap in which an event was neither replayed nor delivered, and a
   * reconnected stream looked open while the change reached the client only
   * through its safety poll. Events heard during the attach are held back and
   * merged into the replay by sequence, so nothing is emitted twice or ahead
   * of an older replayed event.
   */
  private async attach(
    roomId: string,
    afterSeq: number | null,
    listener: (event: SequencedRoomEvent) => void,
  ): Promise<Subscription> {
    const channel = channelOf(roomId);
    let attached = false;
    const early: SequencedRoomEvent[] = [];
    /**
     * Sequences already handed out in the replay. The replay comes over the
     * commands connection and the live copy over the subscriber connection, so
     * the live copy of a replayed event can still arrive after the attach;
     * it is dropped once. Keyed by sequence rather than a high-water mark, so a
     * slower publisher's lower sequence arriving late is still delivered.
     */
    const replayed = new Set<number>();

    const handler = (incoming: string, message: string) => {
      if (incoming !== channel) return;
      const event = JSON.parse(message) as SequencedRoomEvent;
      if (!attached) {
        early.push(event);
      } else if (replayed.delete(event.seq)) {
        return;
      } else {
        listener(event);
      }
    };
    this.subscriber.on('message', handler);
    const refs = (this.refCounts.get(channel) ?? 0) + 1;
    this.refCounts.set(channel, refs);

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      const remove = this.subscriber.off ?? this.subscriber.removeListener;
      remove?.call(this.subscriber, 'message', handler);
      const remaining = (this.refCounts.get(channel) ?? 1) - 1;
      if (remaining <= 0) {
        this.refCounts.delete(channel);
        this.subscribing.delete(channel);
        void this.subscriber.unsubscribe(channel);
      } else {
        this.refCounts.set(channel, remaining);
      }
    };

    try {
      await this.channelSubscribed(channel, refs === 1);

      let replay: SequencedRoomEvent[] = [];
      let resync = false;
      if (afterSeq !== null) {
        const raw = await this.commands.zrangebyscore(bufferKeyOf(roomId), afterSeq + 1, '+inf');
        replay = raw.map((item) => JSON.parse(item) as SequencedRoomEvent);
        const oldest = replay[0]?.seq;
        // Nothing at the resume point and something after it means the buffer
        // has already rolled past the gap: say so instead of skipping it.
        if (oldest !== undefined && oldest > afterSeq + 1) {
          resync = true;
          replay = [];
        }
      }

      // Whatever arrived live during the attach and is not already in the
      // replay goes out with it, in sequence order.
      for (const event of replay) replayed.add(event.seq);
      for (const event of early) {
        if (afterSeq !== null && event.seq <= afterSeq) continue;
        if (replayed.has(event.seq)) {
          replayed.delete(event.seq); // its live copy has already arrived
          continue;
        }
        replay.push(event);
      }
      replay.sort((a, b) => a.seq - b.seq);
      // From here on events go straight to the listener. Everything between
      // this line and the caller emitting `replay` runs in one microtask
      // chain, and pub/sub messages arrive as I/O, so none can slip between.
      attached = true;

      return { replay, resync, unsubscribe: detach };
    } catch (error) {
      // A failed attach must give its reference back, or the channel would
      // count a listener that does not exist and the next stream would never
      // SUBSCRIBE — open, heartbeating, and deaf.
      detach();
      throw error;
    }
  }

  private channelSubscribed(channel: string, first: boolean): Promise<unknown> {
    if (!first) return this.subscribing.get(channel) ?? Promise.resolve();
    const pending = this.subscriber.subscribe(channel);
    this.subscribing.set(channel, pending);
    // Only the outcome matters to waiters; a rejection is handled by each attach.
    pending.catch(() => undefined);
    return pending;
  }
}

export type { RoomEvent };
