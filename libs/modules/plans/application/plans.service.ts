import { Injectable } from '@nestjs/common';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import { buildItinerary, type LockedAnchor } from '../../suggestions/domain/optimizer';
import { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import { PlansRepository, type PlanRow, type StopRow } from '../infrastructure/plans.repository';
import { PlanBuilderService } from './plan-builder.service';

/** BE-BFF-008 + BE-BFF-014 — plan read/edit/regenerate/active-date APIs. */
@Injectable()
export class PlansService {
  constructor(
    private readonly repo: PlansRepository,
    private readonly suggestions: SuggestionsRepository,
    private readonly builder: PlanBuilderService,
    private readonly policy: RoomPolicy,
  ) {}

  private toDto(plan: PlanRow, stops: StopRow[]) {
    return {
      id: plan.id,
      roomId: plan.roomId,
      version: plan.version,
      status: plan.status,
      isStale: plan.isStale,
      constraintVersion: plan.constraintVersion,
      totals: plan.totals,
      createdAt: plan.createdAt.toISOString(),
      stops: stops.map((s) => ({
        id: s.id,
        placeId: s.placeId,
        position: s.position,
        arriveAt: s.arriveAt?.toISOString(),
        departAt: s.departAt?.toISOString(),
        durationMinutes: s.durationMinutes,
        travelMinutesFromPrev: s.travelMinutesFromPrev,
        travelDistanceMFromPrev: s.travelDistanceMFromPrev,
        costMin: s.costMin,
        costMax: s.costMax,
        isLocked: s.isLocked,
        status: s.status,
        completedAt: s.completedAt?.toISOString(),
      })),
    };
  }

  async getPlan(actor: Actor, planId: string) {
    const plan = await this.repo.getPlan(planId);
    await this.policy.requireMember(actor, plan.roomId);
    return this.toDto(plan, await this.repo.listStops(planId));
  }

  async getCurrentForRoom(actor: Actor, roomId: string) {
    await this.policy.requireMember(actor, roomId);
    const plan = await this.repo.currentPlan(roomId);
    if (!plan) throw AppError.notFound('PLAN_NOT_FOUND', 'Room has no current plan');
    return this.toDto(plan, await this.repo.listStops(plan.id));
  }

  /**
   * FR-PLAN-002/003 — host edits the stop list (reorder/replace/remove/add/
   * lock). Optimistic concurrency on plan version; times/travel/costs are
   * recalculated, never trusted from the client.
   */
  async editStops(
    actor: Actor,
    planId: string,
    input: {
      expectedVersion: number;
      stops: { placeId: string; durationMinutes?: number | undefined; isLocked: boolean }[];
    },
  ) {
    const plan = await this.repo.getPlan(planId);
    const { room } = await this.policy.requireHost(actor, plan.roomId);
    if (plan.status !== 'current') {
      throw AppError.conflict('PLAN_NOT_CURRENT', 'Only the current plan can be edited');
    }
    if (['active', 'completed'].includes(room.status)) {
      throw AppError.conflict('ROOM_ACTIVE', 'Plan is locked once the date starts');
    }
    if (plan.version !== input.expectedVersion) {
      throw AppError.conflict('PLAN_VERSION_CONFLICT', 'Plan changed concurrently — reload');
    }
    if (input.stops.length === 0) {
      throw AppError.badRequest('EMPTY_PLAN', 'A plan needs at least one stop');
    }

    const facts = await this.repo.placeFacts(input.stops.map((s) => s.placeId));
    const anchors: LockedAnchor[] = input.stops.map((s, position) => {
      const fact = facts.find((f) => f.id === s.placeId);
      if (!fact || fact.status !== 'published') {
        throw AppError.badRequest('INVALID_PLACE', `Place ${s.placeId} is not available`);
      }
      return {
        placeId: s.placeId,
        name: fact.name,
        position,
        arriveAt: null,
        departAt: null,
        durationMinutes: s.durationMinutes ?? fact.avg_visit_minutes ?? 90,
        travelMinutesFromPrev: null,
        travelDistanceMFromPrev: null,
        costMin: fact.price_min !== null ? Number(fact.price_min) : null,
        costMax: fact.price_max !== null ? Number(fact.price_max) : null,
        isLocked: s.isLocked,
        lat: Number(fact.lat),
        lng: Number(fact.lng),
      };
    });

    const snapshot = await this.suggestions.buildSnapshot(plan.roomId);
    // Pool empty: the anchor list IS the plan; materialization recalculates
    // times, travel legs and totals (FR-PLAN-003).
    const built = buildItinerary({
      ranked: [],
      snapshot,
      lockedStops: anchors,
      maxStops: anchors.length,
    });
    const result = await this.repo.createPlanVersion({
      roomId: plan.roomId,
      constraintVersion: snapshot.constraintVersion,
      stops: built.stops,
      totals: built.totals,
      generatedByRunId: plan.generatedByRunId ?? undefined,
      events: [
        {
          eventType: 'plan.changed',
          resourceType: 'plan',
          resourceId: planId,
          payload: { action: 'edit', stopCount: built.stops.length },
        },
      ],
    });
    return this.toDto(result.plan, result.stops);
  }

  async regenerate(
    actor: Actor,
    planId: string,
    feedback: { excludePlaceIds?: string[] | undefined },
  ) {
    const plan = await this.repo.getPlan(planId);
    const { room } = await this.policy.requireHost(actor, plan.roomId);
    if (['active', 'completed'].includes(room.status)) {
      throw AppError.conflict('ROOM_ACTIVE', 'Plan is locked once the date starts');
    }
    const result = await this.builder.regenerate(planId, feedback);
    return this.toDto(result.plan, result.stops);
  }

  async lockStop(actor: Actor, planId: string, stopId: string, locked: boolean) {
    const plan = await this.repo.getPlan(planId);
    const { member } = await this.policy.requireHost(actor, plan.roomId);
    const stop = await this.repo.getStop(stopId);
    if (!stop || stop.planId !== planId) {
      throw AppError.notFound('STOP_NOT_FOUND', 'Stop not found');
    }
    await this.repo.setStopLock(stopId, locked, member.id);
    return this.getPlan(actor, planId);
  }

  /** FR-PLAN-008 — completing a stop during the active date. */
  async completeStop(actor: Actor, planId: string, stopId: string) {
    const plan = await this.repo.getPlan(planId);
    const { room, member } = await this.policy.requireMember(actor, plan.roomId);
    if (room.status !== 'active') {
      throw AppError.conflict('ROOM_NOT_ACTIVE', 'Stops complete during the active date');
    }
    const stop = await this.repo.getStop(stopId);
    if (!stop || stop.planId !== planId) {
      throw AppError.notFound('STOP_NOT_FOUND', 'Stop not found');
    }
    await this.repo.completeStop(stopId, {
      eventType: 'stop.completed',
      resourceType: 'plan',
      resourceId: planId,
      payload: { stopId, memberId: member.id },
    });
    return { completed: true };
  }

  /** FR-PLAN-008/009 + BE-BFF-014 — check-in with optional verified bill. */
  async checkin(
    actor: Actor,
    planId: string,
    stopId: string,
    input: {
      rating?: number | undefined;
      tags: string[];
      note?: string | undefined;
      photoKeys: string[];
      billTotal?: number | undefined;
      billPeopleCount?: number | undefined;
      billPhotoKey?: string | undefined;
    },
  ) {
    const plan = await this.repo.getPlan(planId);
    const { room, member } = await this.policy.requireMember(actor, plan.roomId);
    if (!['active', 'completed'].includes(room.status)) {
      throw AppError.conflict('ROOM_NOT_ACTIVE', 'Check-in happens during or after the date');
    }
    const stop = await this.repo.getStop(stopId);
    if (!stop || stop.planId !== planId) {
      throw AppError.notFound('STOP_NOT_FOUND', 'Stop not found');
    }
    if (input.billTotal !== undefined && !input.billPhotoKey) {
      // FR-PLAN-009: a bill amount requires the bill photo as evidence.
      throw AppError.badRequest(
        'BILL_PHOTO_REQUIRED',
        'Bill photo is required with a bill amount',
        [{ field: 'billPhotoKey', code: 'required', message: 'required when billTotal is set' }],
      );
    }
    const billPeople =
      input.billTotal !== undefined ? (input.billPeopleCount ?? room.participantCount) : undefined;

    const row = await this.repo.upsertCheckin({
      planStopId: stopId,
      memberId: member.id,
      rating: input.rating,
      tags: input.tags,
      note: input.note,
      photoKeys: input.photoKeys,
      billTotal: input.billTotal,
      billPeopleCount: billPeople,
      billPhotoKey: input.billPhotoKey,
      event: {
        eventType: 'stop.checkin_saved',
        resourceType: 'plan',
        resourceId: planId,
        payload: { stopId, hasBill: input.billTotal !== undefined },
      },
    });
    return {
      id: row.id,
      rating: row.rating ?? undefined,
      tags: row.tags,
      note: row.note ?? undefined,
      photoKeys: row.photoKeys,
      billTotal: row.billTotal ?? undefined,
      billPeopleCount: row.billPeopleCount ?? undefined,
      // Per-person is display math: total is canonical, per-person rounded.
      billPerPerson:
        row.billTotal !== null && row.billPeopleCount
          ? Math.round(row.billTotal / row.billPeopleCount)
          : undefined,
      moderation: row.moderation,
    };
  }
}
