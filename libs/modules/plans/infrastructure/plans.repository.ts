import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeOutbox, type DomainEventInput } from '../../shared/outbox';
import { DB } from '../../shared/tokens';
import { pgArray } from '../../search/infrastructure/search.repository';
import type { PlanStopDraft, PlanTotalsDraft } from '../../suggestions/domain/types';

type RoomStatus = (typeof schema.rooms.$inferSelect)['status'];

export type PlanRow = typeof schema.plans.$inferSelect;
export type StopRow = typeof schema.planStops.$inferSelect;

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
  }): Promise<{ plan: PlanRow; stops: StopRow[] }> {
    return this.db.transaction(async (tx) => {
      const [prev] = await tx
        .select()
        .from(schema.plans)
        .where(and(eq(schema.plans.roomId, input.roomId), eq(schema.plans.status, 'current')))
        .limit(1);
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

  async setStopLock(stopId: string, locked: boolean, memberId: string): Promise<void> {
    await this.db
      .update(schema.planStops)
      .set({ isLocked: locked, lockedByMemberId: locked ? memberId : null })
      .where(eq(schema.planStops.id, stopId));
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
  }) {
    return this.db.transaction(async (tx) => {
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
        p.avg_visit_minutes, p.status,
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
    }[];
  }

  async setRoomStatus(roomId: string, status: RoomStatus) {
    await this.db
      .update(schema.rooms)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(schema.rooms.id, roomId));
  }
}
