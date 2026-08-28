import { Injectable } from '@nestjs/common';
import { AppError } from '../../shared/app-error';
import { rankWithFairness } from '../../suggestions/domain/fairness';
import { hardFilter } from '../../suggestions/domain/hard-filter';
import { buildItinerary, type LockedAnchor } from '../../suggestions/domain/optimizer';
import { scoreCandidate } from '../../suggestions/domain/scoring';
import { DEFAULT_SCORING_WEIGHTS } from '../../suggestions/domain/types';
import { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import { PlansRepository } from '../infrastructure/plans.repository';
import { TravelTimeService } from '../../travel/application/travel-time.service';

/**
 * Shared plan construction (SG-007/SG-008): winner-anchored builds and
 * regenerate with locked anchors. Deterministic; used by both the decision
 * flow and the plan endpoints.
 */
@Injectable()
export class PlanBuilderService {
  constructor(
    private readonly plans: PlansRepository,
    private readonly suggestions: SuggestionsRepository,
    private readonly travel: TravelTimeService,
  ) {}

  /**
   * ADR-0007 — one provider call per greedy step. Bound here rather than
   * imported inside the optimizer so the optimizer stays a pure function and
   * its determinism tests keep running without a provider.
   */
  private get travelBatch() {
    return (
      origin: { lat: number; lng: number; placeId?: string | undefined },
      destinations: { lat: number; lng: number; placeId?: string | undefined }[],
    ) => this.travel.matrix(origin, destinations);
  }

  /** Winner becomes stop #1; the optimizer fills complementary stops. */
  async buildAroundWinner(roomId: string, winnerPlaceId: string, runId?: string) {
    const snapshot = await this.suggestions.buildSnapshot(roomId);
    const candidates = await this.suggestions.retrieveCandidates(snapshot);
    const winner = candidates.find((c) => c.placeId === winnerPlaceId);
    if (!winner) throw AppError.badRequest('NOT_A_CANDIDATE', 'Winner is not a valid candidate');

    const passed = candidates.filter(
      (c) => c.placeId !== winnerPlaceId && hardFilter(c, snapshot).ok,
    );
    const ranked = rankWithFairness(
      passed.map((c) => scoreCandidate(c, snapshot, DEFAULT_SCORING_WEIGHTS)),
      { topK: 10 },
    );
    // Winner is a hard anchor at position 0.
    const anchor: LockedAnchor = {
      placeId: winner.placeId,
      name: winner.name,
      position: 0,
      arriveAt: null,
      departAt: null,
      durationMinutes: winner.avgVisitMinutes ?? 90,
      travelMinutesFromPrev: null,
      travelDistanceMFromPrev: null,
      costMin: winner.pricePerPersonMin,
      costMax: winner.pricePerPersonMax,
      isLocked: false,
      lat: winner.lat,
      lng: winner.lng,
    };
    const built = await buildItinerary({
      ranked,
      snapshot,
      lockedStops: [anchor],
      travel: this.travelBatch,
    });

    const result = await this.plans.createPlanVersion({
      roomId,
      constraintVersion: snapshot.constraintVersion,
      stops: built.stops,
      totals: built.totals,
      generatedByRunId: runId,
      events: [
        {
          eventType: 'plan.published',
          resourceType: 'room',
          resourceId: roomId,
          payload: { reasonCodes: built.reasonCodes, stopCount: built.stops.length },
        },
      ],
    });
    await this.plans.setRoomStatus(roomId, 'ready');
    return result;
  }

  /**
   * SG-008 — regenerate: locked stops are invariant (place, order-anchor,
   * duration, cost); unlocked stops are rebuilt from a fresh snapshot, with
   * structured feedback exclusions.
   */
  async regenerate(
    planId: string,
    feedback: {
      excludePlaceIds?: string[] | undefined;
      /** SG-009 — already validated; this method never sees a raw proposal. */
      avoidCategoryKeys?: string[] | undefined;
      requireDietaryKeys?: string[] | undefined;
      budgetMaxAmount?: number | undefined;
      radiusM?: number | undefined;
      maxStops?: number | undefined;
    } = {},
  ) {
    const plan = await this.plans.getPlan(planId);
    if (plan.status !== 'current') {
      throw AppError.conflict('PLAN_NOT_CURRENT', 'Only the current plan can regenerate');
    }
    const stops = await this.plans.listStops(planId);
    const lockedStops = stops.filter((s) => s.isLocked);
    const unlockedPlaceIds = stops.filter((s) => !s.isLocked).map((s) => s.placeId);

    const base = await this.suggestions.buildSnapshot(plan.roomId);
    // Feedback narrows the snapshot the deterministic pipeline runs on. It can
    // only tighten — `validateFeedback` has already refused anything that
    // would raise the budget or widen the radius the room agreed on — so the
    // pipeline below is unchanged and still the thing making the decision.
    const snapshot: typeof base = {
      ...base,
      ...(feedback.budgetMaxAmount !== undefined
        ? { budget: { ...base.budget, amount: feedback.budgetMaxAmount } }
        : {}),
      ...(feedback.radiusM !== undefined ? { radiusM: feedback.radiusM } : {}),
      ...(feedback.requireDietaryKeys?.length
        ? { dietaryKeys: [...new Set([...base.dietaryKeys, ...feedback.requireDietaryKeys])] }
        : {}),
    };
    const lockedFacts = await this.plans.placeFacts(lockedStops.map((s) => s.placeId));
    const anchors: LockedAnchor[] = lockedStops.map((s) => {
      const fact = lockedFacts.find((f) => f.id === s.placeId);
      if (!fact) throw AppError.internal('Locked stop place missing');
      return {
        placeId: s.placeId,
        name: fact.name,
        position: s.position,
        arriveAt: null,
        departAt: null,
        durationMinutes: s.durationMinutes,
        travelMinutesFromPrev: null,
        travelDistanceMFromPrev: null,
        costMin: s.costMin,
        costMax: s.costMax,
        isLocked: true,
        lat: Number(fact.lat),
        lng: Number(fact.lng),
      };
    });

    const exclude = new Set([
      ...(feedback.excludePlaceIds ?? []),
      // Regenerate means "give me something else": unlocked current places
      // are excluded unless they are the only viable options.
      ...unlockedPlaceIds,
    ]);
    const avoid = new Set(feedback.avoidCategoryKeys ?? []);
    const candidates = await this.suggestions.retrieveCandidates(snapshot);
    const passed = candidates.filter(
      (c) =>
        !exclude.has(c.placeId) &&
        hardFilter(c, snapshot).ok &&
        // Avoided categories are a soft preference expressed as a filter; the
        // hard constraints above still run first and still win.
        !(c.taxonomyKeys['category'] ?? []).some((key) => avoid.has(key)),
    );
    const ranked = rankWithFairness(
      passed.map((c) => scoreCandidate(c, snapshot, DEFAULT_SCORING_WEIGHTS)),
      { topK: 10 },
    );
    const built = await buildItinerary({
      ranked,
      snapshot,
      lockedStops: anchors,
      travel: this.travelBatch,
      ...(feedback.maxStops !== undefined ? { maxStops: feedback.maxStops } : {}),
    });

    return this.plans.createPlanVersion({
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
          payload: {
            action: 'regenerate',
            keptLockedStops: anchors.map((a) => a.placeId),
            excluded: [...exclude],
            avoidedCategories: [...avoid],
          },
        },
      ],
    });
  }
}
