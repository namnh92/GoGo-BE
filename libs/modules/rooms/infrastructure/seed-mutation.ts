import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { currentRequestContext } from '../../shared/request-context';
import { writeOutbox, type Tx } from '../../shared/outbox';
import {
  assertSeedContributor,
  assertSeedEditable,
  assertSeedOwnership,
  normalizeSeedIds,
  ROOM_SEED_LIMIT,
  type RoomSeedPlacesResponse,
} from '../domain/seed-contribution';
import { validateSeedPlaces } from './seed-validation';
import { invalidateRoomInputs } from './room-input-invalidation';
import { beginSeedReplay, completeSeedReplay } from './seed-idempotency';

export function listSeedPlaces(db: Db | Tx, roomId: string) {
  return db
    .select({
      placeId: schema.roomSeedPlaces.placeId,
      name: schema.places.name,
      position: schema.roomSeedPlaces.position,
      addedByMemberId: schema.roomSeedPlaces.createdByMemberId,
    })
    .from(schema.roomSeedPlaces)
    .innerJoin(schema.places, eq(schema.places.id, schema.roomSeedPlaces.placeId))
    .where(eq(schema.roomSeedPlaces.roomId, roomId))
    .orderBy(asc(schema.roomSeedPlaces.position), asc(schema.roomSeedPlaces.placeId));
}
export type SeedMutationInput = {
  actor: Actor;
  roomId: string;
  operation: 'add' | 'remove';
  placeIds: string[];
  key?: string | undefined;
};
export async function mutateSeedPlaces(db: Db, input: SeedMutationInput) {
  const roomId = input.roomId.toLowerCase();
  const placeIds = normalizeSeedIds(input.placeIds);
  // Scope refusal precedes room lookup; a guest never gains account authority after claim.
  if (input.actor.type === 'guest' && input.actor.roomId?.toLowerCase() !== roomId)
    throw AppError.forbidden('ROOM_SCOPE_VIOLATION', 'Guest session is bound to another room');
  if (input.actor.type !== 'user')
    throw AppError.forbidden(
      'SEED_PLACES_FORBIDDEN',
      'Only account members can contribute seed places',
    );
  return db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .for('update');
    if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
    // Room → members matches transition/removal/claim lock order. Share locks also
    // protect against writers that touch membership directly.
    const members = await tx
      .select()
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), isNull(schema.roomMembers.removedAt)))
      .orderBy(asc(schema.roomMembers.id))
      .for('share');
    const member = assertSeedContributor(input.actor, room, members);
    assertSeedEditable(room);
    const replayInput =
      input.key === undefined
        ? null
        : { key: input.key, actor: input.actor, roomId, operation: input.operation, placeIds };
    const replay = replayInput ? await beginSeedReplay(tx, replayInput) : null;
    if (replay?.kind === 'replay')
      return { body: replay.body, outcome: 'replay' as const, role: member.role, event: null };
    // CMS merge locks both catalog rows FOR UPDATE (UUID order) before
    // rewriting seeds. DELETE must wait on that same row before reading D;
    // publication/area validation must still never gate removal.
    if (input.operation === 'remove')
      await tx
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(eq(schema.places.id, placeIds[0]!))
        .for('share');
    let seeds = await listSeedPlaces(tx, roomId);
    let added =
      input.operation === 'add'
        ? placeIds.filter((id) => !seeds.some((s) => s.placeId === id))
        : [];
    let removed: { placeId: string; addedByMemberId: string }[] =
      input.operation === 'remove' ? seeds.filter((s) => s.placeId === placeIds[0]) : [];
    for (const seed of removed) assertSeedOwnership(member, seed.addedByMemberId);
    let version = room.constraintVersion;
    let changed = false;
    let event = null;
    if (added.length > 0 || removed.length > 0) {
      const [previous] = await tx
        .select()
        .from(schema.roomConstraints)
        .where(
          and(
            eq(schema.roomConstraints.roomId, roomId),
            eq(schema.roomConstraints.version, version),
          ),
        );
      if (!previous)
        throw AppError.conflict('ROOM_AREA_UNRESOLVED', 'Room has no current constraints');
      if (added.length) {
        await validateSeedPlaces(tx, added, previous);
        // Validation takes dataset → catalog SHARE locks, UUID ordered, and
        // may wait for CMS D→C to commit. Re-read under those locks so C is
        // a duplicate no-op and quota/positions use the committed seed set.
        // Keep only already-validated candidates from the initial snapshot.
        seeds = await listSeedPlaces(tx, roomId);
        added = added.filter((id) => !seeds.some((s) => s.placeId === id));
        if (added.length && seeds.length + added.length > ROOM_SEED_LIMIT)
          throw AppError.conflict(
            'SEED_PLACE_LIMIT_REACHED',
            'Rooms allow at most 10 distinct seed places',
            [{ field: 'placeIds', code: 'limit_reached', message: 'room seed quota exceeded' }],
          );
        const base = Math.max(-1, ...seeds.map((s) => s.position)) + 1;
        if (added.length) {
          const inserted = await tx
            .insert(schema.roomSeedPlaces)
            .values(
              added.map((placeId, i) => ({
                roomId,
                placeId,
                position: base + i,
                createdByMemberId: member.id,
              })),
            )
            .onConflictDoNothing({
              target: [schema.roomSeedPlaces.roomId, schema.roomSeedPlaces.placeId],
            })
            .returning({ placeId: schema.roomSeedPlaces.placeId });
          added = inserted.map((s) => s.placeId);
        }
      } else {
        removed = await tx
          .delete(schema.roomSeedPlaces)
          .where(
            and(
              eq(schema.roomSeedPlaces.roomId, roomId),
              eq(schema.roomSeedPlaces.placeId, placeIds[0]!),
              ...(member.role === 'host'
                ? []
                : [eq(schema.roomSeedPlaces.createdByMemberId, member.id)]),
            ),
          )
          .returning({
            placeId: schema.roomSeedPlaces.placeId,
            addedByMemberId: schema.roomSeedPlaces.createdByMemberId,
          });
      }
      changed = added.length > 0 || removed.length > 0;
      if (changed) {
        version += 1;
        // Copy only the locked current revision. In particular, never resurrect a
        // privacy-erased origin from an earlier service read or partial DTO.
        const { id: _id, createdAt: _createdAt, ...constraint } = previous;
        await tx
          .insert(schema.roomConstraints)
          .values({ ...constraint, version, createdByMemberId: member.id });
        await tx
          .update(schema.rooms)
          .set({ constraintVersion: version, updatedAt: sql`now()` })
          .where(eq(schema.rooms.id, roomId));
        await invalidateRoomInputs(tx, roomId);
        const payload = {
          operation: input.operation,
          addedPlaceIds: added,
          removedPlaceIds: removed.map((s) => s.placeId),
          constraintVersion: version,
        };
        event = {
          roomId,
          type: 'room.seed_places_changed' as const,
          actorId: member.id,
          correlationId: currentRequestContext().requestId ?? null,
          payload,
        };
        await writeAudit(tx, {
          actorType: 'user',
          actorId: member.id,
          action: input.operation === 'add' ? 'room.seed_places_added' : 'room.seed_place_removed',
          resourceType: 'room',
          resourceId: roomId,
          diff: {
            ...payload,
            hostRemovedOthers:
              member.role === 'host' && removed.some((s) => s.addedByMemberId !== member.id),
          },
        });
        await writeOutbox(tx, {
          eventType: event.type,
          actorId: member.id,
          resourceType: 'room',
          resourceId: roomId,
          correlationId: event.correlationId ?? undefined,
          payload,
        });
      }
    }
    const body: RoomSeedPlacesResponse = {
      seedPlaces: await listSeedPlaces(tx, roomId),
      constraintVersion: version,
    };
    if (replayInput && replay?.kind === 'owned')
      await completeSeedReplay(tx, replayInput, replay.claim, replay.binding, body);
    return {
      body,
      outcome: changed ? ('changed' as const) : ('noop' as const),
      role: member.role,
      event,
    };
  });
}
