import { describe, expect, it } from 'vitest';
import { InMemoryRoomEventBus } from '../../realtime/infrastructure/in-memory-room-event-bus';
import type { Candidate, RoomSnapshot } from '../../suggestions/domain/types';
import type { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import type { TravelTimeService } from '../../travel/application/travel-time.service';
import type { PlansRepository } from '../infrastructure/plans.repository';
import { PlanBuilderService } from './plan-builder.service';

/**
 * GoGo-BE#228 (ADR-0029) — regenerate keeps every locked stop's optionality and
 * stored schedule, replaces unlocked stops with required ones, publishes only
 * over the plan it read, and commits nothing when a locked stop cannot keep
 * its time.
 */
const snapshot: RoomSnapshot = {
  roomId: 'room-228',
  constraintVersion: 3,
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

const fresh: Candidate = {
  placeId: 'fresh',
  name: 'Mới',
  lat: 10.78,
  lng: 106.703,
  taxonomyKeys: { category: ['park'] },
  suitability: { couple: 0.9, group: 0.9 },
  pricePerPersonMin: 10_000,
  pricePerPersonMax: 20_000,
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
};

type Stop = {
  id: string;
  placeId: string;
  position: number;
  arriveAt: Date | null;
  departAt: Date | null;
  durationMinutes: number;
  costMin: number | null;
  costMax: number | null;
  isLocked: boolean;
  isOptional: boolean;
};

function builder(stops: Stop[]) {
  const created: {
    stops: { placeId: string; isOptional: boolean; isLocked: boolean; arriveAt: Date | null }[];
    guard?: unknown;
  }[] = [];
  const plans = {
    getPlan: async () => ({
      id: 'plan-1',
      roomId: snapshot.roomId,
      status: 'current',
      version: 4,
      generatedByRunId: null,
    }),
    listStops: async () => stops,
    placeFacts: async (ids: string[]) =>
      ids.map((id, i) => ({
        id,
        name: id,
        lat: 10.777 + i * 0.001,
        lng: 106.701,
        avg_visit_minutes: 60,
        status: 'published',
        price_min: '10000',
        price_max: '20000',
        confidence: '0.90',
      })),
    createPlanVersion: async (input: (typeof created)[number]) => {
      created.push(input);
      return { plan: { id: 'plan-2', version: 5 }, stops: [] };
    },
  } as unknown as PlansRepository;
  const suggestions = {
    buildSnapshot: async () => snapshot,
    retrieveCandidates: async () => [fresh],
  } as unknown as SuggestionsRepository;
  const travel = {
    matrix: async () => ({ legs: [], estimated: true }),
  } as unknown as TravelTimeService;
  return {
    service: new PlanBuilderService(plans, suggestions, travel, new InMemoryRoomEventBus()),
    created,
  };
}

const stop = (partial: Partial<Stop> & { id: string; placeId: string }): Stop => ({
  position: 0,
  arriveAt: null,
  departAt: null,
  durationMinutes: 60,
  costMin: 10_000,
  costMax: 20_000,
  isLocked: false,
  isOptional: false,
  ...partial,
});

describe('PlanBuilderService.regenerate with optional stops (ADR-0029)', () => {
  it('keeps a locked optional stop optional, at its stored time; replacements are required', async () => {
    const { service, created } = builder([
      stop({ id: 's0', placeId: 'gone', position: 0, isOptional: true }),
      stop({
        id: 's1',
        placeId: 'kept',
        position: 1,
        isLocked: true,
        isOptional: true,
        arriveAt: new Date('2026-08-29T05:00:00Z'),
        departAt: new Date('2026-08-29T06:00:00Z'),
      }),
    ]);
    await service.regenerate('plan-1');
    expect(created).toHaveLength(1);
    const out = created[0]!.stops;
    const kept = out.find((s) => s.placeId === 'kept')!;
    expect(kept).toMatchObject({ isLocked: true, isOptional: true });
    expect(kept.arriveAt?.toISOString()).toBe('2026-08-29T05:00:00.000Z');
    expect(out.some((s) => s.placeId === 'gone')).toBe(false);
    expect(out.find((s) => s.placeId === 'fresh')?.isOptional).toBe(false);
  });

  it('publishes with a guard naming the plan, version, constraint version and flags it read', async () => {
    const { service, created } = builder([
      stop({ id: 's0', placeId: 'a', isLocked: true, isOptional: false }),
      stop({ id: 's1', placeId: 'b', position: 1, isOptional: true }),
    ]);
    await service.regenerate('plan-1');
    expect(created[0]!.guard).toEqual({
      sourcePlanId: 'plan-1',
      sourceVersion: 4,
      constraintVersion: 3,
      forbiddenRoomStatuses: ['active', 'completed'],
      requireFresh: false,
      stopFlags: [
        { id: 's0', isLocked: true, isOptional: false },
        { id: 's1', isLocked: false, isOptional: true },
      ],
    });
  });

  it('commits nothing when a locked stop can no longer keep its stored time', async () => {
    const { service, created } = builder([
      stop({
        id: 's0',
        placeId: 'early',
        isLocked: true,
        arriveAt: new Date('2026-08-29T02:00:00Z'),
        departAt: new Date('2026-08-29T03:00:00Z'),
      }),
    ]);
    await expect(service.regenerate('plan-1')).rejects.toMatchObject({
      code: 'PLAN_TIME_CONFLICT',
    });
    expect(created).toHaveLength(0);
  });

  it('never drops a locked stop for a reduced stop limit', async () => {
    const { service, created } = builder([
      stop({ id: 's0', placeId: 'l1', isLocked: true }),
      stop({ id: 's1', placeId: 'l2', position: 1, isLocked: true, isOptional: true }),
    ]);
    await service.regenerate('plan-1', { maxStops: 1, excludePlaceIds: ['l1', 'l2'] });
    expect(created[0]!.stops.map((s) => s.placeId)).toEqual(['l1', 'l2']);
  });
});
