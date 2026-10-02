import { describe, expect, it } from 'vitest';
import { InMemoryRoomEventBus } from './in-memory-room-event-bus';
import {
  REPLAY_BUFFER_SIZE,
  type ResyncNotice,
  type SubscriptionSink,
} from '../application/room-event-bus';
import type { ResumePoint } from '../domain/room-event-cursor';
import type { SequencedRoomEvent } from '../domain/room-event';

const publish = (bus: InMemoryRoomEventBus, roomId: string, n: number) =>
  bus.publish({ roomId, type: 'vote.changed', payload: { n } });

const FRESH: ResumePoint = { kind: 'fresh' };
const at = (generation: string, seq: number): ResumePoint => ({
  kind: 'cursor',
  cursor: { generation, seq },
});

function collector() {
  const events: SequencedRoomEvent[] = [];
  const resyncs: ResyncNotice[] = [];
  const failures: Error[] = [];
  const sink: SubscriptionSink = {
    event: (e) => events.push(e),
    resync: (n) => resyncs.push(n),
    fail: (e) => failures.push(e),
  };
  return { events, resyncs, failures, sink };
}

async function live(bus: InMemoryRoomEventBus, roomId: string, resume: ResumePoint = FRESH) {
  const c = collector();
  const subscription = await bus.subscribe(roomId, resume, c.sink);
  subscription.activate();
  return { ...c, subscription };
}

describe('room event bus (#154, ADR-0027)', () => {
  it('numbers events per room, so two rooms never share a resume point', async () => {
    const bus = new InMemoryRoomEventBus();
    const a = await publish(bus, 'room-a', 1);
    const b = await publish(bus, 'room-b', 1);
    const a2 = await publish(bus, 'room-a', 2);

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(a2.generation).toBe(a.generation);
    expect(b.generation).not.toBe(a.generation);
  });

  it('delivers to every listener on the room', async () => {
    const bus = new InMemoryRoomEventBus();
    const first = await live(bus, 'room');
    const second = await live(bus, 'room');

    await publish(bus, 'room', 1);

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });

  it('delivers nothing live until activate()', async () => {
    const bus = new InMemoryRoomEventBus();
    const c = collector();
    const subscription = await bus.subscribe('room', FRESH, c.sink);
    await publish(bus, 'room', 1);
    expect(c.events).toHaveLength(0);
    subscription.activate();
    expect(c.events.map((e) => e.seq)).toEqual([1]);
  });

  it('one listener leaving does not deafen the others', async () => {
    const bus = new InMemoryRoomEventBus();
    const leaving = await live(bus, 'room');
    const staying = await live(bus, 'room');

    leaving.subscription.unsubscribe();
    leaving.subscription.unsubscribe();
    await publish(bus, 'room', 1);

    expect(staying.events).toHaveLength(1);
    expect(leaving.events).toHaveLength(0);
  });

  it('replays what a reconnecting client missed, in order', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await live(bus, 'room');
    const first = await publish(bus, 'room', 1);
    await publish(bus, 'room', 2);
    await publish(bus, 'room', 3);

    const c = collector();
    const resumed = await bus.subscribe('room', at(first.generation, 1), c.sink);
    expect(resumed.resync).toBeNull();
    expect(resumed.replay.map((e) => e.seq)).toEqual([2, 3]);
    held.subscription.unsubscribe();
    resumed.unsubscribe();
  });

  it('a fresh connection replays nothing — the client just fetched', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await live(bus, 'room');
    await publish(bus, 'room', 1);

    const fresh = await bus.subscribe('room', FRESH, collector().sink);
    expect(fresh.replay).toEqual([]);
    expect(fresh.resync).toBeNull();
    held.subscription.unsubscribe();
    fresh.unsubscribe();
  });

  it('reports a gap it cannot cover instead of silently skipping it', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await live(bus, 'room');
    const first = await publish(bus, 'room', 0);
    for (let i = 1; i < REPLAY_BUFFER_SIZE + 10; i += 1) await publish(bus, 'room', i);

    // Resuming from the very first event: the buffer has long rolled past it.
    const resumed = await bus.subscribe('room', at(first.generation, 1), collector().sink);
    expect(resumed.resync).toEqual({
      reason: 'replay_unavailable',
      checkpoint: { generation: first.generation, seq: REPLAY_BUFFER_SIZE + 10 },
    });
    expect(resumed.replay).toEqual([]);
    held.subscription.unsubscribe();
    resumed.unsubscribe();
  });

  it('a reset room is a new generation: resume gets generation_changed, never reused seqs', async () => {
    const bus = new InMemoryRoomEventBus();
    const old = await publish(bus, 'room', 1);
    await publish(bus, 'room', 2);
    bus.resetRoom('room');
    await publish(bus, 'room', 3);
    await publish(bus, 'room', 4);
    const c = collector();
    const resumed = await bus.subscribe('room', at(old.generation, 1), c.sink);
    expect(resumed.resync?.reason).toBe('generation_changed');
    expect(resumed.resync?.checkpoint.seq).toBe(2);
    expect(resumed.resync?.checkpoint.generation).not.toBe(old.generation);
    expect(resumed.replay).toEqual([]);
  });

  it('answers a malformed or legacy resume point with resync', async () => {
    const bus = new InMemoryRoomEventBus();
    await publish(bus, 'room', 1);
    const resumed = await bus.subscribe('room', { kind: 'invalid' }, collector().sink);
    expect(resumed.resync?.reason).toBe('invalid_or_legacy_cursor');
  });

  it('keeps the buffer bounded however long a room runs', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await live(bus, 'room');
    let last: SequencedRoomEvent | undefined;
    for (let i = 0; i < REPLAY_BUFFER_SIZE * 2; i += 1) last = await publish(bus, 'room', i);

    const resumed = await bus.subscribe(
      'room',
      at(last!.generation, REPLAY_BUFFER_SIZE),
      collector().sink,
    );
    expect(resumed.replay.length).toBeLessThanOrEqual(REPLAY_BUFFER_SIZE);
    held.subscription.unsubscribe();
    resumed.unsubscribe();
  });

  it('carries the event envelope the contract rules require', async () => {
    const bus = new InMemoryRoomEventBus();
    const { event } = await bus.publish({
      roomId: 'room',
      type: 'plan.updated',
      actorId: 'member-1',
      resourceType: 'plan',
      resourceId: 'plan-1',
      payload: { version: 3 },
    });

    expect(event).toMatchObject({
      event_type: 'plan.updated',
      event_version: 1,
      actor_id: 'member-1',
      resource_type: 'plan',
      resource_id: 'plan-1',
      payload_schema_version: 1,
      payload: { version: 3 },
    });
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
