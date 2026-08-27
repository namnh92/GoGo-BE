import { describe, expect, it } from 'vitest';
import { coupleMatches, resolveWinner, tallyVotes } from './decision';
import { rankWithFairness } from './fairness';
import { hardFilter } from './hard-filter';
import { buildItinerary, type LockedAnchor } from './optimizer';
import { scoreCandidate } from './scoring';
import { DEFAULT_SCORING_WEIGHTS, type Candidate, type RoomSnapshot } from './types';

const fullDayHours = Array.from({ length: 7 }, (_, day) => ({
  dayOfWeek: day,
  openMinute: 8 * 60,
  closeMinute: 22 * 60,
  isOvernight: false,
}));

function candidate(partial: Partial<Candidate> & { placeId: string }): Candidate {
  return {
    name: partial.placeId,
    lat: 10.776,
    lng: 106.7,
    taxonomyKeys: { category: ['cafe'], mood: ['chill'] },
    suitability: { couple: 0.9, group: 0.8 },
    pricePerPersonMin: 50_000,
    pricePerPersonMax: 100_000,
    avgVisitMinutes: 90,
    rating: 4.4,
    ratingCount: 500,
    confidence: 0.9,
    freshnessDays: 5,
    hours: fullDayHours,
    isSeed: false,
    ...partial,
  };
}

function snapshot(partial?: Partial<RoomSnapshot>): RoomSnapshot {
  return {
    roomId: 'room-1',
    constraintVersion: 1,
    type: 'group',
    decisionMode: 'vote',
    participantCount: 4,
    budget: { mode: 'per_person', amount: 300_000, currency: 'VND' },
    timeWindow: { startAt: '2026-08-29T03:00:00Z', endAt: '2026-08-29T10:00:00Z' }, // 10:00-17:00 VN
    origin: { lat: 10.776, lng: 106.7 },
    radiusM: 5000,
    dietaryKeys: [],
    accessibilityKeys: [],
    memberPreferences: [
      { memberId: 'm1', selections: { mood: ['chill'] }, weights: null },
      { memberId: 'm2', selections: { mood: ['chill'] }, weights: null },
    ],
    seedPlaceIds: [],
    ...partial,
  };
}

describe('hard filter (SG-003)', () => {
  it('rejects out-of-area, out-of-budget, closed and dietary-unmet with reason codes', () => {
    const snap = snapshot({ dietaryKeys: ['vegetarian'] });
    const far = hardFilter(candidate({ placeId: 'far', lat: 11.5 }), snap);
    expect(far).toMatchObject({ ok: false });
    expect((far as { reasonCodes: string[] }).reasonCodes).toContain('OUT_OF_AREA');

    const pricey = hardFilter(
      candidate({
        placeId: 'pricey',
        pricePerPersonMin: 400_000,
        taxonomyKeys: { dietary: ['vegetarian'] },
      }),
      snap,
    );
    expect((pricey as { reasonCodes: string[] }).reasonCodes).toContain('OUT_OF_BUDGET');

    const nightOnly = hardFilter(
      candidate({
        placeId: 'night',
        taxonomyKeys: { dietary: ['vegetarian'] },
        hours: Array.from({ length: 7 }, (_, day) => ({
          dayOfWeek: day,
          openMinute: 22 * 60,
          closeMinute: 2 * 60,
          isOvernight: true,
        })),
      }),
      snap,
    );
    expect((nightOnly as { reasonCodes: string[] }).reasonCodes).toContain('CLOSED_DURING_WINDOW');

    const meatOnly = hardFilter(candidate({ placeId: 'meat' }), snap);
    expect((meatOnly as { reasonCodes: string[] }).reasonCodes).toContain('DIETARY_UNMET');

    const good = hardFilter(
      candidate({ placeId: 'good', taxonomyKeys: { category: ['cafe'], dietary: ['vegetarian'] } }),
      snap,
    );
    expect(good.ok).toBe(true);
  });
});

