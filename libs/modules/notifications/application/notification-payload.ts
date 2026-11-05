import type { PushKind } from './notification-templates';

type MemberFact = {
  id: string;
  displayName: string;
  selectionStatus: string;
};

type PlanCounts = { stopCount: number; optionalStopCount: number };

type NotificationFactContext = {
  roomName: string | null;
  members: MemberFact[];
  currentPlanCounts: PlanCounts | null;
  eventPayload: Record<string, unknown>;
};

const PLAN_CHANGE_COUNT_FIELDS = [
  'addedStopCount',
  'removedStopCount',
  'movedStopCount',
  'durationChangedStopCount',
  'lockChangedStopCount',
  'optionalChangedStopCount',
] as const;

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/**
 * Facts needed to render one inbox row. Copy remains a client concern, and
 * private preference choices never leave the preferences module.
 */
export function notificationFacts(
  kind: PushKind,
  context: NotificationFactContext,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (context.roomName) facts.roomName = context.roomName;

  if (kind === 'invite') {
    const inviterMemberId = context.eventPayload.inviterMemberId;
    if (typeof inviterMemberId === 'string') {
      const inviter = context.members.find((member) => member.id === inviterMemberId);
      if (inviter) facts.inviterName = inviter.displayName;
    }
  }

  if (kind === 'preference_reminder') {
    facts.preferenceProgress = {
      completedCount: context.members.filter((member) => member.selectionStatus === 'completed')
        .length,
      memberCount: context.members.length,
    };
  }

  const stopCount =
    nonNegativeInteger(context.currentPlanCounts?.stopCount) ??
    nonNegativeInteger(context.eventPayload.stopCount);
  if (kind === 'plan_ready' && stopCount !== undefined) facts.stopCount = stopCount;

  if (kind === 'plan_changed') {
    const action = context.eventPayload.action;
    if (action === 'edit' || action === 'regenerate') {
      const eventCounts = {
        stopCount: nonNegativeInteger(context.eventPayload.stopCount),
        optionalStopCount: nonNegativeInteger(context.eventPayload.optionalStopCount),
      };
      // Counts are one versioned fact. A legacy event may have only one of
      // them; never complete that snapshot from a newer current plan.
      const hasEventCounts =
        eventCounts.stopCount !== undefined || eventCounts.optionalStopCount !== undefined;
      const counts: {
        stopCount: number | undefined;
        optionalStopCount: number | undefined;
      } = hasEventCounts
        ? eventCounts
        : {
            stopCount: context.currentPlanCounts?.stopCount,
            optionalStopCount: context.currentPlanCounts?.optionalStopCount,
          };
      const changeFacts = Object.fromEntries(
        PLAN_CHANGE_COUNT_FIELDS.flatMap((field) => {
          const value = nonNegativeInteger(context.eventPayload[field]);
          return value === undefined ? [] : [[field, value]];
        }),
      );
      facts.planChange = {
        action,
        ...(counts.stopCount !== undefined ? { stopCount: counts.stopCount } : {}),
        ...(counts.optionalStopCount !== undefined
          ? { optionalStopCount: counts.optionalStopCount }
          : {}),
        ...changeFacts,
      };
    }
  }

  return facts;
}
