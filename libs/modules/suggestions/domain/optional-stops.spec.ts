import { describe, expect, it } from 'vitest';
import { buildItinerary, type LockedAnchor } from './optimizer';
import { aggregatePlanCosts, normalizeStoredTotals } from './plan-costs';
import { scoreCandidate } from './scoring';
import { DEFAULT_SCORING_WEIGHTS, type Candidate, type RoomSnapshot } from './types';

/**
 * GoGo-BE#228 (ADR-0029) — optional stops: cost split, required-only budget,
 * anchors vs locks, and locked schedules kept through regenerate.
 */

function snapshot(partial?: Partial<RoomSnapshot>): RoomSnapshot {
  return {
    roomId: 'room-228',
    constraintVersion: 1,
    type: 'group',
    decisionMode: 'vote',
    participantCount: 4,
    budget: { mode: 'per_person', amount: 300_000, currency: 'VND' },
    timeWindow: { startAt: '2026-08-29T03:00:00Z', endAt: '2026-08-29T10:00:00Z' },
    origin: { lat: 10.776, lng: 106.7 },
    radiusM: 5000,
    dietaryKeys: [],
    accessibilityKeys: [],
    memberPreferences: [{ memberId: 'm1', selections: { mood: ['chill'] }, weights: null }],
    seedPlaceIds: [],
    ...partial,
  };
}

function anchor(partial: Partial<LockedAnchor> & { placeId: string }): LockedAnchor {
  return {
    name: partial.placeId,
    position: 0,
    arriveAt: null,
    departAt: null,
    durationMinutes: 60,
    travelMinutesFromPrev: null,
    travelDistanceMFromPrev: null,
    costMin: 50_000,
    costMax: 100_000,
    isLocked: false,
    isOptional: false,
    lat: 10.777,
    lng: 106.701,
    confidence: 0.9,
    ...partial,
  };
}

function candidate(partial: Partial<Candidate> & { placeId: string }): Candidate {
  return {
    name: partial.placeId,
    lat: 10.778,
    lng: 106.702,
    taxonomyKeys: { category: ['park'], mood: ['chill'] },
    suitability: { couple: 0.9, group: 0.9 },
    pricePerPersonMin: 50_000,
    pricePerPersonMax: 100_000,
    avgVisitMinutes: 60,
    rating: 4.4,
    ratingCount: 500,
    confidence: 0.9,
    freshnessDays: 1,
    hours: Array.from({ length: 7 }, (_, day) => ({
      dayOfWeek: day,
      openMinute: 0,
      closeMinute: 24 * 60 - 1,
      isOvernight: false,
    })),
    isSeed: false,
    ...partial,
  };
}

describe('aggregatePlanCosts (ADR-0029)', () => {
  it('splits a mixed plan and keeps costMin/costMax as the all-stop sums', () => {
    const totals = aggregatePlanCosts([
      { costMin: 50_000, costMax: 100_000, isOptional: false },
      { costMin: 20_000, costMax: 40_000, isOptional: true },
      { costMin: 0, costMax: 0, isOptional: false },
    ]);
    expect(totals).toEqual({
      costMin: 70_000,
      costMax: 140_000,
      requiredCostMin: 50_000,
      requiredCostMax: 100_000,
      optionalCostMin: 20_000,
      optionalCostMax: 40_000,
    });
  });

  it('an all-optional plan has zero required cost; an all-required one zero optional', () => {
    const optional = aggregatePlanCosts([{ costMin: 10, costMax: 20, isOptional: true }]);
    expect(optional.requiredCostMax).toBe(0);
    expect(optional.optionalCostMax).toBe(20);
    expect(optional.costMax).toBe(20);
    const required = aggregatePlanCosts([{ costMin: 10, costMax: 20, isOptional: false }]);
    expect(required.optionalCostMax).toBe(0);
    expect(required.requiredCostMax).toBe(20);
  });

  it('an unknown price adds nothing to either side (the caller marks it uncertain)', () => {
    const totals = aggregatePlanCosts([
      { costMin: null, costMax: null, isOptional: true },
      { costMin: null, costMax: null, isOptional: false },
    ]);
    expect(totals.costMax).toBe(0);
    expect(totals.requiredCostMax).toBe(0);
    expect(totals.optionalCostMax).toBe(0);
  });

  it('reads a legacy totals object as all required, without rewriting it', () => {
    const legacy = { costMin: 70_000, costMax: 140_000, currency: 'VND' };
    expect(normalizeStoredTotals(legacy)).toMatchObject({
      costMin: 70_000,
      costMax: 140_000,
      requiredCostMin: 70_000,
      requiredCostMax: 140_000,
      optionalCostMin: 0,
      optionalCostMax: 0,
    });
    expect(legacy).not.toHaveProperty('requiredCostMax');
  });
});

