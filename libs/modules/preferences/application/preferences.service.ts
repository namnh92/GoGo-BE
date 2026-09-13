import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeOutbox } from '../../shared/outbox';
import { assertValidSelections as assertValidTaxonomySelections } from '../../shared/taxonomy-selections';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import { ROOM_EVENT_BUS, type RoomEventBus } from '../../realtime/application/room-event-bus';

/**
 * BE-BFF-005 — private per-member preferences with autosave + optimistic
 * concurrency. FR-PREF-005: only the owner ever reads their selections;
 * everyone else sees completion status via the members endpoint.
 */
@Injectable()
export class PreferencesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly policy: RoomPolicy,
    @Inject(ROOM_EVENT_BUS) private readonly events: RoomEventBus,
  ) {}

  /** Transport-only: a realtime failure never fails the write it describes. */
  private async publish(input: Parameters<RoomEventBus['publish']>[0]): Promise<void> {
    try {
      await this.events.publish(input);
    } catch {
      /* clients fall back to polling */
    }
  }

  /** FR-PREF-002 — the validator is shared with the profile's interests (ADR-0022). */
  private assertValidSelections(selections: Record<string, string[]>): Promise<void> {
    return assertValidTaxonomySelections(this.db, selections);
  }

  async getMine(actor: Actor, roomId: string) {
    const { member } = await this.policy.requireMember(actor, roomId);
    const [row] = await this.db
      .select()
      .from(schema.preferenceSelections)
      .where(eq(schema.preferenceSelections.memberId, member.id))
      .limit(1);
    return {
      selections: row?.selections ?? {},
      weights: row?.weights ?? undefined,
      version: row?.version ?? 0,
      isDraft: row?.isDraft ?? true,
      completedAt: row?.completedAt?.toISOString(),
    };
  }

  /** Autosave upsert. expectedVersion 0 = first save. */
  async saveMine(
    actor: Actor,
    roomId: string,
    input: {
      selections: Record<string, string[]>;
      weights?: Record<string, number>;
      expectedVersion: number;
    },
  ) {
    const { room, member } = await this.policy.requireMember(actor, roomId);
    if (!['draft', 'collecting', 'matching'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_COLLECTING', 'Preferences are closed for this room');
    }
    await this.assertValidSelections(input.selections);

    const saved = await this.db.transaction(async (tx) => {
      const [lockedRoom] = await tx
        .select()
        .from(schema.rooms)
        .where(eq(schema.rooms.id, roomId))
        .for('update');
      if (!lockedRoom || !['draft', 'collecting', 'matching'].includes(lockedRoom.status))
        throw AppError.conflict('ROOM_NOT_COLLECTING', 'Preferences are closed');
      const [existing] = await tx
        .select()
        .from(schema.preferenceSelections)
        .where(eq(schema.preferenceSelections.memberId, member.id))
        .for('update')
        .limit(1);

      if (!existing) {
        if (input.expectedVersion !== 0) {
          throw AppError.conflict('PREFERENCE_VERSION_CONFLICT', 'Draft changed elsewhere');
        }
        await tx.insert(schema.preferenceSelections).values({
          roomId,
          memberId: member.id,
          selections: input.selections,
          weights: input.weights,
          isDraft: true,
          version: 1,
        });
        await this.markInProgress(tx, member.id);
        return { version: 1, isDraft: true };
      }

      if (lockedRoom.status === 'matching' && !existing.isDraft) {
        await tx
          .update(schema.candidateScores)
          .set({ isStale: true })
          .where(eq(schema.candidateScores.roomId, roomId));
      }
      if (existing.version !== input.expectedVersion) {
        throw AppError.conflict('PREFERENCE_VERSION_CONFLICT', 'Draft changed elsewhere');
      }
      const [updated] = await tx
        .update(schema.preferenceSelections)
        .set({
          selections: input.selections,
          weights: input.weights ?? null,
          isDraft: true,
          version: existing.version + 1,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.preferenceSelections.id, existing.id))
        .returning({ version: schema.preferenceSelections.version });
      await this.markInProgress(tx, member.id);
      return { version: updated!.version, isDraft: true };
    });

    // Progress only — the fact that this member is working, not what they
    // picked. That distinction is the whole reason preferences are private.
    await this.publish({
      roomId,
      type: 'participant.selection_changed',
      actorId: member.id,
      payload: { memberId: member.id, selectionStatus: 'in_progress' },
    });
    return saved;
  }

  /** Marks the member done; when everyone is done the room moves to matching. */
  async completeMine(actor: Actor, roomId: string) {
    const { room, member } = await this.policy.requireMember(actor, roomId);
    if (!['collecting', 'matching', 'draft'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_COLLECTING', 'Preferences are closed for this room');
    }
    const [pref] = await this.db
      .select()
      .from(schema.preferenceSelections)
      .where(eq(schema.preferenceSelections.memberId, member.id))
      .limit(1);
    if (!pref || Object.values(pref.selections).every((keys) => keys.length === 0)) {
      throw AppError.badRequest('NO_SELECTIONS', 'Choose preferences before completing');
    }

    const allCompleted = await this.db.transaction(async (tx) => {
      const [lockedRoom] = await tx
        .select()
        .from(schema.rooms)
        .where(eq(schema.rooms.id, roomId))
        .for('update');
      if (!lockedRoom || !['draft', 'collecting', 'matching'].includes(lockedRoom.status))
        throw AppError.conflict('ROOM_NOT_COLLECTING', 'Preferences are closed');
      if (lockedRoom.status === 'matching' && pref.isDraft) {
        await tx
          .update(schema.candidateScores)
          .set({ isStale: true })
          .where(eq(schema.candidateScores.roomId, roomId));
      }
      await tx
        .update(schema.preferenceSelections)
        .set({ isDraft: false, completedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.preferenceSelections.id, pref.id));
      await tx
        .update(schema.roomMembers)
        .set({ selectionStatus: 'completed' })
        .where(eq(schema.roomMembers.id, member.id));
      await writeOutbox(tx, {
        eventType: 'preferences.completed',
        resourceType: 'room',
        resourceId: roomId,
        payload: { memberId: member.id },
      });

      const remaining = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.roomId, roomId),
            isNull(schema.roomMembers.removedAt),
            sql`${schema.roomMembers.selectionStatus} <> 'completed'`,
          ),
        );
      const members = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.roomMembers)
        .where(and(eq(schema.roomMembers.roomId, roomId), isNull(schema.roomMembers.removedAt)));

      const everyoneDone = (remaining[0]?.n ?? 1) === 0 && (members[0]?.n ?? 0) >= 2;
      // `draft` is accepted alongside `collecting` so a room created before
      // rooms opened in `collecting` is not stranded. `draft → collecting →
      // matching` is already legal, so no invariant moves here.
      // Decide on the locked row: the pre-lock `room` may say `collecting`
      // while the host already moved the room to `matching` — no flip, and no
      // `room.ready_for_matching` event for a flip that did not happen.
      if (everyoneDone && ['draft', 'collecting'].includes(lockedRoom.status)) {
        await tx
          .update(schema.rooms)
          .set({ status: 'matching', updatedAt: sql`now()` })
          .where(
            and(eq(schema.rooms.id, roomId), inArray(schema.rooms.status, ['draft', 'collecting'])),
          );
        await writeOutbox(tx, {
          eventType: 'room.ready_for_matching',
          resourceType: 'room',
          resourceId: roomId,
          payload: {},
        });
      }
      return everyoneDone;
    });

    // Reports the room, not just member progress. It used to say `true` while
    // the room sat in a state the matching endpoint rejects — the server
    // announcing readiness and then refusing to act on it.
    const [after] = await this.db
      .select({ status: schema.rooms.status })
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .limit(1);
    const roomStatus = after?.status ?? 'draft';

    // Progress, never content. Other members learn that this one is done;
    // what they chose stays private (FR-PREF-005).
    await this.publish({
      roomId,
      type: 'participant.selection_changed',
      actorId: member.id,
      payload: { memberId: member.id, selectionStatus: 'completed' },
    });
    if (allCompleted && roomStatus === 'matching' && room.status !== 'matching') {
      await this.publish({
        roomId,
        type: 'room.status_changed',
        payload: { from: room.status, to: 'matching' },
      });
    }

    return {
      completed: true,
      allMembersCompleted: allCompleted,
      roomStatus,
      // Both halves, deliberately: everyone has finished *and* the room is in a
      // state the matching endpoint accepts. Reporting only the first is what
      // let the server announce readiness and then answer 409; reporting only
      // the second would tell a client to start matching while half the room
      // has not answered yet.
      roomReadyForMatching: allCompleted && ['matching', 'collecting'].includes(roomStatus),
    };
  }

  /**
   * A saved draft means the member is editing, whatever they were before. A
   * completed member who saves again holds a draft, and ADR-0024 counts only
   * completed, non-draft responses — so the member row must say so too, or
   * `matchingReadiness` (member rows) and the ranking snapshot (selection
   * rows) disagree about who is done. `complete` sets it back.
   */
  private async markInProgress(
    tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
    memberId: string,
  ) {
    await tx
      .update(schema.roomMembers)
      .set({ selectionStatus: 'in_progress' })
      .where(eq(schema.roomMembers.id, memberId));
  }
}
