import { describe, expect, it } from 'vitest';
import { InMemoryRoomEventBus } from '../../realtime/infrastructure/in-memory-room-event-bus';
import type { Candidate, RoomSnapshot } from '../../suggestions/domain/types';
import type { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import type { TravelTimeService } from '../../travel/application/travel-time.service';
import type { PlansRepository } from '../infrastructure/plans.repository';
import { PlanBuilderService } from './plan-builder.service';

/**
 * GoGo-BE#603 — the two builder paths that hand the optimizer an anchor must
 * carry the anchor place's confidence, or a low-confidence winner or locked
 * stop reads as certain. The pool is empty in both, so the anchor is the only
 * thing that can make the totals uncertain.
 */
const snapshot: RoomSnapshot = {
  roomId: 'room-603',
  constraintVersion: 1,
  type: 'group',
  decisionMode: 'vote',
  participantCount: 2,
  budget: { mode: 'per_person', amount: 500_000, currency: 'VND' },
  timeWindow: { startAt: '2026-08-29T03:00:00Z', endAt: '2026-08-29T10:00:00Z' },
  origin: { lat: 10.776, lng: 106.7 },
  radiusM: 5000,
  dietaryKeys: [],
  accessibilityKeys: [],
  memberPreferences: [],
  seedPlaceIds: [],
};

const winner: Candidate = {
  placeId: 'winner',
  name: 'Quán Chưa Chắc',
  lat: 10.777,
  lng: 106.701,
  taxonomyKeys: { category: ['cafe'] },
  suitability: { couple: 0.9, group: 0.9 },
  pricePerPersonMin: 80_000,
  pricePerPersonMax: 120_000,
  avgVisitMinutes: 90,
  rating: 4.4,
  ratingCount: 500,
  confidence: 0.4,
  freshnessDays: 1,
  hours: [],
  isSeed: false,
};

function builder(options: { candidates: Candidate[]; lockedConfidence?: string }) {
  const created: { totals: { uncertain: boolean }; stops: unknown[] }[] = [];
  const plans = {
    getPlan: async () => ({
      id: 'plan-1',
      roomId: snapshot.roomId,
      status: 'current',
      version: 1,
      generatedByRunId: null,
    }),
    listStops: async () => [
      {
        placeId: 'locked',
        position: 0,
        durationMinutes: 60,
        costMin: 80_000,
        costMax: 120_000,
        isLocked: true,
      },
    ],
    placeFacts: async () => [
      {
        id: 'locked',
        name: 'Chỗ Khóa',
        lat: 10.777,
        lng: 106.701,
        avg_visit_minutes: 60,
        status: 'published',
        price_min: '80000',
        price_max: '120000',
        confidence: options.lockedConfidence ?? '0.40',
      },
    ],
    createPlanVersion: async (input: { totals: { uncertain: boolean }; stops: unknown[] }) => {
      created.push(input);
      return { plan: { id: 'plan-2', version: 2 } };
    },
  } as unknown as PlansRepository;
  const suggestions = {
    buildSnapshot: async () => snapshot,
    retrieveCandidates: async () => options.candidates,
  } as unknown as SuggestionsRepository;
  const travel = {
    matrix: async () => ({ legs: [], estimated: true }),
  } as unknown as TravelTimeService;
  const service = new PlanBuilderService(plans, suggestions, travel, new InMemoryRoomEventBus());
  return { service, created };
}

describe('PlanBuilderService anchor confidence (GoGo-BE#603)', () => {
  it('a vote winner below 0.6 confidence makes the finalized plan uncertain', async () => {
    const { service, created } = builder({ candidates: [winner] });
    await service.buildAroundWinner(snapshot.roomId, 'winner');
    expect(created).toHaveLength(1);
    expect(created[0]!.stops).toHaveLength(1);
    expect(created[0]!.totals.uncertain).toBe(true);
  });

  it('a confident, priced winner keeps the plan certain', async () => {
    const { service, created } = builder({ candidates: [{ ...winner, confidence: 0.9 }] });
    await service.buildAroundWinner(snapshot.roomId, 'winner');
    expect(created[0]!.totals.uncertain).toBe(false);
  });

  it('a locked stop below 0.6 confidence keeps the regenerated plan uncertain', async () => {
    const { service, created } = builder({ candidates: [] });
    await service.regenerate('plan-1');
    expect(created[0]!.stops).toHaveLength(1);
    expect(created[0]!.totals.uncertain).toBe(true);
  });

  it('a confident locked stop keeps the regenerated plan certain', async () => {
    const { service, created } = builder({ candidates: [], lockedConfidence: '0.90' });
    await service.regenerate('plan-1');
    expect(created[0]!.totals.uncertain).toBe(false);
  });
});
