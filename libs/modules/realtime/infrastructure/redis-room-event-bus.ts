import { randomUUID } from 'node:crypto';
import { UPSTASH_REDIS_OPERATIONS } from '@gogo/cost-observability';
import { meterRuntimeCall, NoopMetrics, type MetricsPort } from '@gogo/observability';
import {
  REPLAY_BUFFER_SIZE,
  type RoomEventBus,
  type Subscription,
  type SubscriptionSink,
} from '../application/room-event-bus';
import { RoomSubscription, type RoomSnapshot } from '../application/room-subscription';
import { isGeneration, type EventCursor, type ResumePoint } from '../domain/room-event-cursor';
import type { PublishInput, RoomEvent, SequencedRoomEvent } from '../domain/room-event';
import { buildEvent } from './in-memory-room-event-bus';
import { PUBLISH_SCRIPT, SNAPSHOT_SCRIPT, sha1 } from './room-event-scripts';

/** Structural slice of the ioredis command connection. */
export type RedisCommandsLike = {
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** ioredis connection state; with `lazyConnect` it starts at `wait`. */
  status?: string;
  connect?(): Promise<unknown>;
};

/** Structural slice of the ioredis subscriber connection. */
export interface RedisSubscriberLike {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', handler: (channel: string, message: string) => void): unknown;
  on(event: 'close' | 'end', handler: () => void): unknown;
}

/**
 * The resume window. Long enough for a phone that lost signal in a tunnel,
 * short enough that this stays a buffer rather than an event store — the
 * durable record of what happened is the outbox and the room's own tables.
 */
const BUFFER_TTL_SECONDS = 60 * 15;

/** ADR-0027 D5 — SUBSCRIBE ACK plus snapshot must finish within this. */
export const ATTACH_DEADLINE_MS = 5_000;

/*
 * ADR-0027 — new keys and channel, hash-tagged on the room id so the script's
 * keys share a slot. The pre-ADR `room:<id>:seq|buffer|events` names are
 * ignored and expire on their own; a different channel also keeps a
 * not-yet-drained old publisher from mixing into v2 streams.
 */
const channelOf = (roomId: string) => `room:{${roomId}}:v2:events`;
const metaKeyOf = (roomId: string) => `room:{${roomId}}:v2:meta`;
const bufferKeyOf = (roomId: string) => `room:{${roomId}}:v2:buffer`;

const PUBLISH_SHA = sha1(PUBLISH_SCRIPT);
const SNAPSHOT_SHA = sha1(SNAPSHOT_SCRIPT);

type ChannelEntry = {
  members: Set<RoomSubscription>;
  /** SUBSCRIBE of the current epoch; shared by every attach waiting on it. */
  ready: Promise<void> | null;
  /** Serializes SUBSCRIBE/UNSUBSCRIBE for this channel, in call order. */
  tail: Promise<void>;
  /** Bumped on every transition; a completion from an older epoch changes nothing. */
  epoch: number;
  /** Subscriber-connection generation this entry's server state lives on. */
  connection: number;
};

export class AttachDeadlineError extends Error {
  constructor() {
    super('Room event stream attach exceeded its deadline');
    this.name = 'AttachDeadlineError';
  }
}

class SubscriberLostError extends Error {
  constructor() {
    super('Room event subscriber connection lost');
    this.name = 'SubscriberLostError';
  }
}

class AttachAbandonedError extends Error {
  constructor() {
    super('Room event stream closed during attach');
    this.name = 'AttachAbandonedError';
  }
}

/**
 * Multi-instance bus (ADR-0027).
 *
 * Publish is one Lua script: sequence assignment, buffer append, trim, TTL and
 * PUBLISH in one Redis execution, so two api instances can no longer publish
 * `seq 8` before `seq 7` (F-01). Positions are `(generation, seq)` from a
 * non-expiring metadata hash, so a reset is detected rather than reused (F-04).
 *
 * Attach: the subscription is installed (queueing) before SUBSCRIBE, the
 * snapshot is read after the ACK, and the caller gets a paused subscription it
 * activates after emitting the replay (D3). Losing the subscriber connection
 * terminates every stream on it: Pub/Sub does not replay what was missed, so
 * the client's reconnect must run the full attach again (D5).
 */
