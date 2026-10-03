import { budgetPerPerson } from '../../rooms/domain/budget';
import { AppError } from '../../shared/app-error';
import { haversineMeters } from './hard-filter';
import { aggregatePlanCosts, isRequiredOverBudget } from './plan-costs';
import type { PlanStopDraft, PlanTotalsDraft, RoomSnapshot, ScoredCandidate } from './types';

const TRAVEL_SPEED_M_PER_MIN = 400; // ~24 km/h urban incl. parking buffer
const TRAVEL_BUFFER_MIN = 10;
const DEFAULT_VISIT_MIN = 90;

export function travelEstimate(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): { minutes: number; distanceM: number } {
  const distanceM = Math.round(haversineMeters(from, to));
  return { minutes: Math.ceil(distanceM / TRAVEL_SPEED_M_PER_MIN) + TRAVEL_BUFFER_MIN, distanceM };
}

/**
 * ADR-0007 — one greedy step's worth of travel: the stop just chosen against
 * the candidates still in play. Injected rather than imported so the optimizer
 * stays a pure function of its inputs and the deterministic tests keep running
 * without a provider.
 */
export type TravelBatch = (
  origin: { lat: number; lng: number; placeId?: string | undefined },
  destinations: { lat: number; lng: number; placeId?: string | undefined }[],
) => Promise<{ legs: { minutes: number; distanceM: number }[]; estimated: boolean }>;

/**
 * How many candidates a step asks the provider about. The matrix is billed per
 * element, and the greedy loop nearly always takes one of the first few, so
 * asking about all ten would pay for ranks that never win (ADR-0007). Anything
 * past this falls back to the estimate.
 */
export const TRAVEL_BATCH_SIZE = 5;

/** Below this a stop's facts are not certain, and the plan totals say so. */
export const LOW_CONFIDENCE = 0.6;

/**
 * Anchor passed into the optimizer: full stop + its coordinates, plus its
 * place's data confidence (0..1). GoGo-BE#603 — required, so every caller that
 * builds an anchor has to say how sure the place's facts are.
 *
 * GoGo-BE#228 (ADR-0029) — an anchor is a stop the caller supplies, which is
 * not the same thing as a locked stop: a host edit supplies every stop and
 * says per stop whether it is locked. `isLocked` and `isOptional` are carried
 * through as given. A **locked** anchor that arrives with both `arriveAt` and
 * `departAt` keeps that stored schedule (regenerate); travel around it is
 * recalculated, and if it can no longer be reached in time the build fails
 * with `409 PLAN_TIME_CONFLICT` instead of moving it.
 */
export type LockedAnchor = PlanStopDraft & { lat: number; lng: number; confidence: number };

type SeqEntry = {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  durationMinutes: number;
  costMin: number | null;
  costMax: number | null;
  isLocked: boolean;
  isOptional: boolean;
  /** Stored schedule a locked anchor keeps (ADR-0029); null = scheduled here. */
  pinned: { arriveAt: Date; departAt: Date } | null;
  category: string | null;
  lowConfidence: boolean;
};

export type OptimizerResult = {
  stops: PlanStopDraft[];
  totals: PlanTotalsDraft;
  reasonCodes: string[];
};

/**
 * SG-007 — greedy itinerary builder over already-validated candidates.
 * Per-stop constraints: window duration, per-person budget accumulation,
 * travel time, consecutive-category diversity. Anchors (SG-008) keep their
 * place, order, duration, cost and optionality — never replaced; locked ones
 * also keep a stored schedule (ADR-0029). Optional anchors do not count
 * towards the budget the greedy fill works within.
 */
