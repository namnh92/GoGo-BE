import { describe, expect, it } from 'vitest';
import { InMemoryRoomEventBus } from './in-memory-room-event-bus';
import { REPLAY_BUFFER_SIZE } from '../application/room-event-bus';
import type { SequencedRoomEvent } from '../domain/room-event';

const publish = (bus: InMemoryRoomEventBus, roomId: string, n: number) =>
  bus.publish({ roomId, type: 'vote.changed', payload: { n } });

describe('room event bus (#154)', () => {
  it('numbers events per room, so two rooms never share a resume point', async () => {
    const bus = new InMemoryRoomEventBus();
    const a = await publish(bus, 'room-a', 1);
    const b = await publish(bus, 'room-b', 1);
    const a2 = await publish(bus, 'room-a', 2);

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
    expect(a2.seq).toBe(2);
  });

  it('delivers to every listener on the room', async () => {
    const bus = new InMemoryRoomEventBus();
    const first: SequencedRoomEvent[] = [];
    const second: SequencedRoomEvent[] = [];
    await bus.subscribe('room', null, (e) => first.push(e));
    await bus.subscribe('room', null, (e) => second.push(e));

    await publish(bus, 'room', 1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('one listener leaving does not deafen the others', async () => {
    const bus = new InMemoryRoomEventBus();
    const staying: SequencedRoomEvent[] = [];
    const leaving = await bus.subscribe('room', null, () => undefined);
    await bus.subscribe('room', null, (e) => staying.push(e));

    leaving.unsubscribe();
    await publish(bus, 'room', 1);

    expect(staying).toHaveLength(1);
  });

  it('replays what a reconnecting client missed, in order', async () => {
    const bus = new InMemoryRoomEventBus();
    // A listener has to exist for the buffer to be kept: it is a resume aid,
    // not an event store, and is dropped once nobody is on the room.
    const held = await bus.subscribe('room', null, () => undefined);
    await publish(bus, 'room', 1);
    await publish(bus, 'room', 2);
    await publish(bus, 'room', 3);

    const resumed = await bus.subscribe('room', 1, () => undefined);
    expect(resumed.resync).toBe(false);
    expect(resumed.replay.map((e) => e.seq)).toEqual([2, 3]);
    held.unsubscribe();
    resumed.unsubscribe();
  });

  it('a fresh connection replays nothing — the client just fetched', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await bus.subscribe('room', null, () => undefined);
    await publish(bus, 'room', 1);

    const fresh = await bus.subscribe('room', null, () => undefined);
    expect(fresh.replay).toEqual([]);
    expect(fresh.resync).toBe(false);
    held.unsubscribe();
    fresh.unsubscribe();
  });

  it('reports a gap it cannot cover instead of silently skipping it', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await bus.subscribe('room', null, () => undefined);
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 10; i += 1) await publish(bus, 'room', i);

    // Resuming from the very first event: the buffer has long rolled past it.
    const resumed = await bus.subscribe('room', 1, () => undefined);
    expect(resumed.resync).toBe(true);
    expect(resumed.replay).toEqual([]);
    held.unsubscribe();
    resumed.unsubscribe();
  });

  it('keeps the buffer bounded however long a room runs', async () => {
    const bus = new InMemoryRoomEventBus();
    const held = await bus.subscribe('room', null, () => undefined);
    for (let i = 0; i < REPLAY_BUFFER_SIZE * 2; i += 1) await publish(bus, 'room', i);

    const resumed = await bus.subscribe('room', REPLAY_BUFFER_SIZE, () => undefined);
    expect(resumed.replay.length).toBeLessThanOrEqual(REPLAY_BUFFER_SIZE);
    held.unsubscribe();
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
