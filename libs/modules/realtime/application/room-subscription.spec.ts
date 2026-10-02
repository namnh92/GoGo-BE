import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EventCursor, ResumePoint } from '../domain/room-event-cursor';
import type { SequencedRoomEvent } from '../domain/room-event';
import { LIVE_QUEUE_LIMIT, type ResyncNotice, type SubscriptionSink } from './room-event-bus';
import { decideResume, RoomSubscription, type RoomSnapshot } from './room-subscription';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

function ev(generation: string, seq: number, id = randomUUID()): SequencedRoomEvent {
  return {
    generation,
    seq,
    event: {
      event_id: id,
      event_type: 'vote.changed',
      event_version: 1,
      occurred_at: new Date(0).toISOString(),
      actor_id: null,
      resource_type: 'room',
      resource_id: 'room',
      correlation_id: null,
      payload_schema_version: 1,
      payload: {},
    },
  };
}

const range = (generation: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ev(generation, from + i));

describe('decideResume (ADR-0027 D2/D5)', () => {
  const snap = (high: number, events = range(G1, 1, high)): RoomSnapshot => ({
    generation: G1,
    high,
    events,
  });
  const at = (generation: string, seq: number): ResumePoint => ({
    kind: 'cursor',
    cursor: { generation, seq },
  });

  it('fresh replays nothing and never resyncs', () => {
    expect(decideResume({ kind: 'fresh' }, snap(5))).toEqual({ replay: [], resync: null });
  });
  it('replays exactly (cursor, H] in order', () => {
    const out = decideResume(at(G1, 2), snap(5));
    expect(out.resync).toBeNull();
    expect(out.replay.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
  it('cursor at H with an empty buffer is a valid, empty replay', () => {
    expect(decideResume(at(G1, 5), snap(5, []))).toEqual({ replay: [], resync: null });
  });
  it('an empty buffer with H > cursor is replay_unavailable (expired buffer)', () => {
    expect(decideResume(at(G1, 3), snap(5, [])).resync).toEqual({
      reason: 'replay_unavailable',
      checkpoint: { generation: G1, seq: 5 },
    });
  });
  it('a trimmed buffer (oldest retained > cursor + 1) is replay_unavailable', () => {
    expect(decideResume(at(G1, 1), snap(5, range(G1, 3, 5))).resync?.reason).toBe(
      'replay_unavailable',
    );
  });
  it('a hole in the middle is replay_unavailable — never a partial replay', () => {
    const events = range(G1, 1, 5).filter((e) => e.seq !== 3);
    const out = decideResume(at(G1, 1), snap(5, events));
    expect(out.resync?.reason).toBe('replay_unavailable');
    expect(out.replay).toEqual([]);
  });
  it('generation is compared before any sequence (counter caught up or not)', () => {
    expect(decideResume(at(G2, 1), snap(5)).resync?.reason).toBe('generation_changed');
    expect(decideResume(at(G2, 9), snap(5)).resync?.reason).toBe('generation_changed');
  });
  it('a cursor ahead of the server is invalid_or_legacy_cursor', () => {
    expect(decideResume(at(G1, 6), snap(5)).resync?.reason).toBe('invalid_or_legacy_cursor');
  });
  it('a malformed or legacy cursor is invalid_or_legacy_cursor with the current checkpoint', () => {
    expect(decideResume({ kind: 'invalid' }, snap(5)).resync).toEqual({
      reason: 'invalid_or_legacy_cursor',
      checkpoint: { generation: G1, seq: 5 },
    });
  });
});

type Log = ({ kind: 'event'; e: SequencedRoomEvent } | { kind: 'resync'; n: ResyncNotice })[];

function recorder() {
  const log: Log = [];
  const failures: Error[] = [];
  const sink: SubscriptionSink = {
    event: (e) => log.push({ kind: 'event', e }),
    resync: (n) => log.push({ kind: 'resync', n }),
    fail: (e) => failures.push(e),
  };
  return { log, failures, sink };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Seeded PRNG so a failing run is reproducible from its seed. */
function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/**
 * A model of the Redis side: atomic publish (sequence order = publication
 * order), a bounded buffer that can expire, metadata that can be reset, and a
 * FIFO channel whose delivery the test schedules. `dupes` re-delivers old
 * copies at arbitrary later times (a delayed Pub/Sub copy).
 */
class ModelRoom {
  generation = G1;
  high = 0;
  buffer: SequencedRoomEvent[] = [];
  channel: SequencedRoomEvent[] = [];
  history: SequencedRoomEvent[] = [];
  subscribed = false;
  constructor(private readonly bufferSize: number) {}

  publish(): SequencedRoomEvent {
    this.high += 1;
    const e = ev(this.generation, this.high);
    this.buffer.push(e);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.history.push(e);
    if (this.subscribed) this.channel.push(e);
    return e;
  }
  reset(): void {
    this.generation = this.generation === G1 ? G2 : randomUUID();
    this.high = 0;
    this.buffer = [];
  }
  expire(): void {
    this.buffer = [];
  }
  snapshot(after: EventCursor | null): RoomSnapshot {
    const events =
      after && after.generation === this.generation
        ? this.buffer.filter((e) => e.seq > after.seq)
        : [];
    return { generation: this.generation, high: this.high, events: [...events] };
  }
}

/**
 * The invariant: walking the sink log from the resume point, every event is
 * the next sequence of the current generation (strictly increasing, no gaps,
 * no duplicates), every `resync` moves the position to its checkpoint, and
 * once the channel is drained the position is the room's head.
 */
function checkLog(log: Log, start: EventCursor | null) {
  const ids = new Set<string>();
  let pos = start;
  for (const entry of log) {
    if (entry.kind === 'resync') {
      pos = entry.n.checkpoint;
      continue;
    }
    const { e } = entry;
    expect(ids.has(e.event.event_id), `duplicate ${e.seq}`).toBe(false);
    ids.add(e.event.event_id);
    if (pos === null) pos = { generation: e.generation, seq: e.seq - 1 };
    expect(e.generation, `generation at ${e.seq}`).toBe(pos.generation);
    expect(e.seq, 'contiguous').toBe(pos.seq + 1);
    pos = { generation: e.generation, seq: e.seq };
  }
  return pos;
}

describe('RoomSubscription state machine (ADR-0027 D3, property-based)', () => {
  const RUNS = 400;

  it('random interleavings: ordered, gap-free, duplicate-free, or an explicit resync', async () => {
    for (let run = 0; run < RUNS; run++) {
      const seed = 1000 + run;
      const rand = prng(seed);
      const small = rand() < 0.3;
      const room = new ModelRoom(small ? 5 : 200);
      const withResets = rand() < 0.25;
      const withExpiry = rand() < 0.15;
      const dupes: SequencedRoomEvent[] = [];

      for (let i = Math.floor(rand() * 8); i > 0; i--) room.publish();
      const resume: ResumePoint =
        rand() < 0.2
          ? { kind: 'fresh' }
          : rand() < 0.1
            ? { kind: 'invalid' }
            : {
                kind: 'cursor',
                cursor: {
                  generation: room.generation,
                  seq: Math.floor(rand() * (room.high + 1)),
                },
              };

      const { log, failures, sink } = recorder();
      const sub = new RoomSubscription(sink, async (after) => room.snapshot(after));

      const deliverSome = () => {
        const n = Math.floor(rand() * (room.channel.length + 1));
        for (const e of room.channel.splice(0, n)) {
          sub.push(e);
          if (rand() < 0.3) dupes.push(e);
        }
        if (dupes.length && rand() < 0.3) sub.push(dupes[Math.floor(rand() * dupes.length)]!);
      };
      const chaos = () => {
        for (let k = Math.floor(rand() * 4); k > 0; k--) room.publish();
        if (withResets && rand() < 0.1) room.reset();
        if (withExpiry && rand() < 0.1) room.expire();
        deliverSome();
      };

      // Boundary: publishes before SUBSCRIBE takes effect are not live.
      chaos();
      room.subscribed = true; // SUBSCRIBE ACK
      chaos(); // between ACK and snapshot
      const attachSnapshot = room.snapshot(resume.kind === 'cursor' ? resume.cursor : null);
      const decision = sub.begin(resume, attachSnapshot);
      chaos(); // between snapshot and activate
      if (decision.resync) sink.resync(decision.resync);
      for (const e of decision.replay) sink.event(e);
      sub.activate();
      for (let step = Math.floor(rand() * 6); step > 0; step--) {
        chaos();
        await settle();
      }
      // Drain everything still in flight, plus late duplicates.
      for (let guard = 0; guard < 50 && (room.channel.length || guard < 2); guard++) {
        for (const e of room.channel.splice(0)) sub.push(e);
        for (const e of dupes) sub.push(e);
        await settle();
      }

      expect(failures, `seed ${seed}`).toEqual([]);
      const start =
        resume.kind === 'cursor'
          ? resume.cursor
          : resume.kind === 'invalid'
            ? null
            : // Fresh: must cover every event published after the snapshot.
              { generation: attachSnapshot.generation, seq: attachSnapshot.high };
      let end: EventCursor | null;
      try {
        end = checkLog(log, start);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`, { cause: error });
      }
      // A reset nobody has published into yet is invisible until its first
      // event — and changes nothing a client could refetch — so the head is
      // the last event published, in whichever generation that was.
      const last = room.history.at(-1);
      const head =
        room.high > 0
          ? { generation: room.generation, seq: room.high }
          : last
            ? { generation: last.generation, seq: last.seq }
            : null;
      // Every resume kind starts from a position (cursor, snapshot, or the
      // initial resync's checkpoint), so there is always an end position.
      expect(end, `seed ${seed} position`).not.toBeNull();
      if (head && (end!.generation === head.generation || room.high > 0)) {
        expect(end, `seed ${seed} head`).toEqual(head);
      }
      if (!small && !withResets && !withExpiry && resume.kind === 'cursor') {
        // History fully retained: exact replay, no resync at all.
        expect(
          log.some((l) => l.kind === 'resync'),
          `seed ${seed} needless resync`,
        ).toBe(false);
      }
      const footprint = sub.footprint;
      expect(footprint.queued).toBeLessThanOrEqual(LIVE_QUEUE_LIMIT);
      expect(footprint.replayIds).toBeLessThanOrEqual(200);
    }
  });

  it('F-04: resume at old seq 2, metadata reset, new seq 1 during attach → resync, never filtered', async () => {
    for (const newEvents of [1, 3]) {
      const room = new ModelRoom(200);
      room.publish();
      room.publish();
      const resume: ResumePoint = { kind: 'cursor', cursor: { generation: G1, seq: 2 } };
      const { log, sink } = recorder();
      const sub = new RoomSubscription(sink, async (after) => room.snapshot(after));
      room.subscribed = true;
      room.reset();
      for (let i = 0; i < newEvents; i++) room.publish(); // new seq 1 (… 3) during attach
      const decision = sub.begin(resume, room.snapshot(resume.cursor));
      expect(decision.resync?.reason).toBe('generation_changed');
      sink.resync(decision.resync!);
      for (const e of room.channel.splice(0)) sub.push(e);
      sub.activate();
      await settle();
      expect(log[0]).toMatchObject({ kind: 'resync' });
      // Events at or below the checkpoint are covered by the refetch; none after it is lost.
      expect(checkLog(log, null)).toEqual({ generation: room.generation, seq: newEvents });
    }
  });

  it('F-05: a replayed event re-delivered after 30 s (or much later) is not re-emitted', async () => {
    const room = new ModelRoom(200);
    for (let i = 0; i < 5; i++) room.publish();
    room.subscribed = true;
    const { log, sink } = recorder();
    const sub = new RoomSubscription(sink, async (after) => room.snapshot(after));
    const decision = sub.begin(
      { kind: 'cursor', cursor: { generation: G1, seq: 2 } },
      room.snapshot({ generation: G1, seq: 2 }),
    );
    for (const e of decision.replay) sink.event(e);
    sub.activate();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      for (const e of room.history) sub.push(e); // delayed live copies
      Date.now = () => realNow() + 3_600_000;
      for (const e of room.history) sub.push(e);
    } finally {
      Date.now = realNow;
    }
    expect(log.map((l) => (l.kind === 'event' ? l.e.seq : 'resync'))).toEqual([3, 4, 5]);
    expect(sub.footprint.replayIds).toBe(3);
  });

  it('queue overflow during attach enters recovery, never a silent drop', async () => {
    const room = new ModelRoom(1000);
    room.subscribed = true;
    const { log, sink } = recorder();
    const sub = new RoomSubscription(sink, async (after) => room.snapshot(after));
    for (let i = 0; i < LIVE_QUEUE_LIMIT + 50; i++) sub.push(room.publish());
    expect(sub.footprint.queued).toBeLessThanOrEqual(LIVE_QUEUE_LIMIT);
    sub.begin(
      { kind: 'cursor', cursor: { generation: G1, seq: 0 } },
      {
        generation: G1,
        high: 0,
        events: [],
      },
    );
    sub.activate();
    await settle();
    expect(checkLog(log, { generation: G1, seq: 0 })).toEqual({
      generation: G1,
      seq: LIVE_QUEUE_LIMIT + 50,
    });
  });

  it('overflow whose gap the buffer cannot cover reports resync', async () => {
    const room = new ModelRoom(10);
    room.subscribed = true;
    const { log, sink } = recorder();
    const sub = new RoomSubscription(sink, async (after) => room.snapshot(after));
    for (let i = 0; i < LIVE_QUEUE_LIMIT + 5; i++) sub.push(room.publish());
    sub.begin(
      { kind: 'cursor', cursor: { generation: G1, seq: 0 } },
      {
        generation: G1,
        high: 0,
        events: [],
      },
    );
    sub.activate();
    await settle();
    expect(log).toEqual([
      {
        kind: 'resync',
        n: {
          reason: 'replay_unavailable',
          checkpoint: { generation: G1, seq: LIVE_QUEUE_LIMIT + 5 },
        },
      },
    ]);
  });

  it('a failed recovery read terminates the stream', async () => {
    const { failures, sink } = recorder();
    const sub = new RoomSubscription(sink, () => Promise.reject(new Error('redis down')));
    sub.begin({ kind: 'fresh' }, { generation: G1, high: 0, events: [] });
    sub.activate();
    sub.push(ev(G1, 3)); // gap → recovery → fails
    await settle();
    expect(failures.map((e) => e.message)).toEqual(['redis down']);
    expect(sub.closed).toBe(true);
  });

  it('a copy from an old generation after an authoritative read is dropped, not looped on', async () => {
    const room = new ModelRoom(200);
    room.subscribed = true;
    const { log, failures, sink } = recorder();
    let reads = 0;
    const sub = new RoomSubscription(sink, async (after) => {
      reads += 1;
      return room.snapshot(after);
    });
    room.publish();
    sub.begin({ kind: 'fresh' }, room.snapshot(null));
    sub.activate();
    sub.push(ev(G2, 1)); // unknown generation; metadata still says G1
    await settle();
    sub.push(ev(G2, 2));
    await settle();
    expect(failures).toEqual([]);
    expect(reads).toBe(1);
    expect(log).toEqual([]);
  });
});
