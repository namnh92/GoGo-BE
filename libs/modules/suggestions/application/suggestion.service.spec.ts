import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../identity/domain/actor';
import type { RoomPolicy } from '../../rooms/presentation/room-policy';
import type { RoomsRepository } from '../../rooms/infrastructure/rooms.repository';
import type { PlanBuilderService } from '../../plans/application/plan-builder.service';
import type { RoomEventBus } from '../../realtime/application/room-event-bus';
import type { Db } from '@gogo/database';
import type { ExperimentsService } from './experiments.service';
import type { SuggestionsRepository } from '../infrastructure/suggestions.repository';
import { SuggestionService } from './suggestion.service';

describe('SuggestionService.current', () => {
  it('returns candidate scores and each active member vote status', async () => {
    const repo = {
      latestRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        createdAt: new Date('2026-11-05T00:00:00Z'),
        constraintVersion: 3,
        engineVersion: 'sg-1.0.0',
        weightsVersion: 'default',
      }),
      scoresForRun: vi.fn().mockResolvedValue([
        {
          placeId: 'place-1',
          name: 'One',
          rank: 1,
          scoreMicros: 920_000,
          components: {},
          reasonCodes: [],
          isStale: false,
        },
        {
          placeId: 'place-2',
          name: 'Two',
          rank: 2,
          scoreMicros: 750_000,
          components: {},
          reasonCodes: [],
          isStale: false,
        },
      ]),
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
        room: { decisionMode: 'vote' },
      }),
    };
    const roomsRepo = {
      listMembers: vi.fn().mockResolvedValue([
        { id: 'member-1', displayName: 'Lan' },
        { id: 'member-2', displayName: 'Minh' },
        { id: 'member-3', displayName: 'An' },
        { id: 'member-4', displayName: 'Binh' },
      ]),
    };
    const service = new SuggestionService(
      repo as unknown as SuggestionsRepository,
      roomsRepo as unknown as RoomsRepository,
      policy as unknown as RoomPolicy,
      {} as PlanBuilderService,
      {} as Db,
      {} as RoomEventBus,
      {} as ExperimentsService,
    );

    const result = await service.current(
      { type: 'user', id: 'user-1', sessionId: 'session-1' } satisfies Actor,
      'room-1',
    );

    expect(result.candidates).toEqual([
      expect.objectContaining({
        placeId: 'place-1',
        score: 0.92,
        matchScore: 0.92,
        likedByCount: 2,
      }),
      expect.objectContaining({
        placeId: 'place-2',
        score: 0.75,
        matchScore: 0.75,
        likedByCount: 0,
      }),
    ]);
    expect(result.votes.members).toEqual([
      { memberId: 'member-1', displayName: 'Lan', hasVoted: true },
      { memberId: 'member-2', displayName: 'Minh', hasVoted: true },
      { memberId: 'member-3', displayName: 'An', hasVoted: true },
      { memberId: 'member-4', displayName: 'Binh', hasVoted: false },
    ]);
    expect(roomsRepo.listMembers).toHaveBeenCalledOnce();
    expect(roomsRepo.listMembers).toHaveBeenCalledWith('room-1');
  });
});