describe('scoring (SG-004)', () => {
  it('is deterministic and exposes explainable components', () => {
    const snap = snapshot();
    const c = candidate({ placeId: 'a' });
    const s1 = scoreCandidate(c, snap, DEFAULT_SCORING_WEIGHTS);
    const s2 = scoreCandidate(c, snap, DEFAULT_SCORING_WEIGHTS);
    expect(s1.score).toBe(s2.score);
    expect(s1.components).toEqual(s2.components);
    for (const key of ['preference', 'consensus', 'distance', 'budget', 'quality']) {
      expect(s1.components[key]).toBeGreaterThanOrEqual(0);
      expect(s1.components[key]).toBeLessThanOrEqual(1);
    }
    expect(s1.reasonCodes).toContain('MATCHES_PREFERENCES');
  });

  it('preference overlap beats non-overlap; seeds get boosted', () => {
    const snap = snapshot();
    const match = scoreCandidate(candidate({ placeId: 'm' }), snap, DEFAULT_SCORING_WEIGHTS);
    const noMatch = scoreCandidate(
      candidate({ placeId: 'n', taxonomyKeys: { category: ['bar'], mood: ['festive'] } }),
      snap,
      DEFAULT_SCORING_WEIGHTS,
    );
    expect(match.score).toBeGreaterThan(noMatch.score);

    const seed = scoreCandidate(
      candidate({ placeId: 's', isSeed: true }),
      snap,
      DEFAULT_SCORING_WEIGHTS,
    );
    expect(seed.score).toBeGreaterThan(match.score);
    expect(seed.reasonCodes).toContain('HOST_SUGGESTED');
  });
});

describe('fairness (SG-005)', () => {
  it('a minority member is represented in top-K (FR-SUG-003)', () => {
    const snap = snapshot({
      memberPreferences: [
        { memberId: 'a', selections: { mood: ['chill'] }, weights: null },
        { memberId: 'b', selections: { mood: ['chill'] }, weights: null },
        { memberId: 'c', selections: { mood: ['chill'] }, weights: null },
        { memberId: 'minority', selections: { mood: ['festive'] }, weights: null },
      ],
    });
    const chillCandidates = Array.from({ length: 5 }, (_, i) =>
      scoreCandidate(candidate({ placeId: `chill-${i}` }), snap, DEFAULT_SCORING_WEIGHTS),
    );
    const festive = scoreCandidate(
      candidate({
        placeId: 'festive-1',
        taxonomyKeys: { category: ['bar'], mood: ['festive'] },
        rating: 4.0,
      }),
      snap,
      DEFAULT_SCORING_WEIGHTS,
    );
    const ranked = rankWithFairness([...chillCandidates, festive], { topK: 4 });
    expect(ranked.map((r) => r.candidate.placeId)).toContain('festive-1');
  });

  it('diversity: identical category does not sweep the whole top-K', () => {
    const snap = snapshot();
    const cafes = Array.from({ length: 4 }, (_, i) =>
      scoreCandidate(candidate({ placeId: `cafe-${i}` }), snap, DEFAULT_SCORING_WEIGHTS),
    );
    const park = scoreCandidate(
      candidate({
        placeId: 'park-1',
        taxonomyKeys: { category: ['park'], mood: ['chill'] },
        rating: 4.1,
      }),
      snap,
      DEFAULT_SCORING_WEIGHTS,
    );
    const ranked = rankWithFairness([...cafes, park], { topK: 3 });
    expect(ranked.map((r) => r.candidate.placeId)).toContain('park-1');
  });
});