export async function buildItinerary(input: {
  ranked: ScoredCandidate[];
  snapshot: RoomSnapshot;
  lockedStops?: LockedAnchor[] | undefined;
  maxStops?: number | undefined;
  /** Absent → every leg is the straight-line estimate, as before ADR-0007. */
  travel?: TravelBatch | undefined;
}): Promise<OptimizerResult> {
  const { snapshot } = input;
  const anchors = [...(input.lockedStops ?? [])].sort((a, b) => a.position - b.position);
  const anchorIds = new Set(anchors.map((s) => s.placeId));

  const startAt = snapshot.timeWindow.startAt ? new Date(snapshot.timeWindow.startAt) : null;
  const endAt = snapshot.timeWindow.endAt ? new Date(snapshot.timeWindow.endAt) : null;
  const windowMinutes =
    startAt && endAt ? Math.round((endAt.getTime() - startAt.getTime()) / 60000) : 4 * 60;

  const perPersonBudget = budgetPerPerson(
    {
      mode: snapshot.budget.mode,
      amount: snapshot.budget.amount,
      currency: snapshot.budget.currency,
    },
    snapshot.participantCount,
  );

  const targetStops =
    input.maxStops ?? Math.max(1, Math.min(4, Math.floor(windowMinutes / 120) + 1));

  // Sequence starts with the anchors in order.
  const sequence: SeqEntry[] = anchors.map((s) => ({
    placeId: s.placeId,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    durationMinutes: s.durationMinutes,
    costMin: s.costMin,
    costMax: s.costMax,
    // GoGo-BE#228 — was `true` for every anchor, so a host edit that sent
    // `isLocked: false` stored a locked stop anyway.
    isLocked: s.isLocked,
    isOptional: s.isOptional,
    pinned:
      s.isLocked && s.arriveAt && s.departAt
        ? { arriveAt: s.arriveAt, departAt: s.departAt }
        : null,
    category: null,
    // GoGo-BE#593 — an anchor keeps the cost it was stored with, and `null`
    // means its place has no per-person price. Counting that as a confident 0
    // made a vote winner with no price read as a free plan.
    // GoGo-BE#603 — and the same confidence bar as a greedily picked stop: an
    // anchor is kept as it is, but how sure its facts are is not waived.
    lowConfidence: s.confidence < LOW_CONFIDENCE || s.costMin === null || s.costMax === null,
  }));
  // ADR-0029 — the greedy fill budgets against required spend only; an
  // optional anchor's price stays visible in the totals but is not a commitment.
  let costMax = sequence.reduce((a, s) => a + (s.isOptional ? 0 : (s.costMax ?? 0)), 0);
  let usedMinutes = sequence.reduce((a, s) => a + s.durationMinutes, 0);
  // A pinned anchor's stored departure is a floor on what the window has left:
  // greedy stops go after it, so the gap before it is spent too.
  const lastPinned = [...sequence].reverse().find((s) => s.pinned !== null)?.pinned ?? null;
  if (startAt && lastPinned) {
    usedMinutes = Math.max(
      usedMinutes,
      Math.ceil((lastPinned.departAt.getTime() - startAt.getTime()) / 60000),
    );
  }

  // F-06 — greedy stops are scheduled after the last pinned departure, so with
  // an `endAt` they must fit the time left from that departure, whether or not
  // the room has a start (the fallback window above knows nothing about it).
  const lastPinnedIndex = sequence.map((s) => s.pinned !== null).lastIndexOf(true);
  const tailBudgetMinutes =
    endAt && lastPinned
      ? Math.floor((endAt.getTime() - lastPinned.departAt.getTime()) / 60000)
      : null;
  let tailUsedMinutes = 0;
  for (let i = lastPinnedIndex + 1; i < sequence.length && lastPinnedIndex >= 0; i++) {
    tailUsedMinutes += travelEstimate(sequence[i - 1]!, sequence[i]!).minutes;
    tailUsedMinutes += sequence[i]!.durationMinutes;
  }

  const pool = input.ranked.filter((s) => !anchorIds.has(s.candidate.placeId));

  // Legs measured by the provider, keyed `from|to`. Everything not in here is
  // an estimate, and the plan says so.
  const measured = new Map<string, { minutes: number; distanceM: number }>();
  let anyEstimated = false;
  const legKey = (
    from: { placeId?: string | undefined; lat: number; lng: number },
    toPlaceId: string,
  ) => `${from.placeId ?? `${from.lat},${from.lng}`}|${toPlaceId}`;

  while (sequence.length < targetStops && pool.length > 0) {
    const last = sequence[sequence.length - 1];
    const lastPoint = last
      ? { lat: last.lat, lng: last.lng, placeId: last.placeId }
      : snapshot.origin;
    const lastCategory = last?.category ?? null;

    // One provider call per greedy step, covering the top candidates still in
    // play — four calls per plan instead of one per leg (ADR-0007).
    if (input.travel && lastPoint) {
      const batch = pool.slice(0, TRAVEL_BATCH_SIZE).map((s) => ({
        lat: s.candidate.lat,
        lng: s.candidate.lng,
        placeId: s.candidate.placeId,
      }));
      const result = await input.travel(lastPoint, batch);
      if (result.estimated) anyEstimated = true;
      batch.forEach((destination, i) => {
        const leg = result.legs[i];
        if (leg) measured.set(legKey(lastPoint, destination.placeId), leg);
      });
    }

    const legTo = (candidate: { placeId: string; lat: number; lng: number }) => {
      if (!lastPoint) return { minutes: 0, distanceM: 0 };
      const hit = measured.get(legKey(lastPoint, candidate.placeId));
      if (hit) return hit;
      anyEstimated = true;
      return travelEstimate(lastPoint, candidate);
    };

    let picked = -1;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!.candidate;
      const visit = c.avgVisitMinutes ?? DEFAULT_VISIT_MIN;
      const travel = legTo(c).minutes;
      if (usedMinutes + visit + travel > windowMinutes) continue;
      if (tailBudgetMinutes !== null && tailUsedMinutes + visit + travel > tailBudgetMinutes)
        continue;
      if (perPersonBudget > 0 && costMax + (c.pricePerPersonMax ?? 0) > perPersonBudget) continue;
      const category = (c.taxonomyKeys['category'] ?? [])[0] ?? null;
      if (category !== null && category === lastCategory && i + 1 < pool.length) continue;
      picked = i;
      break;
    }
    if (picked === -1) break;

    const s = pool.splice(picked, 1)[0]!;
    const c = s.candidate;
    const visit = c.avgVisitMinutes ?? DEFAULT_VISIT_MIN;
    const travel = legTo(c).minutes;
    usedMinutes += visit + travel;
    tailUsedMinutes += visit + travel;
    costMax += c.pricePerPersonMax ?? 0;
    sequence.push({
      placeId: c.placeId,
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      durationMinutes: visit,
      costMin: c.pricePerPersonMin,
      costMax: c.pricePerPersonMax,
      isLocked: false,
      // Generated stops are always required; only a host edit makes one optional.
      isOptional: false,
      pinned: null,
      category: (c.taxonomyKeys['category'] ?? [])[0] ?? null,
      lowConfidence: c.confidence < LOW_CONFIDENCE || c.pricePerPersonMax === null,
    });
  }

  // Materialize: times, travel legs, totals.
  const stops: PlanStopDraft[] = [];
  let cursor = startAt ? new Date(startAt) : null;
  let prevPoint: { lat: number; lng: number; placeId?: string | undefined } | null =
    snapshot.origin ?? null;
  let totalDistance = 0;
  let totalDuration = 0;
  let uncertain = false;

  sequence.forEach((entry, position) => {
    let travelMinutes: number | null = null;
    let travelDistance: number | null = null;
    if (prevPoint) {
      // Reuse the leg the selection already paid for; anything else — notably
      // the legs between locked anchors, which were never selected — falls back
      // to the estimate rather than buying a one-element matrix per pair.
      const hit = measured.get(legKey(prevPoint, entry.placeId));
      if (!hit) anyEstimated = true;
      const est = hit ?? travelEstimate(prevPoint, entry);
      travelMinutes = position === 0 && !snapshot.origin ? null : est.minutes;
      travelDistance = position === 0 && !snapshot.origin ? null : est.distanceM;
    }
    if (position === 0 && !snapshot.origin) {
      travelMinutes = null;
      travelDistance = null;
    }
    if (travelMinutes) {
      totalDuration += travelMinutes;
      totalDistance += travelDistance ?? 0;
      if (cursor) cursor = new Date(cursor.getTime() + travelMinutes * 60000);
    }

    let arriveAt: Date | null;
    let departAt: Date | null;
    if (entry.pinned) {
      // ADR-0029 — a locked stop keeps its stored schedule. Arriving early
      // means waiting; arriving late would move it, and that is refused here,
      // before anything is written, so the plan in place stays as it was.
      // F-01 — the kept interval must also be well-formed and fit the room's
      // *current* window: a host who shortened `endAt` past a locked stop must
      // get a conflict, not a fresh plan with an infeasible schedule.
      const pinArrive = entry.pinned.arriveAt.getTime();
      const pinDepart = entry.pinned.departAt.getTime();
      if (
        pinArrive > pinDepart ||
        (startAt && pinArrive < startAt.getTime()) ||
        (endAt && pinDepart > endAt.getTime()) ||
        (cursor && cursor.getTime() > pinArrive)
      ) {
        throw AppError.conflict(
          'PLAN_TIME_CONFLICT',
          'A locked stop no longer fits its scheduled time in the current window',
        );
      }
      arriveAt = new Date(entry.pinned.arriveAt);
      departAt = new Date(entry.pinned.departAt);
      // F-03 — a pinned departure is a fixed point in time even when the room
      // has no start: the clock starts here, so the travel into the next
      // pinned stop is still checked instead of silently skipped.
      cursor = new Date(departAt);
    } else {
      arriveAt = cursor ? new Date(cursor) : null;
      if (cursor) cursor = new Date(cursor.getTime() + entry.durationMinutes * 60000);
      departAt = cursor ? new Date(cursor) : null;
    }
    totalDuration += entry.durationMinutes;
    if (entry.lowConfidence) uncertain = true;

    stops.push({
      placeId: entry.placeId,
      name: entry.name,
      position,
      arriveAt,
      departAt,
      durationMinutes: entry.durationMinutes,
      travelMinutesFromPrev: travelMinutes,
      travelDistanceMFromPrev: travelDistance,
      costMin: entry.costMin,
      costMax: entry.costMax,
      isLocked: entry.isLocked,
      isOptional: entry.isOptional,
    });
    prevPoint = { lat: entry.lat, lng: entry.lng, placeId: entry.placeId };
  });

  const costs = aggregatePlanCosts(stops);
  // FR-SUG-006: over-budget flag comes from the UPPER bound — of the required
  // stops only (ADR-0029).
  const overBudget = isRequiredOverBudget(costs.requiredCostMax, perPersonBudget);
  // A generic "within budget" claim needs every stop, optional ones included,
  // to fit, and every price to be known: unknown is not free.
  const allStopsOver = perPersonBudget > 0 && costs.costMax > perPersonBudget;

  const reasonCodes: string[] = [];
  if (!overBudget && !allStopsOver && !uncertain) reasonCodes.push('WITHIN_BUDGET');
  if (uncertain) reasonCodes.push('PRICE_UNCERTAIN');
  if (anchors.some((a) => a.isLocked)) reasonCodes.push('KEPT_LOCKED_STOPS');

  return {
    stops,
    totals: {
      ...costs,
      currency: snapshot.budget.currency,
      durationMinutes: totalDuration,
      travelDistanceM: totalDistance,
      overBudget,
      uncertain,
      travelEstimated: anyEstimated,
    },
    reasonCodes,
  };
}
