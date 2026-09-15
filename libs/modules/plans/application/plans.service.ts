import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { RoomPolicy } from '../../rooms/presentation/room-policy';
import { ROOM_EVENT_BUS, type RoomEventBus } from '../../realtime/application/room-event-bus';
import { UploadsService } from '../../uploads/application/uploads.service';
import { FeedbackService } from '../../suggestions/application/feedback.service';
import type { FeedbackContext } from '../../suggestions/domain/feedback';
import { buildItinerary, type LockedAnchor } from '../../suggestions/domain/optimizer';
import { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import { PlansRepository, type PlanRow, type StopRow } from '../infrastructure/plans.repository';
import { PlanBuilderService } from './plan-builder.service';

/**
 * GoGo-BE#593 — what every plan cost is *per*. Plans read only `per_person`
 * price rows, the optimizer sums them per stop and compares the sum with the
 * per-person budget, so these amounts are per person. Without the scope in the
 * contract a client labelled the sum a group total and divided it again.
 */
export const PLAN_COST_SCOPE = 'per_person' as const;

/** BE-BFF-008 + BE-BFF-014 — plan read/edit/regenerate/active-date APIs. */
@Injectable()
export class PlansService {
  constructor(
    private readonly repo: PlansRepository,
    private readonly suggestions: SuggestionsRepository,
    private readonly builder: PlanBuilderService,
    private readonly policy: RoomPolicy,
    @Inject(ROOM_EVENT_BUS) private readonly events: RoomEventBus,
    private readonly uploads: UploadsService,
    private readonly feedback: FeedbackService,
  ) {}

  /**
   * A plan change reaches the other members. The version travels with it so a
   * client can tell an event about the plan it holds from one about a newer
   * one, instead of guessing from arrival order.
   */
  private async publishPlan(
    roomId: string,
    planId: string,
    version: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.events.publish({
        roomId,
        type: 'plan.updated',
        resourceType: 'plan',
        resourceId: planId,
        payload: { planId, version, reason },
      });
    } catch {
      /* transport-only; clients fall back to polling */
    }
  }

  /**
   * BE-IMP-009 — a place can be taken down after a plan is saved. The plan
   * keeps the stop (core rule #7: a locked stop is invariant, and silently
   * dropping stops would rewrite a plan people already agreed on), so the DTO
   * has to say which stops are no longer usable instead of presenting them as
   * fine (core rule #8). Clients get a stable code, never a sentence.
   */
  private async toDto(plan: PlanRow, stops: StopRow[]) {
    const statuses = await this.repo.placeAvailability(stops.map((s) => s.placeId));
    const unavailableReason = (placeId: string): string | undefined => {
      const row = statuses.get(placeId);
      if (row === undefined) return 'PLACE_MISSING';
      // A moderation decision outranks a business fact: if GoGo took the place
      // down, that is what an editor needs to see first.
      if (row.status === 'suspended') return 'PLACE_SUSPENDED';
      if (row.status === 'archived') return 'PLACE_ARCHIVED';
      if (row.status !== 'published') return 'PLACE_NOT_PUBLISHED';
      if (row.providerStatus === 'closed') return 'PLACE_CLOSED';
      if (row.providerStatus === 'temporarily_closed') return 'PLACE_TEMPORARILY_CLOSED';
      return undefined;
    };
    const reasons = new Map(stops.map((s) => [s.id, unavailableReason(s.placeId)]));

    return {
      id: plan.id,
      roomId: plan.roomId,
      version: plan.version,
      status: plan.status,
      isStale: plan.isStale,
      constraintVersion: plan.constraintVersion,
      totals: { ...plan.totals, costScope: PLAN_COST_SCOPE },
      createdAt: plan.createdAt.toISOString(),
      // Plan-level flag so a client can show one banner without scanning stops.
      hasUnavailableStops: [...reasons.values()].some((r) => r !== undefined),
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
        costScope: PLAN_COST_SCOPE,
        isLocked: s.isLocked,
        status: s.status,
        completedAt: s.completedAt?.toISOString(),
        // `status` above is the stop's own progress; this is the place behind it.
        placeAvailable: reasons.get(s.id) === undefined,
        unavailableReason: reasons.get(s.id),
      })),
    };
  }

  async getPlan(actor: Actor, planId: string) {
    const plan = await this.repo.getPlan(planId);
    await this.policy.requireMember(actor, plan.roomId);
    return await this.toDto(plan, await this.repo.listStops(planId));
  }

  async getCurrentForRoom(actor: Actor, roomId: string) {
    await this.policy.requireMember(actor, roomId);
    const plan = await this.repo.currentPlan(roomId);
    if (!plan) throw AppError.notFound('PLAN_NOT_FOUND', 'Room has no current plan');
    return await this.toDto(plan, await this.repo.listStops(plan.id));
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

    // BE-IMP-009: a place already in the plan may have been taken down since.
    // Blocking the whole edit on that traps the host — they cannot even remove
    // the offending stop. So an unavailable place blocks only when it is being
    // *added*; keeping or dropping one that is already there stays possible.
    const existingPlaceIds = new Set(
      (await this.repo.listStops(planId)).map((stop) => stop.placeId),
    );
    const facts = await this.repo.placeFacts(input.stops.map((s) => s.placeId));
    const anchors: LockedAnchor[] = input.stops.map((s, position) => {
      const fact = facts.find((f) => f.id === s.placeId);
      if (!fact) {
        throw AppError.badRequest('INVALID_PLACE', `Place ${s.placeId} does not exist`);
      }
      if (fact.status !== 'published' && !existingPlaceIds.has(s.placeId)) {
        throw AppError.badRequest(
          'PLACE_NOT_AVAILABLE',
          `Place ${s.placeId} cannot be added to a plan`,
        );
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
    const built = await buildItinerary({
      ranked: [],
      snapshot,
      lockedStops: anchors,
      maxStops: anchors.length,
      // Editing supplies the whole sequence, so nothing is selected greedily
      // and there is no batch to ask for — the legs between the given stops
      // are estimates, and the plan says so.
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
    await this.publishPlan(plan.roomId, result.plan.id, result.plan.version, 'edit');
    return await this.toDto(result.plan, result.stops);
  }

  async regenerate(
    actor: Actor,
    planId: string,
    feedback: { excludePlaceIds?: string[] | undefined; feedbackText?: string | undefined },
  ) {
    const plan = await this.repo.getPlan(planId);
    const { room, member } = await this.policy.requireHost(actor, plan.roomId);
    if (['active', 'completed'].includes(room.status)) {
      throw AppError.conflict('ROOM_ACTIVE', 'Plan is locked once the date starts');
    }
    // SG-009: a sentence becomes structured constraints here, and nowhere
    // else. What comes back is already validated against the candidate
    // allowlist and the room's own constraints, so `builder.regenerate` never
    // sees a raw proposal and the deterministic pipeline stays in charge.
    let interpreted: Awaited<ReturnType<FeedbackService['interpret']>> | null = null;
    if (feedback.feedbackText) {
      const snapshot = await this.suggestions.buildSnapshot(plan.roomId);
      const stops = await this.repo.listStops(planId);
      const candidates = await this.suggestions.retrieveCandidates(snapshot);
      const context: FeedbackContext = {
        allowedPlaceIds: candidates.map((c) => c.placeId),
        knownCategoryKeys: [
          ...new Set(candidates.flatMap((c) => c.taxonomyKeys['category'] ?? [])),
        ],
        knownDietaryKeys: [...new Set(candidates.flatMap((c) => c.taxonomyKeys['dietary'] ?? []))],
        budgetAmount: snapshot.budget.amount,
        radiusM: snapshot.radiusM,
        currentStopCount: stops.length,
      };
      interpreted = await this.feedback.interpret(
        {
          text: feedback.feedbackText,
          allowedPlaceIds: context.allowedPlaceIds,
          facts: {
            budgetMode: snapshot.budget.mode,
            budgetAmount: snapshot.budget.amount,
            currency: snapshot.budget.currency,
            categoryKeys: context.knownCategoryKeys,
          },
        },
        context,
        { planId, roomId: plan.roomId, memberId: member.id },
      );
    }

    const result = await this.builder.regenerate(planId, {
      ...(feedback.excludePlaceIds ? { excludePlaceIds: feedback.excludePlaceIds } : {}),
      ...(interpreted?.applied ?? {}),
    });
    await this.publishPlan(plan.roomId, result.plan.id, result.plan.version, 'regenerate');
    const dto = await this.toDto(result.plan, result.stops);
    return {
      ...dto,
      // The user is told what was understood and what was not. Feedback that
      // silently changes nothing is indistinguishable from feedback that was
      // ignored, and the second one is what actually happened.
      ...(interpreted
        ? {
            feedback: {
              understood: interpreted.understood,
              applied: interpreted.applied,
              ignoredReasons: interpreted.rejected,
            },
          }
        : {}),
    };
  }

  async lockStop(actor: Actor, planId: string, stopId: string, locked: boolean) {
    const plan = await this.repo.getPlan(planId);
    const { member } = await this.policy.requireHost(actor, plan.roomId);
    const stop = await this.repo.getStop(stopId);
    if (!stop || stop.planId !== planId) {
      throw AppError.notFound('STOP_NOT_FOUND', 'Stop not found');
    }
    await this.repo.setStopLock(stopId, locked, member.id);
    await this.publishPlan(
      plan.roomId,
      planId,
      plan.version,
      locked ? 'stop_locked' : 'stop_unlocked',
    );
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
    await this.publishPlan(plan.roomId, planId, plan.version, 'stop_completed');
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
    // #171 — a key is only usable by the actor who asked for it. Claimed
    // before the write, so a check-in never records a photo the member does
    // not own: without this an upload key is an unowned string and one member
    // could attach another's photo, or their bill.
    await this.uploads.attach(actor, input.photoKeys, {
      type: 'stop_checkin',
      id: `${stopId}:${member.id}`,
      purposes: ['checkin_photo'],
    });
    if (input.billPhotoKey) {
      await this.uploads.attach(actor, [input.billPhotoKey], {
        type: 'stop_checkin_bill',
        id: `${stopId}:${member.id}`,
        purposes: ['bill_photo'],
      });
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
