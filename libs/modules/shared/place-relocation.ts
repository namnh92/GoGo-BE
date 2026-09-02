import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';

/**
 * COST-BE-006 (#339) — what has to be thrown away when a place moves.
 *
 * `travel_legs` is a cache keyed by `(from_place_id, to_place_id, mode,
 * time_bucket)` — place **ids**, not coordinates. So when a place's `geom`
 * changed, every cached leg touching it silently became a measurement between
 * two points, one of which no longer exists, served under the id of a place
 * that had moved. Nothing invalidated them: only `mergePlaces` ever deleted a
 * leg, and only because the place itself was going away. ADR-0007 describes an
 * invalidation that was never written.
 *
 * A plan built on those legs is wrong in a way its owner cannot see — the
 * arrival times and the travel minutes between stops were computed from the old
 * position — so the plan is marked stale, which is the mechanism core rule 6
 * already uses for a constraint change.
 */

/**
 * Below this, a move is a coordinate correction, not a relocation.
 *
 * 50 m is roughly a building's frontage in central HCMC. Editors nudge pins by
 * tens of metres all day — a marker moved from the street to the courtyard is
 * the same place — and invalidating the travel cache on every such nudge would
 * spend Routes quota to recompute a number that did not change. Above it, the
 * walk from the previous point is long enough to change a plan.
 */
export const MATERIAL_MOVE_METERS = 50;

type Runner = Pick<Db, 'execute'>;

/**
 * Invalidate travel caching for a place that is **about to** move.
 *
 * Call this *before* writing the new `geom`, in the same transaction: it
 * measures against the stored position, so afterwards there is nothing left to
 * compare and the move is invisible.
 *
 * Returns the distance moved, or `null` when the place does not exist. A move
 * at or under the threshold does nothing and reports the distance, so a caller
 * can log or count it without repeating the arithmetic.
 */
export async function invalidateTravelOnMove(
  runner: Runner,
  placeId: string,
  next: { lat: number; lng: number },
): Promise<{ movedMeters: number; invalidated: boolean } | null> {
  const measured = await runner.execute(sql`
    select ST_Distance(
      p.geom::geography,
      ST_SetSRID(ST_MakePoint(${next.lng}, ${next.lat}), 4326)::geography
    ) as moved_m
    from places p where p.id = ${placeId}::uuid
  `);
  const row = measured.rows[0] as { moved_m: number | string | null } | undefined;
  if (!row || row.moved_m === null) return null;
  const movedMeters = Number(row.moved_m);
  if (!Number.isFinite(movedMeters) || movedMeters <= MATERIAL_MOVE_METERS) {
    return { movedMeters: Number.isFinite(movedMeters) ? movedMeters : 0, invalidated: false };
  }

  // Both directions. A leg is stored once per ordered pair, so a place that
  // moved invalidates the legs *from* it and the legs *to* it — deleting only
  // one side leaves half the cache measuring the old position, which is worse
  // than leaving all of it: the plan would then mix distances from two places.
  await runner.execute(sql`
    delete from travel_legs
    where from_place_id = ${placeId}::uuid or to_place_id = ${placeId}::uuid
  `);

  // Only plans that can still be acted on. `superseded` and `archived` plans
  // are a record of what was decided, and marking a finished outing stale says
  // something false about it — the evening happened.
  await runner.execute(sql`
    update plans set is_stale = true, updated_at = now()
    where status in ('draft', 'current')
      and is_stale = false
      and exists (
        select 1 from plan_stops ps
        where ps.plan_id = plans.id and ps.place_id = ${placeId}::uuid
      )
  `);

  return { movedMeters, invalidated: true };
}
