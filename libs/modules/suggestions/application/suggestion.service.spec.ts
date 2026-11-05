import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../identity/domain/actor';
import type { RoomPolicy } from '../../rooms/presentation/room-policy';
import type { RoomsRepository } from '../../rooms/infrastructure/rooms.repository';
import type { PlanBuilderService } from '../../plans/application/plan-builder.service';
import type { RoomEventBus } from '../../realtime/application/room-event-bus';
import type { Db } from '@gogo/database';
import type { ExperimentsService } from './experiments.service';
import type { SuggestionsRepository } from '../infrastructure/suggestions.repository';
import { RedisRoutingReservation } from '../infrastructure/redis-routing-reservation';
import type { TravelTimeService } from '../../travel/application/travel-time.service';
import { SUGGESTION_ROUTE_BUDGET, SuggestionService } from './suggestion.service';
import type {
  RoutingReservation,
  RoutingReservationRequest,
  RoutingReservationResult,
} from './routing-reservation';

const actor = { type: 'user', id: 'user-1', sessionId: 'session-1' } satisfies Actor;
const snapshotOrigin = { lat: 10.7769, lng: 106.7009 };

class TestRoutingReservation implements RoutingReservation {
  private readonly rooms = new Map<string, number>();
  private readonly actors = new Map<string, number>();

  reserve(request: RoutingReservationRequest): Promise<RoutingReservationResult> {
    const roomCount = this.rooms.get(request.roomId) ?? 0;
    const actorCount = this.actors.get(request.actorKey) ?? 0;
    const roomExhausted = roomCount >= request.perRoom;
    const actorExhausted = actorCount >= request.perActor;
    if (roomExhausted || actorExhausted) {
      return Promise.resolve({
        ok: false,
        reason: roomExhausted && actorExhausted ? 'both' : roomExhausted ? 'room' : 'actor',
      });
    }
    this.rooms.set(request.roomId, roomCount + 1);
    this.actors.set(request.actorKey, actorCount + 1);
    return Promise.resolve({ ok: true });
  }
}

function harness(options?: {
  currentOrigin?: { lat: number | null; lng: number | null };
  routingReservation?: RoutingReservation;
  roomStatus?: 'matching' | 'completed';
}) {
  const scores = [
    {
      placeId: 'place-1',
      name: 'One',
      rank: 1,
      scoreMicros: 920_000,
      components: {},
      reasonCodes: [],
      isStale: false,
      lat: 10.7843,
      lng: 106.6844,
    },
    {
      placeId: 'place-2',
      name: 'Two',
      rank: 2,
      scoreMicros: 750_000,
      components: {},
      reasonCodes: [],
      isStale: false,
      lat: 10.7905,
      lng: 106.7019,
    },
  ];
  const repo = {
    latestRun: vi.fn().mockResolvedValue({
      id: 'run-1',
      createdAt: new Date('2026-11-05T00:00:00Z'),
      constraintVersion: 3,
      engineVersion: 'sg-1.0.0',
      weightsVersion: 'default',
      inputSnapshot: { origin: snapshotOrigin },
    }),
    scoresForRun: vi.fn().mockResolvedValue(scores),
    listVotes: vi.fn().mockResolvedValue([
      { memberId: 'member-1', targetPlaceId: 'place-1', value: 'yes' },
      { memberId: 'member-2', targetPlaceId: 'place-1', value: 'star' },
      { memberId: 'member-3', targetPlaceId: 'place-1', value: 'no' },
    ]),
    gogoRatingsForPlaceIds: vi.fn().mockResolvedValue(
      new Map([
        ['place-1', { gogoRatingCount: 0 }],
        ['place-2', { gogoRatingCount: 0 }],
      ]),
    ),
  };
  const policy = {
    requireMember: vi.fn().mockResolvedValue({
      member: { id: 'member-1' },
      room: {
        decisionMode: 'vote',
        constraintVersion: 3,
        status: options?.roomStatus ?? 'matching',
      },
    }),
  };
  const currentOrigin = options?.currentOrigin ?? snapshotOrigin;
  const roomsRepo = {
    getCurrentConstraint: vi.fn().mockResolvedValue({
      originLat: currentOrigin.lat,
      originLng: currentOrigin.lng,
    }),
    listMembers: vi.fn().mockResolvedValue([
      { id: 'member-1', displayName: 'Lan' },
      { id: 'member-2', displayName: 'Minh' },
      { id: 'member-3', displayName: 'An' },
      { id: 'member-4', displayName: 'Binh' },
    ]),
  };
  const travel = {
    matrix: vi.fn().mockResolvedValue({
      legs: [
        { minutes: 12, distanceM: 3_400 },
        { minutes: 18, distanceM: 5_600 },
      ],
      estimated: false,
    }),
    estimateMatrix: vi.fn().mockResolvedValue({
      legs: [
        { minutes: 14, distanceM: 3_100 },
        { minutes: 20, distanceM: 5_200 },
      ],
      estimated: true,
    }),
  };
  const routingReservation = options?.routingReservation ?? {
    reserve: vi.fn().mockResolvedValue({ ok: true }),
  };
  const service = new SuggestionService(
    repo as unknown as SuggestionsRepository,
    roomsRepo as unknown as RoomsRepository,
    policy as unknown as RoomPolicy,
    {} as PlanBuilderService,
    {} as Db,
    {} as RoomEventBus,
    {} as ExperimentsService,
    travel as unknown as TravelTimeService,
    routingReservation,
  );
  return { roomsRepo, travel, routingReservation, service };
}

