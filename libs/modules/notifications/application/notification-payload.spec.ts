import { describe, expect, it } from 'vitest';
import { notificationFacts } from './notification-payload';
import { roomStartedFacts } from '../../shared/notification-event-facts';

const members = [
  { id: 'host-member', displayName: 'Minh Triet', selectionStatus: 'completed' },
  { id: 'guest-member', displayName: 'Lan', selectionStatus: 'in_progress' },
];

describe('notificationFacts (#753)', () => {
  it('projects event-time facts without rebuilding them from changed live values', () => {
    const reminder = roomStartedFacts('2026-11-09T10:00:00Z', null);
    const context = {
      roomName: null,
      members,
      currentPlanCounts: { stopCount: 99, optionalStopCount: 0 },
      eventPayload: { notificationFacts: { reminder } },
    };
    expect(notificationFacts('date_reminder', context)).toEqual({ reminder });
    expect(notificationFacts('date_reminder', { ...context, eventPayload: {} })).toEqual({});
    expect(
      notificationFacts('invite', {
        ...context,
        eventPayload: {
          inviterMemberId: 'host-member',
          notificationFacts: { inviterName: 'Event-time name' },
        },
      }),
    ).toEqual({ inviterName: 'Event-time name' });
    expect(
      notificationFacts('invite', {
        ...context,
        eventPayload: { inviterMemberId: 'host-member', notificationFacts: {} },
      }),
    ).toEqual({});
  });
  it('returns the room and inviter facts for invite notifications', () => {
    expect(
      notificationFacts('invite', {
        roomName: 'Keo ca phe thu bay',
        members,
        currentPlanCounts: null,
        eventPayload: { inviterMemberId: 'host-member' },
      }),
    ).toEqual({ roomName: 'Keo ca phe thu bay', inviterName: 'Minh Triet' });
  });

  it('returns aggregate completion progress without private preferences', () => {
    expect(
      notificationFacts('preference_reminder', {
        roomName: 'An toi Quan 1',
        members,
        currentPlanCounts: null,
        eventPayload: { memberId: 'guest-member' },
      }),
    ).toEqual({
      roomName: 'An toi Quan 1',
      preferenceProgress: { completedCount: 1, memberCount: 2 },
    });
  });

  it('returns the current plan stop count for a ready plan', () => {
    expect(
      notificationFacts('plan_ready', {
        roomName: 'Saigon Chillers',
        members,
        currentPlanCounts: { stopCount: 3, optionalStopCount: 1 },
        eventPayload: { stopCount: 2 },
      }),
    ).toEqual({ roomName: 'Saigon Chillers', stopCount: 3 });
  });

  it('keeps zero as the stop count for an empty current plan', () => {
    expect(
      notificationFacts('plan_ready', {
        roomName: null,
        members: [],
        currentPlanCounts: { stopCount: 0, optionalStopCount: 0 },
        eventPayload: {},
      }),
    ).toEqual({ stopCount: 0 });
  });

  it('returns structured change facts instead of composed copy', () => {
    expect(
      notificationFacts('plan_changed', {
        roomName: 'Date cuoi tuan',
        members,
        currentPlanCounts: { stopCount: 9, optionalStopCount: 8 },
        eventPayload: {
          action: 'regenerate',
          stopCount: 4,
          optionalStopCount: 1,
          addedStopCount: 2,
          removedStopCount: 3,
          movedStopCount: 1,
          durationChangedStopCount: 0,
          lockChangedStopCount: 0,
          optionalChangedStopCount: 0,
          excluded: ['place-id'],
        },
      }),
    ).toEqual({
      roomName: 'Date cuoi tuan',
      planChange: {
        action: 'regenerate',
        stopCount: 4,
        optionalStopCount: 1,
        addedStopCount: 2,
        removedStopCount: 3,
        movedStopCount: 1,
        durationChangedStopCount: 0,
        lockChangedStopCount: 0,
        optionalChangedStopCount: 0,
      },
    });
  });

  it('does not mix a legacy event count with counts from a newer plan', () => {
    expect(
      notificationFacts('plan_changed', {
        roomName: null,
        members: [],
        currentPlanCounts: { stopCount: 7, optionalStopCount: 6 },
        eventPayload: { action: 'regenerate', optionalStopCount: 1 },
      }),
    ).toEqual({ planChange: { action: 'regenerate', optionalStopCount: 1 } });
  });

  it('falls back to both counts from the current plan for an older count-less event', () => {
    expect(
      notificationFacts('plan_changed', {
        roomName: null,
        members: [],
        currentPlanCounts: { stopCount: 7, optionalStopCount: 2 },
        eventPayload: { action: 'edit' },
      }),
    ).toEqual({
      planChange: { action: 'edit', stopCount: 7, optionalStopCount: 2 },
    });
  });

  it('omits unavailable facts and unsupported event values', () => {
    expect(
      notificationFacts('plan_changed', {
        roomName: null,
        members: [],
        currentPlanCounts: null,
        eventPayload: { action: 'unknown', optionalStopCount: -1 },
      }),
    ).toEqual({});
  });
});