describe('optimizer (SG-007/SG-008)', () => {
  function ranked(snap: RoomSnapshot, ids: string[]) {
    return ids.map((id, i) =>
      scoreCandidate(
        candidate({
          placeId: id,
          lat: 10.776 + i * 0.002,
          taxonomyKeys: { category: [i % 2 === 0 ? 'cafe' : 'park'], mood: ['chill'] },
        }),
        snap,
        DEFAULT_SCORING_WEIGHTS,
      ),
    );
  }

  it('respects window duration and per-person budget; totals overBudget from upper bound', async () => {
    const snap = snapshot({ budget: { mode: 'per_person', amount: 150_000, currency: 'VND' } });
    const result = await buildItinerary({
      ranked: ranked(snap, ['a', 'b', 'c', 'd']),
      snapshot: snap,
    });
    expect(result.stops.length).toBeGreaterThan(0);
    expect(result.totals.costMax).toBeLessThanOrEqual(150_000);
    expect(result.totals.overBudget).toBe(false);
    // window 7h: duration fits
    expect(result.totals.durationMinutes).toBeLessThanOrEqual(7 * 60);
  });

  it('locked stops survive regenerate exactly (E2E gate #3)', async () => {
    const snap = snapshot();
    const locked: LockedAnchor = {
      placeId: 'locked-place',
      name: 'Locked Place',
      position: 0,
      arriveAt: null,
      departAt: null,
      durationMinutes: 60,
      travelMinutesFromPrev: null,
      travelDistanceMFromPrev: null,
      costMin: 80_000,
      costMax: 90_000,
      isLocked: true,
      lat: 10.777,
      lng: 106.701,
    };
    const result = await buildItinerary({
      ranked: ranked(snap, ['x', 'y', 'z']),
      snapshot: snap,
      lockedStops: [locked],
    });
    const first = result.stops[0]!;
    expect(first.placeId).toBe('locked-place');
    expect(first.isLocked).toBe(true);
    expect(first.durationMinutes).toBe(60);
    expect(first.costMax).toBe(90_000);
    expect(result.reasonCodes).toContain('KEPT_LOCKED_STOPS');
    // locked place never duplicated from the pool
    expect(result.stops.filter((s) => s.placeId === 'locked-place')).toHaveLength(1);
  });

  it('is deterministic', async () => {
    const snap = snapshot();
    const r1 = await buildItinerary({ ranked: ranked(snap, ['a', 'b', 'c']), snapshot: snap });
    const r2 = await buildItinerary({ ranked: ranked(snap, ['a', 'b', 'c']), snapshot: snap });
    expect(r1.stops.map((s) => s.placeId)).toEqual(r2.stops.map((s) => s.placeId));
    expect(r1.totals).toEqual(r2.totals);
  });
  it('asks once per greedy step, not once per leg, and only about the top candidates', async () => {
    const snap = snapshot();
    const calls: { origin: string; destinations: number }[] = [];
    const result = await buildItinerary({
      ranked: ranked(snap, ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
      snapshot: snap,
      travel: async (origin, destinations) => {
        calls.push({ origin: origin.placeId ?? 'room-origin', destinations: destinations.length });
        return {
          legs: destinations.map(() => ({ minutes: 7, distanceM: 700 })),
          estimated: false,
        };
      },
    });

    // One call per selection round — never one per candidate pair. A round may
    // batch and then find nothing that fits, which is why it can exceed the
    // stop count by one: whether a candidate fits is only knowable *after*
    // asking for its travel time.
    expect(calls.length).toBeLessThanOrEqual(result.stops.length + 1);
    expect(calls.length).toBeLessThan(7); // candidates offered

    // Each batch is capped: the greedy loop nearly always takes one of the
    // first few, so asking about all seven would pay for ranks that never win.
    expect(Math.max(...calls.map((c) => c.destinations))).toBeLessThanOrEqual(5);
    // First batch starts from the room origin, later ones from the stop chosen.
    expect(calls[0]!.origin).toBe('room-origin');
  });

  it('uses the routed legs it was given', async () => {
    const snap = snapshot();
    const result = await buildItinerary({
      ranked: ranked(snap, ['a', 'b']),
      snapshot: snap,
      travel: async (_o, destinations) => ({
        legs: destinations.map(() => ({ minutes: 33, distanceM: 3300 })),
        estimated: false,
      }),
    });
    const routed = result.stops.filter((s) => s.travelMinutesFromPrev !== null);
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every((s) => s.travelMinutesFromPrev === 33)).toBe(true);
    expect(result.totals.travelEstimated).toBe(false);
  });

  it('says so when a leg fell back to the straight-line estimate', async () => {
    const snap = snapshot();
    const result = await buildItinerary({
      ranked: ranked(snap, ['a', 'b', 'c']),
      snapshot: snap,
      // Provider answered nothing: the plan still builds, on estimates.
      travel: async (_o, destinations) => ({
        legs: destinations.map(() => ({ minutes: 0, distanceM: 0 })),
        estimated: true,
      }),
    });
    expect(result.stops.length).toBeGreaterThan(0);
    expect(result.totals.travelEstimated).toBe(true);
  });

  it('without a travel function behaves exactly as before', async () => {
    const snap = snapshot();
    const withoutTravel = await buildItinerary({
      ranked: ranked(snap, ['a', 'b']),
      snapshot: snap,
    });
    expect(withoutTravel.totals.travelEstimated).toBe(true);
    expect(withoutTravel.stops.length).toBeGreaterThan(0);
  });
});

describe('decision (SG-006)', () => {
  it('couple match requires every member to accept', () => {
    const votes = [
      { memberId: 'a', placeId: 'p1', value: 'yes' as const },
      { memberId: 'b', placeId: 'p1', value: 'star' as const },
      { memberId: 'a', placeId: 'p2', value: 'yes' as const },
    ];
    expect(coupleMatches(votes, ['a', 'b'])).toEqual(['p1']);
  });

  it('tally weights star=2 and resolves ties by candidate rank', () => {
    const votes = [
      { memberId: 'a', placeId: 'p1', value: 'star' as const },
      { memberId: 'b', placeId: 'p2', value: 'yes' as const },
      { memberId: 'c', placeId: 'p2', value: 'yes' as const },
      { memberId: 'd', placeId: 'p3', value: 'no' as const },
    ];
    const tally = tallyVotes(votes);
    expect(tally[0]!.points).toBe(2);
    const rank = new Map([
      ['p1', 2],
      ['p2', 1],
    ]);
    const result = resolveWinner(tally, rank);
    expect(result.tie).toBe(true);
    expect(result.winnerPlaceId).toBe('p2'); // better candidate rank wins the tie
  });
});
