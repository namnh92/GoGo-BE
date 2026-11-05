type ComparableStop = {
  placeId: string;
  position: number;
  durationMinutes: number;
  isLocked: boolean;
  isOptional: boolean;
};

export type PlanChangeFacts = {
  addedStopCount: number;
  removedStopCount: number;
  movedStopCount: number;
  durationChangedStopCount: number;
  lockChangedStopCount: number;
  optionalChangedStopCount: number;
};

/**
 * Aggregate a plan mutation while both versions are still in hand. Place ids
 * identify retained stops because a plan may contain each place only once.
 * Counts, rather than place ids, are enough for localized inbox copy and do
 * not make notification rows another source of itinerary detail.
 */
export function planChangeFacts(
  previous: readonly ComparableStop[],
  next: readonly ComparableStop[],
): PlanChangeFacts {
  const previousByPlace = new Map(previous.map((stop) => [stop.placeId, stop]));
  const nextPlaceIds = new Set(next.map((stop) => stop.placeId));
  const retained = next.flatMap((stop) => {
    const before = previousByPlace.get(stop.placeId);
    return before ? [{ before, after: stop }] : [];
  });

  return {
    addedStopCount: next.length - retained.length,
    removedStopCount: previous.filter((stop) => !nextPlaceIds.has(stop.placeId)).length,
    movedStopCount: retained.filter(({ before, after }) => before.position !== after.position)
      .length,
    durationChangedStopCount: retained.filter(
      ({ before, after }) => before.durationMinutes !== after.durationMinutes,
    ).length,
    lockChangedStopCount: retained.filter(({ before, after }) => before.isLocked !== after.isLocked)
      .length,
    optionalChangedStopCount: retained.filter(
      ({ before, after }) => before.isOptional !== after.isOptional,
    ).length,
  };
}
