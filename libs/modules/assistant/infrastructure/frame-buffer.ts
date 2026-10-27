import { EventEmitter } from 'node:events';
import type { AssistantFrame } from '../domain/assistant.types';

/**
 * GoGo-BE#713 — the live window of a reply's SSE frames. The turn writes
 * numbered frames here; any API instance's stream endpoint reads them after a
 * `Last-Event-ID`; at the terminal state the frames are folded into the
 * message row, which is what a replay reads from then on. A reconnect is a
 * read, never a second inference.
 *
 * Redis when `REDIS_URL` is set (a list per message, so `seq` is the list
 * position + 1), in memory otherwise — the in-memory buffer is correct for one
 * API instance, exactly like the in-memory room event bus.
 */
export const ASSISTANT_FRAME_BUFFER = Symbol('ASSISTANT_FRAME_BUFFER');

/** Long enough for any reply plus a reconnect; the row holds them after that. */
export const FRAME_TTL_SECONDS = 3600;

export interface AssistantFrameBuffer {
  /** Appends frames in order; `seq` was assigned by the single writer. */
  append(messageId: string, frames: readonly AssistantFrame[]): Promise<void>;
  /** Frames with `seq > afterSeq`, in order. */
  read(messageId: string, afterSeq: number): Promise<AssistantFrame[]>;
  /** Resolves when something may have been appended, or after `timeoutMs`. */
  wait(messageId: string, timeoutMs: number): Promise<void>;
  requestStop(messageId: string): Promise<void>;
  stopRequested(messageId: string): Promise<boolean>;
}

export class InMemoryFrameBuffer implements AssistantFrameBuffer {
  private readonly frames = new Map<string, { list: AssistantFrame[]; expiresAt: number }>();
  private readonly stops = new Map<string, number>();
  private readonly events = new EventEmitter();
  private lastSweep = Date.now();

  constructor(private readonly now: () => number = Date.now) {
    this.events.setMaxListeners(0);
  }

  append(messageId: string, frames: readonly AssistantFrame[]): Promise<void> {
    this.sweep();
    const entry = this.frames.get(messageId) ?? { list: [], expiresAt: 0 };
    entry.list.push(...frames);
    entry.expiresAt = this.now() + FRAME_TTL_SECONDS * 1000;
    this.frames.set(messageId, entry);
    this.events.emit(messageId);
    return Promise.resolve();
  }

  read(messageId: string, afterSeq: number): Promise<AssistantFrame[]> {
    const entry = this.frames.get(messageId);
    return Promise.resolve(entry ? entry.list.filter((f) => f.seq > afterSeq) : []);
  }

  wait(messageId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(messageId, done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.events.on(messageId, done);
    });
  }

  requestStop(messageId: string): Promise<void> {
    this.stops.set(messageId, this.now() + FRAME_TTL_SECONDS * 1000);
    this.events.emit(messageId);
    return Promise.resolve();
  }

  stopRequested(messageId: string): Promise<boolean> {
    const until = this.stops.get(messageId);
    return Promise.resolve(until !== undefined && until > this.now());
  }

  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.frames) if (v.expiresAt <= now) this.frames.delete(k);
    for (const [k, v] of this.stops) if (v <= now) this.stops.delete(k);
  }
}

/** Structural slice of ioredis used here. */
export type FrameRedis = {
  rpush(key: string, ...values: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  exists(key: string): Promise<number>;
};

const framesKey = (id: string) => `assistant:frames:${id}`;
const stopKey = (id: string) => `assistant:stop:${id}`;

export class RedisFrameBuffer implements AssistantFrameBuffer {
  constructor(
    private readonly redis: FrameRedis,
    /** Cross-instance readers poll; a same-instance reader is woken locally. */
    private readonly pollMs = 400,
    private readonly local = new EventEmitter(),
  ) {
    this.local.setMaxListeners(0);
  }

  async append(messageId: string, frames: readonly AssistantFrame[]): Promise<void> {
    if (frames.length === 0) return;
    const key = framesKey(messageId);
    const length = await this.redis.rpush(key, ...frames.map((f) => JSON.stringify(f)));
    // Once per message: the first push sets the TTL, later ones inherit it.
    if (length === frames.length) await this.redis.expire(key, FRAME_TTL_SECONDS);
    this.local.emit(messageId);
  }

  async read(messageId: string, afterSeq: number): Promise<AssistantFrame[]> {
    const raw = await this.redis.lrange(framesKey(messageId), Math.max(0, afterSeq), -1);
    return raw.map((r) => JSON.parse(r) as AssistantFrame).filter((f) => f.seq > afterSeq);
  }

  wait(messageId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.local.off(messageId, done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(timeoutMs, this.pollMs));
      timer.unref?.();
      this.local.on(messageId, done);
    });
  }

  async requestStop(messageId: string): Promise<void> {
    await this.redis.set(stopKey(messageId), '1', 'EX', FRAME_TTL_SECONDS);
    this.local.emit(messageId);
  }

  async stopRequested(messageId: string): Promise<boolean> {
    return (await this.redis.exists(stopKey(messageId))) === 1;
  }
}
