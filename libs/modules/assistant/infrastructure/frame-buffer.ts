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

/**
 * How long after a reply's creation its buffer can still exist: the TTL runs
 * from the first append (Redis) or the last one (memory), both within the
 * reply's own run (≤ `ASSISTANT_REPLY_MAX_MS`, at most two minutes). A
 * deletion queues a purge for every reply this young (A-R2-08).
 */
export const BUFFER_LIFETIME_SECONDS = FRAME_TTL_SECONDS + 15 * 60;

/** A buffer command not answered by then has failed (no offline queue). */
export const BUFFER_COMMAND_TIMEOUT_MS = 5_000;

/** After its turn ends, a runner issues no more buffer writes past this. */
export const BUFFER_APPEND_GRACE_MS = 30_000;

/*
 * Why the tombstone's lifetime (`BUFFER_LIFETIME_SECONDS`, 75 min) is enough
 * (S-F-03): a write is issued only while its turn runs (≤ 2 min) or within
 * `BUFFER_APPEND_GRACE_MS` after it; with no offline queue it is sent at
 * once or refused, and one already on the socket is answered, times out, or
 * dies with the connection (TCP gives up within minutes). No write can reach
 * Redis after the tombstone expires.
 */

export interface AssistantFrameBuffer {
  /** Appends frames in order; `seq` was assigned by the single writer. */
  append(messageId: string, frames: readonly AssistantFrame[]): Promise<void>;
  /**
   * Frames with `seq > afterSeq`, in `seq` order. A frame whose append failed
   * is missing, so the result may have holes: readers deliver only the run
   * contiguous with `afterSeq` (see `contiguousAfter`).
   */
  read(messageId: string, afterSeq: number): Promise<AssistantFrame[]>;
  /**
   * Drops a message's frames and stop flag (A-R-08: deletion, erasure) and
   * leaves a tombstone for the buffer's whole lifetime: an append still
   * queued by a runner that has not noticed the deletion is refused, so the
   * content cannot reappear after the purge (A-R3-04).
   */
  drop(messageId: string): Promise<void>;
  /** Resolves when something may have been appended, or after `timeoutMs`. */
  wait(messageId: string, timeoutMs: number): Promise<void>;
  requestStop(messageId: string): Promise<void>;
  stopRequested(messageId: string): Promise<boolean>;
}

export class InMemoryFrameBuffer implements AssistantFrameBuffer {
  private readonly frames = new Map<string, { list: AssistantFrame[]; expiresAt: number }>();
  private readonly stops = new Map<string, number>();
  private readonly gone = new Map<string, number>();
  private readonly events = new EventEmitter();
  private lastSweep = Date.now();

  constructor(private readonly now: () => number = Date.now) {
    this.events.setMaxListeners(0);
  }

  append(messageId: string, frames: readonly AssistantFrame[]): Promise<void> {
    this.sweep();
    if ((this.gone.get(messageId) ?? 0) > this.now()) return Promise.resolve();
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
    this.gone.set(messageId, this.now() + BUFFER_LIFETIME_SECONDS * 1000);
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
    for (const [k, v] of this.gone) if (v <= now) this.gone.delete(k);
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
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
};

/**
 * Append unless tombstoned, in one atomic step: a check-then-push from the
 * client could interleave with a drop and recreate the list (A-R3-04).
 * KEYS: frames, tombstone. ARGV: ttl, frame…
 */
const APPEND_UNLESS_GONE = `
if redis.call('exists', KEYS[2]) == 1 then return -1 end
local n = redis.call('rpush', KEYS[1], unpack(ARGV, 2))
if n == #ARGV - 1 then redis.call('expire', KEYS[1], ARGV[1]) end
return n`;

/** Tombstone first, then delete: an append after the tombstone is refused. */
const DROP_WITH_TOMBSTONE = `
redis.call('set', KEYS[3], '1', 'EX', ARGV[1])
redis.call('del', KEYS[1], KEYS[2])
return 1`;

const framesKey = (id: string) => `assistant:frames:${id}`;
const stopKey = (id: string) => `assistant:stop:${id}`;
const goneKey = (id: string) => `assistant:gone:${id}`;

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
    // Once per message: the first push sets the TTL, later ones inherit it.
    await this.redis.eval(
      APPEND_UNLESS_GONE,
      2,
      framesKey(messageId),
      goneKey(messageId),
      FRAME_TTL_SECONDS,
      ...frames.map((f) => JSON.stringify(f)),
    );
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
    await this.redis.eval(
      DROP_WITH_TOMBSTONE,
      3,
      framesKey(messageId),
      stopKey(messageId),
      goneKey(messageId),
      BUFFER_LIFETIME_SECONDS,
    );
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
