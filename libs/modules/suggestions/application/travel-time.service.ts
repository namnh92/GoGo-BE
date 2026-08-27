import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import {
  HaversineTravelTime,
  TRAVEL_TIME_PROVIDER,
  type LatLng,
  type TravelLeg,
  type TravelTimePort,
} from '@gogo/providers';
import { DB } from '../../shared/tokens';

/** A point the optimizer wants a leg to; `placeId` present when it is a catalog place. */
export type TravelTarget = LatLng & { placeId?: string | undefined };

export const ROUTES_ENABLED = Symbol('ROUTES_ENABLED');

/**
 * ADR-0007 — travel legs for the optimizer, cached and degradable.
 *
 * Three things happen here, in order, because each one removes work from the
 * next: the durable cache answers pairs of catalog places (fixed geometry,
 * shared by every user), the provider is asked once per greedy step for what is
 * left, and anything still missing falls back to the straight-line estimate.
 *
 * The fallback is not an error path — it is the behaviour whenever the flag is
 * off, the quota is spent or the provider is down, and callers must present its
 * output as an estimate rather than as a measured travel time (core rule #8).
 */
@Injectable()
export class TravelTimeService {
  private readonly fallback = new HaversineTravelTime();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(TRAVEL_TIME_PROVIDER) private readonly provider?: TravelTimePort,
    @Optional() @Inject(ROUTES_ENABLED) private readonly enabled = false,
  ) {}

  /**
   * One origin, many destinations — the shape a greedy step needs. Returns a
   * leg for every destination, plus whether any of them is a fallback estimate
   * so the caller can label the plan honestly.
   */
  async matrix(
    origin: TravelTarget,
    destinations: TravelTarget[],
  ): Promise<{ legs: TravelLeg[]; estimated: boolean }> {
    if (destinations.length === 0) return { legs: [], estimated: false };
    if (!this.enabled || !this.provider) {
      // Haversine always answers, so the non-null assertion is safe here.
      const legs = await this.fallback.matrix(origin, destinations);
      return { legs: legs.map((l) => l!), estimated: true };
    }

    const cached = origin.placeId
      ? await this.readCache(origin.placeId, destinations)
      : destinations.map(() => null);

    const missing = destinations
      .map((d, i) => ({ d, i }))
      .filter(({ i }) => cached[i] === null || cached[i] === undefined);

    let estimated = false;
    if (missing.length > 0) {
      let fetched: (TravelLeg | null)[];
      try {
        fetched = await this.provider.matrix(
          origin,
          missing.map(({ d }) => d),
        );
      } catch {
        // Quota or outage: the plan still gets built, on estimates. Failing the
        // request instead would trade a slightly-wrong itinerary for none.
        fetched = [];
      }
      const writes: { from: string; to: string; leg: TravelLeg }[] = [];
      missing.forEach(({ d, i }, k) => {
        const leg = fetched[k] ?? null;
        if (leg) {
          cached[i] = leg;
          if (origin.placeId && d.placeId) {
            writes.push({ from: origin.placeId, to: d.placeId, leg });
          }
        }
      });
      if (writes.length > 0) await this.writeCache(writes);
    }

    const fallbackLegs = await this.fallback.matrix(origin, destinations);
    const legs: TravelLeg[] = destinations.map((_, i) => {
      const hit = cached[i];
      if (hit) return hit;
      estimated = true;
      return fallbackLegs[i]!;
    });
    return { legs, estimated };
  }

  private async readCache(
    fromPlaceId: string,
    destinations: TravelTarget[],
  ): Promise<(TravelLeg | null)[]> {
    const ids = destinations.map((d) => d.placeId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return destinations.map(() => null);

    const rows = await this.db.execute(sql`
      select to_place_id, minutes, distance_m
      from travel_legs
      where from_place_id = ${fromPlaceId}
        and mode = 'drive' and time_bucket = 0
        and to_place_id = any(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(',')}]`)}::uuid[])
    `);
    const byId = new Map(
      (rows.rows as { to_place_id: string; minutes: number; distance_m: number }[]).map((r) => [
        r.to_place_id,
        { minutes: r.minutes, distanceM: r.distance_m },
      ]),
    );
    return destinations.map((d) => (d.placeId ? (byId.get(d.placeId) ?? null) : null));
  }

  private async writeCache(writes: { from: string; to: string; leg: TravelLeg }[]): Promise<void> {
    for (const w of writes) {
      await this.db.execute(sql`
        insert into travel_legs
          (from_place_id, to_place_id, mode, time_bucket, minutes, distance_m, provider)
        values (${w.from}, ${w.to}, 'drive', 0, ${w.leg.minutes}, ${w.leg.distanceM}, 'google_routes')
        on conflict (from_place_id, to_place_id, mode, time_bucket)
        do update set minutes = excluded.minutes, distance_m = excluded.distance_m,
                      fetched_at = now()
      `);
    }
  }
}
