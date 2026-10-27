import { EventEmitter } from 'node:events';
import type { AssistantFrame } from '../domain/assistant.types';

/**
 * GoGo-BE#713 — the live window of a reply's SSE frames. The turn writes
 * numbered frames here; any API instance's stream endpoint reads them after a
 * `Last-Event-ID`; at the terminal state the frames are folded into the
 * message row, which is what a replay reads from then on. A reconnect is a
 * read, never a second inference.
 *
 * Redis when `REDIS_URL` is set (a list per message), in memory otherwise — the in-memory buffer is correct for one
 * API instance, exactly like the in-memory room event bus.
 */
export const ASSISTANT_FRAME_BUFFER = Symbol('ASSISTANT_FRAME_BUFFER');

/** Long enough for any reply plus a reconnect; the row holds them after that. */
export const FRAME_TTL_SECONDS = 3600;

export interface AssistantFrameBuffer {
  /** Appends frames in order; `seq` was assigned by the single writer. */
  append(messageId: string, frames: readonly AssistantFrame[]): Promise<void>;
  /**
   * Frames with `seq > afterSeq`, in `seq` order. A frame whose append failed
   * is missing, so the result may have holes: readers deliver only the run
   * contiguous with `afterSeq` (see `contiguousAfter`).
   */
  read(messageId: string, afterSeq: number): Promise<AssistantFrame[]>;
  /** Drops a message's frames and stop flag (A-R-08: deletion, erasure). */
  drop(messageId: string): Promise<void>;
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
    return Promise.resolve(entry ? bySeqAfter(entry.list, afterSeq) : []);
  }

  drop(messageId: string): Promise<void> {
    this.frames.delete(messageId);
    this.stops.delete(messageId);
    return Promise.resolve();
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
  del(...keys: string[]): Promise<number>;
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

  /**
   * A-R-10: the whole list, judged by each frame's own `seq`. After a failed
   * append, list position and `seq` disagree, so an offset would skip frames.
   * A reply is tens of frames, so reading it whole is cheap.
   */
  async read(messageId: string, afterSeq: number): Promise<AssistantFrame[]> {
    const raw = await this.redis.lrange(framesKey(messageId), 0, -1);
    return bySeqAfter(
      raw.map((r) => JSON.parse(r) as AssistantFrame),
      afterSeq,
    );
  }

  async drop(messageId: string): Promise<void> {
    await this.redis.del(framesKey(messageId), stopKey(messageId));
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

function bySeqAfter(frames: readonly AssistantFrame[], afterSeq: number): AssistantFrame[] {
  const seen = new Set<number>();
  return frames
    .filter((f) => f.seq > afterSeq && !seen.has(f.seq) && seen.add(f.seq))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The frames a reader may deliver now: those continuing `afterSeq` without a
 * hole. A hole is a frame whose append failed; it is filled from the row
 * once the turn is finalized, never skipped.
 */
export function contiguousAfter(
  frames: readonly AssistantFrame[],
  afterSeq: number,
): AssistantFrame[] {
  const out: AssistantFrame[] = [];
  let next = afterSeq + 1;
  for (const f of frames) {
    if (f.seq < next) continue;
    if (f.seq !== next) break;
    out.push(f);
    next += 1;
  }
  return out;
}