describe('optimizer anchors are not locks (FAIL-before: optimizer.ts:109)', () => {
  it('an explicitly unlocked anchor stays unlocked', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [anchor({ placeId: 'a', isLocked: false })],
      maxStops: 1,
    });
    expect(result.stops[0]!.isLocked).toBe(false);
    expect(result.reasonCodes).not.toContain('KEPT_LOCKED_STOPS');
  });

  it('keeps all four optional/locked combinations exactly as supplied', async () => {
    const combos = [
      { isLocked: false, isOptional: false },
      { isLocked: false, isOptional: true },
      { isLocked: true, isOptional: false },
      { isLocked: true, isOptional: true },
    ];
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot({ budget: { mode: 'per_person', amount: 0, currency: 'VND' } }),
      lockedStops: combos.map((c, i) =>
        anchor({ placeId: `p${i}`, position: i, lat: 10.777 + i * 0.001, ...c }),
      ),
      maxStops: 4,
    });
    expect(result.stops.map((s) => ({ isLocked: s.isLocked, isOptional: s.isOptional }))).toEqual(
      combos,
    );
  });

  it('a greedily added stop is always required', async () => {
    const snap = snapshot();
    const result = await buildItinerary({
      ranked: [scoreCandidate(candidate({ placeId: 'fresh' }), snap, DEFAULT_SCORING_WEIGHTS)],
      snapshot: snap,
      lockedStops: [anchor({ placeId: 'opt', isOptional: true, isLocked: true })],
      maxStops: 2,
    });
    expect(result.stops.find((s) => s.placeId === 'fresh')?.isOptional).toBe(false);
  });
});

describe('required-only budget (ADR-0029)', () => {
  it('an optional stop over the budget does not make the plan over budget', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [
        anchor({ placeId: 'req', position: 0, costMin: 100_000, costMax: 200_000 }),
        anchor({
          placeId: 'opt',
          position: 1,
          costMin: 100_000,
          costMax: 250_000,
          isOptional: true,
          lat: 10.778,
        }),
      ],
      maxStops: 2,
    });
    expect(result.totals).toMatchObject({
      costMin: 200_000,
      costMax: 450_000,
      requiredCostMin: 100_000,
      requiredCostMax: 200_000,
      optionalCostMin: 100_000,
      optionalCostMax: 250_000,
      overBudget: false,
    });
    // The all-stop upper estimate is over: no generic "within budget" claim.
    expect(result.reasonCodes).not.toContain('WITHIN_BUDGET');
  });

  it('required stops over the budget are over budget, whatever is optional', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [anchor({ placeId: 'req', costMin: 200_000, costMax: 350_000 })],
      maxStops: 1,
    });
    expect(result.totals.overBudget).toBe(true);
  });

  it('an unknown price suppresses WITHIN_BUDGET (FAIL-before: claimed while uncertain)', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [anchor({ placeId: 'x', costMin: null, costMax: null })],
      maxStops: 1,
    });
    expect(result.totals.uncertain).toBe(true);
    expect(result.totals.overBudget).toBe(false);
    expect(result.reasonCodes).not.toContain('WITHIN_BUDGET');
  });

  it('a known free plan within budget still says WITHIN_BUDGET', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [anchor({ placeId: 'free', costMin: 0, costMax: 0 })],
      maxStops: 1,
    });
    expect(result.reasonCodes).toContain('WITHIN_BUDGET');
  });

  it('uses the shared N-member conversion: total 1,000,000 for 3 → 333,333 each', async () => {
    const snap = snapshot({
      participantCount: 3,
      budget: { mode: 'total', amount: 1_000_000, currency: 'VND' },
    });
    const at = (costMax: number) =>
      buildItinerary({
        ranked: [],
        snapshot: snap,
        lockedStops: [anchor({ placeId: 'r', costMin: 0, costMax })],
        maxStops: 1,
      });
    expect((await at(333_333)).totals.overBudget).toBe(false);
    expect((await at(333_334)).totals.overBudget).toBe(true);
  });

  it('an optional anchor does not eat the budget the greedy fill works within', async () => {
    const snap = snapshot();
    const result = await buildItinerary({
      ranked: [
        scoreCandidate(
          candidate({ placeId: 'fill', pricePerPersonMin: 50_000, pricePerPersonMax: 100_000 }),
          snap,
          DEFAULT_SCORING_WEIGHTS,
        ),
      ],
      snapshot: snap,
      lockedStops: [anchor({ placeId: 'opt', isOptional: true, isLocked: true, costMax: 250_000 })],
      maxStops: 2,
    });
    expect(result.stops.map((s) => s.placeId)).toEqual(['opt', 'fill']);
    expect(result.totals.overBudget).toBe(false);
  });

  it('duration, distance and schedule include optional stops', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [
        anchor({ placeId: 'req', position: 0, durationMinutes: 60 }),
        anchor({
          placeId: 'opt',
          position: 1,
          durationMinutes: 45,
          isOptional: true,
          lat: 10.79,
          lng: 106.71,
        }),
      ],
      maxStops: 2,
    });
    const travel = result.stops.reduce((a, s) => a + (s.travelMinutesFromPrev ?? 0), 0);
    expect(result.totals.durationMinutes).toBe(60 + 45 + travel);
    expect(result.stops[1]!.travelDistanceMFromPrev).toBeGreaterThan(0);
    expect(result.totals.travelDistanceM).toBe(
      result.stops.reduce((a, s) => a + (s.travelDistanceMFromPrev ?? 0), 0),
    );
    expect(result.stops[1]!.arriveAt).not.toBeNull();
  });
});

