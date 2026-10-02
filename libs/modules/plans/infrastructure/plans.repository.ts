import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeOutbox, type DomainEventInput } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import { pgArray } from '../../search/infrastructure/search.repository';
import type { PlanStopDraft, PlanTotalsDraft } from '../../suggestions/domain/types';

type RoomStatus = (typeof schema.rooms.$inferSelect)['status'];

/**
 * GoGo-BE#228 (ADR-0028) — what a plan write read before computing, rechecked
 * inside the publishing transaction under the room row lock. The computation
 * (snapshot, provider travel) runs outside any transaction; this is what keeps
 * an interleaved constraint change, edit, regenerate or lock from being
 * overwritten by a result built from the older state.
 */
export type PlanWriteGuard = {
  sourcePlanId: string;
  sourceVersion: number;
  /** Room constraint version the snapshot was built from. */
  constraintVersion: number;
  forbiddenRoomStatuses: readonly RoomStatus[];
  /** Edit refuses a stale source; regenerate is how one is refreshed. */
  requireFresh: boolean;
  /** Every stop of the source plan as read: id + flags. */
  stopFlags: readonly { id: string; isLocked: boolean; isOptional: boolean }[];
};

export type PlanRow = typeof schema.plans.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type StopRow = typeof schema.planStops.$inferSelect;

