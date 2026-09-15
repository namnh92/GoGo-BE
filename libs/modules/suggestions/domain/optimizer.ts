import { budgetPerPerson } from '../../rooms/domain/budget';
import { haversineMeters } from './hard-filter';
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

/** Locked anchor passed into regenerate: full stored stop + its coordinates. */
export type LockedAnchor = PlanStopDraft & { lat: number; lng: number };

type SeqEntry = {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  durationMinutes: number;
  costMin: number | null;
  costMax: number | null;
  isLocked: boolean;
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
 * travel time, consecutive-category diversity. Locked stops (SG-008) are
 * anchors: same place, same order, same duration/cost — never replaced.
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
  const locked = [...(input.lockedStops ?? [])].sort((a, b) => a.position - b.position);
  const lockedIds = new Set(locked.map((s) => s.placeId));

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

  // Sequence starts with locked anchors in order.
  const sequence: SeqEntry[] = locked.map((s) => ({
    placeId: s.placeId,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    durationMinutes: s.durationMinutes,
    costMin: s.costMin,
    costMax: s.costMax,
    isLocked: true,
    category: null,
    // GoGo-BE#593 — an anchor keeps the cost it was stored with, and `null`
    // means its place has no per-person price. Counting that as a confident 0
    // made a vote winner with no price read as a free plan.
    lowConfidence: s.costMin === null || s.costMax === null,
  }));
  let costMax = sequence.reduce((a, s) => a + (s.costMax ?? 0), 0);
  let usedMinutes = sequence.reduce((a, s) => a + s.durationMinutes, 0);

  const pool = input.ranked.filter((s) => !lockedIds.has(s.candidate.placeId));

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
      category: (c.taxonomyKeys['category'] ?? [])[0] ?? null,
      lowConfidence: c.confidence < 0.6 || c.pricePerPersonMax === null,
    });
  }

  // Materialize: times, travel legs, totals.
  const stops: PlanStopDraft[] = [];
  let cursor = startAt ? new Date(startAt) : null;
  let prevPoint: { lat: number; lng: number; placeId?: string | undefined } | null =
    snapshot.origin ?? null;
  let totalDistance = 0;
  let totalDuration = 0;
  let totalCostMin = 0;
  let totalCostMax = 0;
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

    const arriveAt = cursor ? new Date(cursor) : null;
    if (cursor) cursor = new Date(cursor.getTime() + entry.durationMinutes * 60000);
    const departAt = cursor ? new Date(cursor) : null;
    totalDuration += entry.durationMinutes;
    totalCostMin += entry.costMin ?? 0;
    totalCostMax += entry.costMax ?? 0;
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
    });
    prevPoint = { lat: entry.lat, lng: entry.lng, placeId: entry.placeId };
  });

  // FR-SUG-006: over-budget flag comes from the UPPER bound.
  const overBudget = perPersonBudget > 0 && totalCostMax > perPersonBudget;

  const reasonCodes: string[] = [];
  if (!overBudget) reasonCodes.push('WITHIN_BUDGET');
  if (uncertain) reasonCodes.push('PRICE_UNCERTAIN');
  if (locked.length > 0) reasonCodes.push('KEPT_LOCKED_STOPS');

  return {
    stops,
    totals: {
      costMin: totalCostMin,
      costMax: totalCostMax,
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