describe('locked stops keep their stored schedule (FAIL-before)', () => {
  const at = (iso: string) => new Date(iso);

  it('a locked noninitial stop keeps its stored arrive/depart times', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [
        anchor({
          placeId: 'first',
          position: 0,
          isLocked: true,
          arriveAt: at('2026-08-29T03:20:00Z'),
          departAt: at('2026-08-29T04:20:00Z'),
        }),
        anchor({
          placeId: 'later',
          position: 2,
          isLocked: true,
          isOptional: true,
          lat: 10.779,
          arriveAt: at('2026-08-29T06:00:00Z'),
          departAt: at('2026-08-29T07:00:00Z'),
        }),
      ],
      maxStops: 2,
    });
    const later = result.stops.find((s) => s.placeId === 'later')!;
    expect(later.arriveAt?.toISOString()).toBe('2026-08-29T06:00:00.000Z');
    expect(later.departAt?.toISOString()).toBe('2026-08-29T07:00:00.000Z');
    expect(later.isOptional).toBe(true);
    // Travel into it is recalculated, not frozen.
    expect(later.travelMinutesFromPrev).toBeGreaterThan(0);
  });

  it('a locked stop that can no longer be reached in time fails with PLAN_TIME_CONFLICT', async () => {
    await expect(
      buildItinerary({
        ranked: [],
        snapshot: snapshot(),
        lockedStops: [
          anchor({
            placeId: 'first',
            position: 0,
            isLocked: true,
            // Before the window even starts plus travel from the origin.
            arriveAt: at('2026-08-29T02:00:00Z'),
            departAt: at('2026-08-29T03:00:00Z'),
          }),
        ],
        maxStops: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_TIME_CONFLICT', httpStatus: 409 });
  });

  it('a locked stop ending after the current window end fails with PLAN_TIME_CONFLICT (F-01)', async () => {
    await expect(
      buildItinerary({
        ranked: [],
        // Host shortened the window to end at 08:00Z; the stop is stored until 09:00Z.
        snapshot: snapshot({
          timeWindow: { startAt: '2026-08-29T03:00:00Z', endAt: '2026-08-29T08:00:00Z' },
        }),
        lockedStops: [
          anchor({
            placeId: 'late',
            isLocked: true,
            arriveAt: at('2026-08-29T08:00:00Z'),
            departAt: at('2026-08-29T09:00:00Z'),
          }),
        ],
        maxStops: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_TIME_CONFLICT', httpStatus: 409 });
  });

  it('a locked stop whose stored departure precedes its arrival fails with PLAN_TIME_CONFLICT (F-01)', async () => {
    await expect(
      buildItinerary({
        ranked: [],
        snapshot: snapshot(),
        lockedStops: [
          anchor({
            placeId: 'inverted',
            isLocked: true,
            arriveAt: at('2026-08-29T06:00:00Z'),
            departAt: at('2026-08-29T05:00:00Z'),
          }),
        ],
        maxStops: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_TIME_CONFLICT', httpStatus: 409 });
  });

  it('with startAt cleared, travel between locked stops still conflicts (F-03)', async () => {
    await expect(
      buildItinerary({
        ranked: [],
        snapshot: snapshot({ timeWindow: { startAt: null, endAt: null } }),
        lockedStops: [
          anchor({
            placeId: 'a',
            position: 0,
            isLocked: true,
            arriveAt: at('2026-08-29T05:00:00Z'),
            departAt: at('2026-08-29T06:00:00Z'),
          }),
          anchor({
            placeId: 'b',
            position: 1,
            isLocked: true,
            lat: 10.79,
            lng: 106.71,
            // Zero gap: any travel from `a` makes this unreachable.
            arriveAt: at('2026-08-29T06:00:00Z'),
            departAt: at('2026-08-29T07:00:00Z'),
          }),
        ],
        maxStops: 2,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_TIME_CONFLICT', httpStatus: 409 });
  });

  it('an unlocked anchor with stored times is rescheduled, not pinned', async () => {
    const result = await buildItinerary({
      ranked: [],
      snapshot: snapshot(),
      lockedStops: [
        anchor({
          placeId: 'free',
          isLocked: false,
          arriveAt: at('2026-08-29T02:00:00Z'),
          departAt: at('2026-08-29T03:00:00Z'),
        }),
      ],
      maxStops: 1,
    });
    expect(result.stops[0]!.arriveAt!.getTime()).toBeGreaterThan(
      at('2026-08-29T03:00:00Z').getTime(),
    );
  });
});