export class RedisRoomEventBus implements RoomEventBus {
  private readonly channels = new Map<string, ChannelEntry>();
  private connection = 0;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly commands: RedisCommandsLike,
    private readonly subscriber: RedisSubscriberLike,
    /** #414 — publish and subscribe are each one runtime call, commands and all. */
    private readonly metrics: MetricsPort = new NoopMetrics(),
    private readonly options: { attachDeadlineMs?: number } = {},
  ) {
    subscriber.on('message', (channel, message) => this.onMessage(channel, message));
    subscriber.on('close', () => this.onSubscriberLost());
    subscriber.on('end', () => this.onSubscriberLost());
  }

  publish(input: PublishInput): Promise<SequencedRoomEvent> {
    return meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.roomEventsPublish, async () => {
      const event = buildEvent(input);
      // Exactly one attempt. A lost reply is ambiguous — the script may have
      // run — and a retry would publish the same change under a new event id.
      const reply = await this.script(
        PUBLISH_SCRIPT,
        PUBLISH_SHA,
        [metaKeyOf(input.roomId), bufferKeyOf(input.roomId)],
        [
          randomUUID(),
          JSON.stringify(event),
          REPLAY_BUFFER_SIZE,
          BUFFER_TTL_SECONDS,
          channelOf(input.roomId),
        ],
      );
      if (!Array.isArray(reply) || !isGeneration(reply[0])) {
        throw new Error('Room event publish returned an unexpected reply');
      }
      const seq = Number(reply[1]);
      if (!Number.isSafeInteger(seq) || seq < 1) {
        throw new Error('Room event publish returned an unexpected sequence');
      }
      return { generation: reply[0], seq, event };
    });
  }

  subscribe(roomId: string, resume: ResumePoint, sink: SubscriptionSink): Promise<Subscription> {
    return meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.roomEventsSubscribe, () =>
      this.attach(roomId, resume, sink),
    );
  }

  /** Test seam: open channel entries and their member counts. */
  channelMembers(): Map<string, number> {
    return new Map([...this.channels].map(([channel, entry]) => [channel, entry.members.size]));
  }

  private async attach(
    roomId: string,
    resume: ResumePoint,
    sink: SubscriptionSink,
  ): Promise<Subscription> {
    const channel = channelOf(roomId);
    // Installed before SUBSCRIBE: anything heard from here on is queued.
    const subscription = new RoomSubscription(sink, (after) => this.recoveryRead(roomId, after));
    const { entry, ready } = this.acquire(channel, subscription);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      subscription.close();
      this.release(channel, entry, subscription);
    };

    const handshake = (async () => {
      await ready;
      if (subscription.closed) throw new AttachAbandonedError();
      const after = resume.kind === 'cursor' ? resume.cursor : null;
      const snapshot = await this.snapshot(roomId, after);
      if (subscription.closed) throw new AttachAbandonedError();
      return subscription.begin(resume, snapshot);
    })();
    // Past the deadline nobody awaits it; its late outcome must not surface.
    handshake.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AttachDeadlineError()),
        this.options.attachDeadlineMs ?? ATTACH_DEADLINE_MS,
      );
      timer.unref?.();
    });
    try {
      const decision = await Promise.race([handshake, deadline]);
      return {
        replay: decision.replay,
        resync: decision.resync,
        activate: () => subscription.activate(),
        unsubscribe: release,
      };
    } catch (error) {
      // Give the reference back, or the channel would count a listener that
      // does not exist and never be unsubscribed.
      release();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Adds a member; the first member of an epoch queues a SUBSCRIBE behind any
   * pending transition. Later members share that ACK and fail with it.
   */
  private acquire(
    channel: string,
    member: RoomSubscription,
  ): { entry: ChannelEntry; ready: Promise<void> } {
    let entry = this.channels.get(channel);
    if (!entry) {
      entry = {
        members: new Set(),
        ready: null,
        tail: Promise.resolve(),
        epoch: 0,
        connection: this.connection,
      };
      this.channels.set(channel, entry);
    }
    entry.members.add(member);
    if (entry.ready) return { entry, ready: entry.ready };
    const owner = entry;
    const epoch = ++owner.epoch;
    const ready = owner.tail.then(async () => {
      await this.subscriber.subscribe(channel);
    });
    owner.ready = ready;
    owner.tail = ready.catch(() => undefined);
    // A failed SUBSCRIBE lets the next attach try again, unless a newer
    // transition already replaced this one.
    ready.catch(() => {
      if (owner.epoch === epoch) owner.ready = null;
    });
    return { entry, ready };
  }

  /** Idempotent per member; the last member out queues the UNSUBSCRIBE. */
  private release(channel: string, entry: ChannelEntry, member: RoomSubscription): void {
    if (!entry.members.delete(member)) return;
    if (entry.members.size > 0) return;
    const epoch = ++entry.epoch;
    entry.ready = null;
    entry.tail = entry.tail.then(async () => {
      // The connection that held this subscription is gone: nothing to undo,
      // and an UNSUBSCRIBE now would hit a newer subscription on the new one.
      if (entry.connection !== this.connection) return;
      // A newer attach re-subscribed in the meantime; leave it.
      if (entry.epoch !== epoch) return;
      try {
        await this.subscriber.unsubscribe(channel);
      } catch {
        // Handled, never unhandled: during an outage this rejects too, and the
        // connection-loss path already ended the streams.
      }
      if (entry.epoch === epoch && entry.members.size === 0) {
        if (this.channels.get(channel) === entry) this.channels.delete(channel);
      }
    });
  }

  private onMessage(channel: string, raw: string): void {
    const entry = this.channels.get(channel);
    if (!entry || entry.members.size === 0) return;
    const event = parseSequenced(raw);
    if (!event) return;
    for (const member of [...entry.members]) member.push(event);
  }

  private onSubscriberLost(): void {
    if (this.channels.size === 0) {
      this.connection += 1;
      return;
    }
    const entries = [...this.channels.values()];
    this.channels.clear();
    this.connection += 1;
    const error = new SubscriberLostError();
    for (const entry of entries) {
      entry.epoch += 1;
      entry.ready = null;
      for (const member of [...entry.members]) member.fail(error);
      entry.members.clear();
    }
  }

  private snapshot(roomId: string, after: EventCursor | null): Promise<RoomSnapshot> {
    return this.readSnapshot(roomId, after);
  }

  /** A live gap or generation change re-reads under the subscribe operation. */
  private recoveryRead(roomId: string, after: EventCursor | null): Promise<RoomSnapshot> {
    return meterRuntimeCall(this.metrics, UPSTASH_REDIS_OPERATIONS.roomEventsSubscribe, () =>
      this.readSnapshot(roomId, after),
    );
  }

  private async readSnapshot(roomId: string, after: EventCursor | null): Promise<RoomSnapshot> {
    const reply = await this.script(
      SNAPSHOT_SCRIPT,
      SNAPSHOT_SHA,
      [metaKeyOf(roomId), bufferKeyOf(roomId)],
      [randomUUID(), after?.generation ?? '', after?.seq ?? 0, REPLAY_BUFFER_SIZE + 1],
    );
    if (!Array.isArray(reply) || !isGeneration(reply[0]) || !Array.isArray(reply[2])) {
      throw new Error('Room event snapshot returned an unexpected reply');
    }
    const high = Number(reply[1]);
    if (!Number.isSafeInteger(high) || high < 0) {
      throw new Error('Room event snapshot returned an unexpected high-water mark');
    }
    const events: SequencedRoomEvent[] = [];
    for (const item of reply[2] as unknown[]) {
      // A malformed retained entry leaves a hole, which the contiguity check
      // turns into `resync` — never a silent skip.
      const event = typeof item === 'string' ? parseSequenced(item) : null;
      if (event) events.push(event);
    }
    return { generation: reply[0], high, events };
  }

  private async script(
    source: string,
    sha: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    await this.ensureConnected();
    try {
      return await this.commands.evalsha(sha, keys.length, ...keys, ...args);
    } catch (error) {
      // NOSCRIPT means the script did not run: sending it is not a retry.
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        return this.commands.eval(source, keys.length, ...keys, ...args);
      }
      throw error;
    }
  }

  /**
   * The command connection runs without an offline queue (ADR-0027 D5), so a
   * lazily-connected client must be connected before its first command.
   */
  private async ensureConnected(): Promise<void> {
    const client = this.commands;
    if (typeof client.connect !== 'function') return;
    if (client.status === 'wait') {
      this.connecting = client.connect().then(
        () => undefined,
        () => undefined,
      );
    }
    if (this.connecting && (client.status === 'connecting' || client.status === 'connect')) {
      await this.connecting;
    }
  }
}

function parseSequenced(raw: string): SequencedRoomEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<SequencedRoomEvent>;
    if (!value || !isGeneration(value.generation)) return null;
    if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1) {
      return null;
    }
    const event = value.event as RoomEvent | undefined;
    if (!event || typeof event.event_id !== 'string') return null;
    return { generation: value.generation, seq: value.seq, event };
  } catch {
    return null;
  }
}

export type { RoomEvent };
