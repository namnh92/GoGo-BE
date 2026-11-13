import { schema } from '@gogo/database';
import { describe, expect, it, vi } from 'vitest';
import { mutateSeedPlaces } from './seed-mutation';
import { validateSeedPlaces } from './seed-validation';
import { invalidateRoomInputs } from './room-input-invalidation';

vi.mock('./seed-validation', () => ({ validateSeedPlaces: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./room-input-invalidation', () => ({
  invalidateRoomInputs: vi.fn().mockResolvedValue(undefined),
}));

const roomId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const canonical = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const duplicate = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const extra = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actor = { type: 'user' as const, id: 'member-user', sessionId: 'session' };
const seed = (placeId: string) => ({
  placeId,
  name: placeId,
  position: 0,
  addedByMemberId: 'member',
});

function fixture(snapshots: ReturnType<typeof seed>[][], affected: string[]) {
  vi.mocked(validateSeedPlaces).mockClear();
  vi.mocked(invalidateRoomInputs).mockClear();
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const returning = vi.fn(async () =>
    affected.map((placeId) => ({ placeId, addedByMemberId: 'member' })),
  );
  const seedInsert = { onConflictDoNothing: vi.fn(() => seedInsert), returning };
  const tx = {
    select: vi.fn(() => {
      let table: unknown;
      const query = {
        from: (t: unknown) => {
          table = t;
          return query;
        },
        where: () => query,
        for: () => query,
        orderBy: () => query,
        innerJoin: () => query,
        then: (resolve: (rows: unknown[]) => unknown) => {
          if (table === schema.rooms)
            return Promise.resolve(
              resolve([
                {
                  id: roomId,
                  hostUserId: 'host-user',
                  constraintVersion: 1,
                  status: 'collecting',
                  expiresAt: null,
                },
              ]),
            );
          if (table === schema.roomMembers)
            return Promise.resolve(
              resolve([
                { id: 'host', userId: 'host-user', role: 'host', removedAt: null },
                { id: 'member', userId: actor.id, role: 'member', removedAt: null },
              ]),
            );
          if (table === schema.roomConstraints)
            return Promise.resolve(
              resolve([
                {
                  id: 'constraint',
                  roomId,
                  version: 1,
                  createdAt: new Date(0),
                },
              ]),
            );
          if (table === schema.roomSeedPlaces)
            return Promise.resolve(
              resolve(snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!),
            );
          return Promise.resolve(resolve([]));
        },
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return table === schema.roomSeedPlaces ? seedInsert : Promise.resolve();
      },
    })),
    delete: vi.fn(() => ({ where: () => ({ returning }) })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  };
  const db = { transaction: async (run: (t: typeof tx) => unknown) => run(tx) };
  const mutate = (operation: 'add' | 'remove', placeIds: string[]) =>
    mutateSeedPlaces(db as never, { actor, roomId, operation, placeIds });
  return { mutate, writes, returning, seedInsert };
}

describe('#878 F-01 actual seed mutation effects', () => {
  it('re-reads seeds after catalog validation; a merged duplicate is a no-op', async () => {
    const f = fixture([[seed(duplicate)], [seed(canonical)]], []);
    const result = await f.mutate('add', [canonical]);
    expect(result).toMatchObject({
      outcome: 'noop',
      event: null,
      body: { constraintVersion: 1, seedPlaces: [seed(canonical)] },
    });
    expect(f.writes).toEqual([]);
    expect(invalidateRoomInputs).not.toHaveBeenCalled();
  });
  it('a unique seed conflict returns the committed set without mutation effects', async () => {
    const f = fixture([[], [], [seed(canonical)]], []);
    const result = await f.mutate('add', [canonical]);
    expect(f.seedInsert.onConflictDoNothing).toHaveBeenCalledWith({
      target: [schema.roomSeedPlaces.roomId, schema.roomSeedPlaces.placeId],
    });
    expect(f.returning).toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'noop',
      event: null,
      body: { constraintVersion: 1, seedPlaces: [seed(canonical)] },
    });
    expect(f.writes.map((w) => w.table)).toEqual([schema.roomSeedPlaces]);
    expect(invalidateRoomInputs).not.toHaveBeenCalled();
  });
  it('a DELETE affecting zero rows never bumps version or emits effects', async () => {
    const f = fixture([[seed(duplicate)], [seed(canonical)]], []);
    const result = await f.mutate('remove', [duplicate]);
    expect(f.returning).toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'noop',
      event: null,
      body: { constraintVersion: 1, seedPlaces: [seed(canonical)] },
    });
    expect(f.writes).toEqual([]);
    expect(invalidateRoomInputs).not.toHaveBeenCalled();
  });
  it('a partially inserted batch reports only returned IDs in event, audit and outbox', async () => {
    const f = fixture([[], [], [seed(canonical), seed(extra)]], [extra]);
    const result = await f.mutate('add', [canonical, extra]);
    expect(result).toMatchObject({
      outcome: 'changed',
      body: { constraintVersion: 2 },
      event: { payload: { addedPlaceIds: [extra], removedPlaceIds: [] } },
    });
    expect(invalidateRoomInputs).toHaveBeenCalledTimes(1);
    expect(f.writes.find((w) => w.table === schema.auditLogs)?.values.diff).toMatchObject({
      addedPlaceIds: [extra],
      removedPlaceIds: [],
    });
    expect(f.writes.find((w) => w.table === schema.outboxEvents)?.values.payload).toMatchObject({
      addedPlaceIds: [extra],
      removedPlaceIds: [],
    });
  });
});
