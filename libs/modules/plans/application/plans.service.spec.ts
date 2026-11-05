import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../identity/domain/actor';
import type { RoomPolicy } from '../../rooms/presentation/room-policy';
import type { RoomEventBus } from '../../realtime/application/room-event-bus';
import type { UploadsService } from '../../uploads/application/uploads.service';
import type { FeedbackService } from '../../suggestions/application/feedback.service';
import type { SuggestionsRepository } from '../../suggestions/infrastructure/suggestions.repository';
import type { PlansRepository } from '../infrastructure/plans.repository';
import type { PlanBuilderService } from './plan-builder.service';
import { PlansService } from './plans.service';

describe('PlansService plan DTO', () => {
  it('projects each stored next leg onto the preceding stop', async () => {
    const repo = {
      getPlan: vi.fn().mockResolvedValue({
        id: 'plan-1',
        roomId: 'room-1',
        version: 2,
        status: 'current',
        isStale: false,
        constraintVersion: 3,
        totals: {
          costMin: 0,
          costMax: 0,
          currency: 'VND',
          durationMinutes: 150,
          travelDistanceM: 4_200,
          overBudget: false,
          uncertain: false,
          travelEstimated: false,
        },
        createdAt: new Date('2026-11-05T00:00:00Z'),
      }),
      listStops: vi.fn().mockResolvedValue([
        {
          id: 'stop-1',
          planId: 'plan-1',
          placeId: 'place-1',
          position: 0,
          arriveAt: new Date('2026-11-05T10:00:00Z'),
          departAt: new Date('2026-11-05T11:00:00Z'),
          durationMinutes: 60,
          travelMinutesFromPrev: null,
          travelDistanceMFromPrev: null,
          costMin: 0,
          costMax: 0,
          isLocked: false,
          isOptional: false,
          status: 'planned',
          completedAt: null,
        },
        {
          id: 'stop-2',
          planId: 'plan-1',
          placeId: 'place-2',
          position: 1,
          arriveAt: new Date('2026-11-05T11:14:00Z'),
          departAt: new Date('2026-11-05T12:44:00Z'),
          durationMinutes: 90,
          travelMinutesFromPrev: 14,
          travelDistanceMFromPrev: 4_200,
          costMin: 0,
          costMax: 0,
          isLocked: false,
          isOptional: false,
          status: 'planned',
          completedAt: null,
        },
      ]),
      placeAvailability: vi.fn().mockResolvedValue(
        new Map([
          ['place-1', { status: 'published', providerStatus: 'active', confidence: 1 }],
          ['place-2', { status: 'published', providerStatus: 'active', confidence: 1 }],
        ]),
      ),
    };
    const policy = {
      requireMember: vi.fn().mockResolvedValue({ member: { id: 'member-1' } }),
    };
    const service = new PlansService(
      repo as unknown as PlansRepository,
      {} as SuggestionsRepository,
      {} as PlanBuilderService,
      policy as unknown as RoomPolicy,
      {} as RoomEventBus,
      {} as UploadsService,
      {} as FeedbackService,
    );

    const result = await service.getPlan(
      { type: 'user', id: 'user-1', sessionId: 'session-1' } satisfies Actor,
      'plan-1',
    );

    expect(result.stops).toEqual([
      expect.objectContaining({
        id: 'stop-1',
        travelMinutesToNext: 14,
        travelDistanceMToNext: 4_200,
      }),
      expect.objectContaining({
        id: 'stop-2',
        travelMinutesToNext: null,
        travelDistanceMToNext: null,
      }),
    ]);
  });
});
