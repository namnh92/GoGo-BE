import { AppError } from '../../shared/app-error';

export function matchingReadiness(
  status: string,
  role: string,
  members: { selectionStatus: string }[],
) {
  const completedCount = members.filter((member) => member.selectionStatus === 'completed').length;
  const pendingCount = members.length - completedCount;
  const blockedReason =
    role !== 'host'
      ? 'HOST_ONLY'
      : !['collecting', 'matching'].includes(status)
        ? 'ROOM_NOT_MATCHING'
        : completedCount < 2
          ? 'MATCHING_QUORUM_REQUIRED'
          : null;
  return {
    completedCount,
    pendingCount,
    canStart: blockedReason === null && pendingCount === 0,
    canStartWithIncomplete: blockedReason === null && pendingCount > 0,
    blockedReason,
  };
}

export function assertMatchingReady(
  members: { selectionStatus: string }[],
  allowIncomplete: boolean,
) {
  const readiness = matchingReadiness('collecting', 'host', members);
  if (readiness.blockedReason)
    throw AppError.conflict(
      readiness.blockedReason,
      'At least two completed preferences are required',
    );
  if (readiness.pendingCount > 0 && !allowIncomplete) {
    throw AppError.conflict(
      'PREFERENCES_INCOMPLETE',
      'Host must acknowledge incomplete preferences',
    );
  }
  return readiness;
}