describe('SuggestionService.current', () => {
  it('returns candidate scores, vote status and budgeted travel from the current origin', async () => {
    const { roomsRepo, travel, routingReservation, service } = harness();

    const result = await service.current(actor, 'room-1');

    expect(result.candidates).toEqual([
      expect.objectContaining({
        placeId: 'place-1',
        score: 0.92,
        matchScore: 0.92,
        likedByCount: 2,
        travelMinutesFromOrigin: 12,
        travelDistanceMFromOrigin: 3_400,
      }),
      expect.objectContaining({
        placeId: 'place-2',
        score: 0.75,
        matchScore: 0.75,
        likedByCount: 0,
        travelMinutesFromOrigin: 18,
        travelDistanceMFromOrigin: 5_600,
      }),
    ]);
    expect(result).toHaveProperty('travelEstimated', false);
    expect(result.votes.members).toEqual([
      { memberId: 'member-1', displayName: 'Lan', hasVoted: true },
      { memberId: 'member-2', displayName: 'Minh', hasVoted: true },
      { memberId: 'member-3', displayName: 'An', hasVoted: true },
      { memberId: 'member-4', displayName: 'Binh', hasVoted: false },
    ]);
    expect(roomsRepo.getCurrentConstraint).toHaveBeenCalledWith('room-1', 3);
    expect(roomsRepo.listMembers).toHaveBeenCalledWith('room-1');
    expect(routingReservation.reserve).toHaveBeenCalledWith({
      roomId: 'room-1',
      actorKey: 'user:user-1',
      ...SUGGESTION_ROUTE_BUDGET,
    });
    expect(travel.matrix).toHaveBeenCalledWith(snapshotOrigin, [
      { placeId: 'place-1', lat: 10.7843, lng: 106.6844 },
      { placeId: 'place-2', lat: 10.7905, lng: 106.7019 },
    ]);
    expect(travel.estimateMatrix).not.toHaveBeenCalled();
  });

  it('omits travel facts when privacy retention cleared the current origin', async () => {
    const { travel, routingReservation, service } = harness({
      currentOrigin: { lat: null, lng: null },
    });

    const result = await service.current(actor, 'room-1');

    expect(result).not.toHaveProperty('travelEstimated');
    for (const candidate of result.candidates) {
      expect(candidate).not.toHaveProperty('travelMinutesFromOrigin');
      expect(candidate).not.toHaveProperty('travelDistanceMFromOrigin');
    }
    expect(travel.matrix).not.toHaveBeenCalled();
    expect(travel.estimateMatrix).not.toHaveBeenCalled();
    expect(routingReservation.reserve).not.toHaveBeenCalled();
  });

  it('does not route a terminal room while its retention cleanup is pending', async () => {
    const { travel, routingReservation, service } = harness({ roomStatus: 'completed' });

    const result = await service.current(actor, 'room-1');

    expect(result).not.toHaveProperty('travelEstimated');
    expect(travel.matrix).not.toHaveBeenCalled();
    expect(travel.estimateMatrix).not.toHaveBeenCalled();
    expect(routingReservation.reserve).not.toHaveBeenCalled();
  });

  it('routes only one of two concurrent repeated reads and estimates the exhausted read', async () => {
    const { travel, service } = harness({
      routingReservation: new TestRoutingReservation(),
    });

    const [first, second] = await Promise.all([
      service.current(actor, 'room-1'),
      service.current(actor, 'room-1'),
    ]);

    expect(travel.matrix).toHaveBeenCalledOnce();
    expect(travel.estimateMatrix).toHaveBeenCalledOnce();
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ travelEstimated: false }),
        expect.objectContaining({ travelEstimated: true }),
      ]),
    );
    expect(first.candidates[0]).toHaveProperty('travelMinutesFromOrigin');
    expect(second.candidates[0]).toHaveProperty('travelMinutesFromOrigin');
  });

  it('bounds one actor across rooms independently of each room budget', async () => {
    const { travel, service } = harness({
      routingReservation: new TestRoutingReservation(),
    });

    const reads = [];
    for (let index = 0; index <= SUGGESTION_ROUTE_BUDGET.perActor; index += 1) {
      reads.push(await service.current(actor, `room-${index}`));
    }

    expect(travel.matrix).toHaveBeenCalledTimes(SUGGESTION_ROUTE_BUDGET.perActor);
    expect(travel.estimateMatrix).toHaveBeenCalledOnce();
    expect(reads.at(-1)).toHaveProperty('travelEstimated', true);
  });

  it('estimates on both service instances when shared budget enforcement is unavailable', async () => {
    const unavailable = {
      reserve: vi.fn().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    } satisfies RoutingReservation;
    const instanceA = harness({ routingReservation: unavailable });
    const instanceB = harness({ routingReservation: unavailable });

    const [resultA, resultB] = await Promise.all([
      instanceA.service.current(actor, 'room-1'),
      instanceB.service.current(actor, 'room-1'),
    ]);

    expect(unavailable.reserve).toHaveBeenCalledTimes(2);
    expect(instanceA.travel.matrix).not.toHaveBeenCalled();
    expect(instanceB.travel.matrix).not.toHaveBeenCalled();
    expect(instanceA.travel.estimateMatrix).toHaveBeenCalledOnce();
    expect(instanceB.travel.estimateMatrix).toHaveBeenCalledOnce();
    expect(resultA).toHaveProperty('travelEstimated', true);
    expect(resultB).toHaveProperty('travelEstimated', true);
  });

  it('returns estimates without calling Routes when Redis never answers the reservation', async () => {
    const redis = {
      eval: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const { service, travel } = harness({
      routingReservation: new RedisRoutingReservation(redis, undefined, { deadlineMs: 10 }),
    });

    const result = await service.current(actor, 'room-1');

    expect(redis.eval).toHaveBeenCalledOnce();
    expect(travel.matrix).not.toHaveBeenCalled();
    expect(travel.estimateMatrix).toHaveBeenCalledOnce();
    expect(result).toHaveProperty('travelEstimated', true);
  });

  it('ignores a Redis admission that arrives after the reservation deadline', async () => {
    let grant!: (result: unknown) => void;
    const redis = {
      eval: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            grant = resolve;
          }),
      ),
    };
    const { service, travel } = harness({
      routingReservation: new RedisRoutingReservation(redis, undefined, { deadlineMs: 10 }),
    });

    const result = await service.current(actor, 'room-1');
    grant([1, 0, 0]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toHaveProperty('travelEstimated', true);
    expect(travel.matrix).not.toHaveBeenCalled();
    expect(travel.estimateMatrix).toHaveBeenCalledOnce();
  });
});