/**
 * Postgres unique violation. Raised here by `plans_room_version_unique` when two
 * writers pick the same next version for one room (GoGo-BE#629).
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const c = e as { code?: unknown; constraint?: unknown };
    if (c.code === '23505' && c.constraint === constraint) return true;
  }
  return false;
}

@Injectable()
export class PlansRepository {
  constructor(@Inject(DB) readonly db: Db) {}

  async getPlan(planId: string): Promise<PlanRow> {
    const [plan] = await this.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, planId))
      .limit(1);
    if (!plan) throw AppError.notFound('PLAN_NOT_FOUND', 'Plan not found');
    return plan;
  }

  listStops(planId: string): Promise<StopRow[]> {
    return this.db
      .select()
      .from(schema.planStops)
      .where(eq(schema.planStops.planId, planId))
      .orderBy(asc(schema.planStops.position));
  }

  /**
   * BE-IMP-009 — availability of the places a plan points at.
   *
   * A saved plan keeps its stops when a place is taken down (core rule #7:
   * a locked stop is invariant), so the plan has to be able to say which of
   * them are no longer usable rather than presenting them as fine.
   */
  async placeAvailability(
    placeIds: string[],
  ): Promise<Map<string, { status: string; providerStatus: string | null; confidence: number }>> {
    if (placeIds.length === 0) return new Map();
    // Two independent axes, and a stop can fail on either: `places.status` is
    // what GoGo decided (draft, suspended by a moderator), `source_status` is
    // what the provider reports about the business (shut for now, shut for
    // good). A place taken down and a place on Tết holiday are not the same
    // thing to explain to a user.
    const rows = await this.db.execute(sql`
      select p.id, p.status, p.confidence,
        (select ps.source_status from place_provider_sources ps
          where ps.place_id = p.id
          order by ps.fetched_at desc limit 1) as provider_status
      from places p
      where p.id = any((${pgArray(placeIds)})::uuid[])
    `);
    return new Map(
      (
        rows.rows as {
          id: string;
          status: string;
          provider_status: string | null;
          /** numeric(3,2), NOT NULL — GoGo-BE#603 F-01. */
          confidence: string;
        }[]
      ).map((r) => [
        r.id,
        { status: r.status, providerStatus: r.provider_status, confidence: Number(r.confidence) },
      ]),
    );
  }

  getStop(stopId: string): Promise<StopRow | undefined> {
    return this.db
      .select()
      .from(schema.planStops)
      .where(eq(schema.planStops.id, stopId))
      .limit(1)
      .then((r) => r[0]);
  }

  currentPlan(roomId: string): Promise<PlanRow | undefined> {
    return this.db
      .select()
      .from(schema.plans)
      .where(and(eq(schema.plans.roomId, roomId), eq(schema.plans.status, 'current')))
      .limit(1)
      .then((r) => r[0]);
  }

  /**
   * SG-008 — plan versioning: supersede the previous current plan and insert
   * the new version + stops atomically. One current per room is also enforced
   * by the partial unique index.
   */
  async createPlanVersion(input: {
    roomId: string;
    constraintVersion: number;
    stops: PlanStopDraft[];
    totals: PlanTotalsDraft;
    generatedByRunId?: string | undefined;
    events: DomainEventInput[];
    /**
     * Move the room out of `from` and into `to` in the same transaction that
     * writes the plan, and refuse if it has already left `from` (GoGo-BE#629).
     * Only the paths where creating the plan *is* the transition pass this; a
     * regenerate leaves the room where it is and omits it.
     */
    claimRoom?: { from: RoomStatus; to: RoomStatus };
    guard?: PlanWriteGuard;
  }): Promise<{ plan: PlanRow; stops: StopRow[] }> {
    /*
     * The version is read and then written, so two writers for one room both
     * see the same `prev` and both pick the same next version. What stops the
     * duplicate is `plans_room_version_unique`, and until #629 that arrived as
     * an unhandled driver error — a 500 telling the caller to retry a decision
     * that had in fact been taken. The invariant was never in question; only
     * the answer was. So the violation is translated here into the domain fact
     * it represents: somebody else created this version first.
     */
    try {
      return await this.createPlanVersionOnce(input);
    } catch (error) {
      if (isUniqueViolation(error, 'plans_room_version_unique')) {
        throw AppError.conflict(
          'PLAN_VERSION_CONFLICT',
          'Another writer created this plan version first',
        );
      }
      throw error;
    }
  }

  private async createPlanVersionOnce(input: {
    roomId: string;
    constraintVersion: number;
    stops: PlanStopDraft[];
    totals: PlanTotalsDraft;
    generatedByRunId?: string | undefined;
    events: DomainEventInput[];
    claimRoom?: { from: RoomStatus; to: RoomStatus };
    guard?: PlanWriteGuard;
  }): Promise<{ plan: PlanRow; stops: StopRow[] }> {
    return this.db.transaction(async (tx) => {
      /*
       * The claim goes first, and it is a compare-and-swap rather than a read:
       * two finalize calls that arrive together must not both get to write.
       * Whichever updates the row owns the transition; the other sees no row
       * and stops here, before a second plan version exists.
       *
       * This is the half the unique index cannot cover. The index only catches
       * racers that picked the *same* version; a racer that starts after the
       * first commits reads the new plan as `prev`, picks the next version up,
       * and both succeed — two plans for one decision (GoGo-BE#629).
       */
      if (input.claimRoom) {
        const claimed = await tx
          .update(schema.rooms)
          .set({ status: input.claimRoom.to, updatedAt: sql`now()` })
          .where(
            and(eq(schema.rooms.id, input.roomId), eq(schema.rooms.status, input.claimRoom.from)),
          )
          .returning({ id: schema.rooms.id });
        if (claimed.length === 0) {
          throw AppError.conflict(
            'PLAN_VERSION_CONFLICT',
            'Another writer already moved this room on',
          );
        }
      }
      if (input.guard) await this.lockRoomFor(tx, input.roomId, input.guard);
      const [prev] = await tx
        .select()
        .from(schema.plans)
        .where(and(eq(schema.plans.roomId, input.roomId), eq(schema.plans.status, 'current')))
        .limit(1);
      if (input.guard) await this.checkSource(tx, prev, input.guard);
      if (prev) {
        await tx
          .update(schema.plans)
          .set({ status: 'superseded', updatedAt: sql`now()` })
          .where(eq(schema.plans.id, prev.id));
      }
      const version = (prev?.version ?? 0) + 1;
      const [plan] = await tx
        .insert(schema.plans)
        .values({
          roomId: input.roomId,
          version,
          status: 'current',
          totals: input.totals,
          constraintVersion: input.constraintVersion,
          generatedByRunId: input.generatedByRunId ?? null,
        })
        .returning();
      const stops =
        input.stops.length > 0
          ? await tx
              .insert(schema.planStops)
              .values(
                input.stops.map((s) => ({
                  planId: plan!.id,
                  placeId: s.placeId,
                  position: s.position,
                  arriveAt: s.arriveAt,
                  departAt: s.departAt,
                  durationMinutes: s.durationMinutes,
                  travelMinutesFromPrev: s.travelMinutesFromPrev,
                  travelDistanceMFromPrev: s.travelDistanceMFromPrev,
                  costMin: s.costMin,
                  costMax: s.costMax,
                  isLocked: s.isLocked,
                  isOptional: s.isOptional,
                })),
              )
              .returning()
          : [];
      for (const event of input.events) {
        await writeOutbox(tx, event);
      }
      return { plan: plan!, stops };
    });
  }

  /**
   * ADR-0028 — the room row lock every plan writer takes first, then the room
   * facts the computation assumed. A constraint change updates the same row,
   * so it either commits before this (and the version check refuses) or waits
   * and then marks the new plan stale.
   */
  private async lockRoomFor(tx: Tx, roomId: string, guard: PlanWriteGuard): Promise<void> {
    const [room] = await tx
      .select({ status: schema.rooms.status, constraintVersion: schema.rooms.constraintVersion })
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .for('update');
    if (!room) throw AppError.notFound('ROOM_NOT_FOUND', 'Room not found');
    if (guard.forbiddenRoomStatuses.includes(room.status)) {
      throw ['active', 'completed'].includes(room.status)
        ? AppError.conflict('ROOM_ACTIVE', 'Plan is locked once the date starts')
        : AppError.conflict('ROOM_NOT_EDITABLE', 'The room no longer accepts plan changes');
    }
    if (room.constraintVersion !== guard.constraintVersion) {
      throw AppError.conflict('PLAN_STALE', 'Room constraints changed — regenerate the plan');
    }
  }

  private async checkSource(
    tx: Tx,
    prev: PlanRow | undefined,
    guard: PlanWriteGuard,
  ): Promise<void> {
    if (!prev || prev.id !== guard.sourcePlanId || prev.version !== guard.sourceVersion) {
      throw AppError.conflict('PLAN_VERSION_CONFLICT', 'Plan changed concurrently — reload');
    }
    if (guard.requireFresh && prev.isStale) {
      throw AppError.conflict('PLAN_STALE', 'Room constraints changed — regenerate the plan');
    }
    const now = await tx
      .select({
        id: schema.planStops.id,
        isLocked: schema.planStops.isLocked,
        isOptional: schema.planStops.isOptional,
      })
      .from(schema.planStops)
      .where(eq(schema.planStops.planId, prev.id));
    const read = new Map(guard.stopFlags.map((f) => [f.id, f]));
    const same =
      now.length === read.size &&
      now.every((row) => {
        const was = read.get(row.id);
        return (
          was !== undefined && was.isLocked === row.isLocked && was.isOptional === row.isOptional
        );
      });
    if (!same) {
      throw AppError.conflict('PLAN_VERSION_CONFLICT', 'Plan stops changed concurrently — reload');
    }
  }

  /**
   * ADR-0028 — a lock lands on the current plan or not at all. Without the
   * room lock and the `current` recheck, a lock racing an edit could be
   * written to the version the edit had just superseded and silently lost.
   */
  async setStopLock(
    planId: string,
    roomId: string,
    stopId: string,
    locked: boolean,
    memberId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.rooms.id })
        .from(schema.rooms)
        .where(eq(schema.rooms.id, roomId))
        .for('update');
      const [plan] = await tx
        .select({ status: schema.plans.status })
        .from(schema.plans)
        .where(eq(schema.plans.id, planId))
        .limit(1);
      if (plan?.status !== 'current') {
        throw AppError.conflict('PLAN_NOT_CURRENT', 'Only the current plan can change');
      }
      await tx
        .update(schema.planStops)
        .set({ isLocked: locked, lockedByMemberId: locked ? memberId : null })
        .where(and(eq(schema.planStops.id, stopId), eq(schema.planStops.planId, planId)));
    });
  }

  async completeStop(stopId: string, event: DomainEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.planStops)
        .set({ status: 'completed', completedAt: sql`now()` })
        .where(eq(schema.planStops.id, stopId));
      await writeOutbox(tx, event);
    });
  }

  async upsertCheckin(input: {
    planStopId: string;
    memberId: string;
    rating?: number | undefined;
    tags: string[];
    note?: string | undefined;
    photoKeys: string[];
    billTotal?: number | undefined;
    billPeopleCount?: number | undefined;
    billPhotoKey?: string | undefined;
    event: DomainEventInput;
    /**
     * #560 F-02 — runs first inside the same transaction, so claims on the
     * check-in's uploads commit with the check-in row or not at all.
     */
    beforeWrite?: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<void>;
  }) {
    return this.db.transaction(async (tx) => {
      if (input.beforeWrite) await input.beforeWrite(tx);
      const [row] = await tx
        .insert(schema.stopCheckins)
        .values({
          planStopId: input.planStopId,
          memberId: input.memberId,
          rating: input.rating ?? null,
          tags: input.tags,
          note: input.note ?? null,
          photoKeys: input.photoKeys,
          billTotal: input.billTotal ?? null,
          billPeopleCount: input.billPeopleCount ?? null,
          billPhotoKey: input.billPhotoKey ?? null,
        })
        .onConflictDoUpdate({
          target: [schema.stopCheckins.planStopId, schema.stopCheckins.memberId],
          set: {
            rating: input.rating ?? null,
            tags: input.tags,
            note: input.note ?? null,
            photoKeys: input.photoKeys,
            billTotal: input.billTotal ?? null,
            billPeopleCount: input.billPeopleCount ?? null,
            billPhotoKey: input.billPhotoKey ?? null,
            moderation: 'pending',
            updatedAt: sql`now()`,
          },
        })
        .returning();
      await writeOutbox(tx, input.event);
      return row!;
    });
  }

  /** Coordinates + facts for specific places (plan edit/regenerate anchors). */
  async placeFacts(placeIds: string[]) {
    if (placeIds.length === 0) return [];
    const rows = await this.db.execute(sql`
      select p.id, p.name, ST_Y(p.geom) as lat, ST_X(p.geom) as lng,
        p.avg_visit_minutes, p.status, p.confidence,
        lp.price_min, lp.price_max
      from places p
      left join lateral (
        select pp.price_min, pp.price_max from place_prices pp
        where pp.place_id = p.id and pp.unit = 'per_person'
        order by pp.verified_at desc nulls last, pp.created_at desc limit 1
      ) lp on true
      where p.id = any((${pgArray(placeIds)})::uuid[])
    `);
    return rows.rows as {
      id: string;
      name: string;
      lat: number;
      lng: number;
      avg_visit_minutes: number | null;
      status: string;
      price_min: string | null;
      price_max: string | null;
      /** numeric(3,2), NOT NULL — GoGo-BE#603. */
      confidence: string;
    }[];
  }
}
