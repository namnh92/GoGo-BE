import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { TravelTimeService } from '@gogo/modules';
import {
  ProviderQuotaExceededError,
  type LatLng,
  type TravelLeg,
  type TravelTimePort,
} from '@gogo/providers';

/**
 * ADR-0007 — the cache and the degradation path, which are what make routing
 * affordable and what keep a plan buildable when it is not available.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let placeA: string;
let placeB: string;
let placeC: string;

class CountingProvider implements TravelTimePort {
  calls = 0;
  elements = 0;
  failing: Error | null = null;

  async matrix(_origin: LatLng, destinations: LatLng[]): Promise<(TravelLeg | null)[]> {
    this.calls += 1;
    this.elements += destinations.length;
    if (this.failing) throw this.failing;
    // Deliberately unlike haversine so a cache hit is distinguishable.
    return destinations.map((_, i) => ({ minutes: 42 + i, distanceM: 4200 + i }));
  }
}

async function seedPlace(name: string, lat: number, lng: number) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: 'set-by-trigger',
      status: 'published',
      geom: { x: lng, y: lat },
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_travel_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  placeA = await seedPlace('Điểm A', 10.7769, 106.7009);
  placeB = await seedPlace('Điểm B', 10.7843, 106.6844);
  placeC = await seedPlace('Điểm C', 10.8, 106.72);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const target = (id: string, lat: number, lng: number) => ({ placeId: id, lat, lng });

describe('TravelTimeService', () => {
  it('uses the straight-line estimate and calls nobody while the flag is off', async () => {
    const provider = new CountingProvider();
    const service = new TravelTimeService(db, provider, false);
    const { legs, estimated } = await service.matrix(target(placeA, 10.7769, 106.7009), [
      target(placeB, 10.7843, 106.6844),
    ]);
    expect(provider.calls).toBe(0);
    expect(estimated).toBe(true);
    expect(legs[0]!.minutes).not.toBe(42);
  });

  it('asks the provider once for the whole batch, then never again for those pairs', async () => {
    const provider = new CountingProvider();
    const service = new TravelTimeService(db, provider, true);
    const origin = target(placeA, 10.7769, 106.7009);
    const destinations = [target(placeB, 10.7843, 106.6844), target(placeC, 10.8, 106.72)];

    const first = await service.matrix(origin, destinations);
    // One call for two destinations — the batching the whole design rests on.
    expect(provider.calls).toBe(1);
    expect(provider.elements).toBe(2);
    expect(first.estimated).toBe(false);
    expect(first.legs[0]!.minutes).toBe(42);

    const second = await service.matrix(origin, destinations);
    // Fixed catalog geometry: the answer is the same for every user, forever.
    expect(provider.calls).toBe(1);
    expect(second.legs[0]!.minutes).toBe(42);
    expect(second.estimated).toBe(false);

    const [cached] = await db
      .execute(
        sql`
      select count(*)::int as n from travel_legs where from_place_id = ${placeA}
    `,
      )
      .then((r) => r.rows as { n: number }[]);
    expect(cached!.n).toBe(2);
  });

  it('only pays for the pairs it does not already have', async () => {
    const provider = new CountingProvider();
    const service = new TravelTimeService(db, provider, true);
    const newPlace = await seedPlace('Điểm D', 10.81, 106.73);

    await service.matrix(target(placeA, 10.7769, 106.7009), [
      target(placeB, 10.7843, 106.6844), // cached by the previous test
      target(newPlace, 10.81, 106.73), // new
    ]);
    expect(provider.elements).toBe(1);
  });

  it('still returns a plan when the quota is gone, marked as an estimate', async () => {
    const provider = new CountingProvider();
    provider.failing = new ProviderQuotaExceededError('google.routes');
    const service = new TravelTimeService(db, provider, true);
    const uncached = await seedPlace('Điểm E', 10.82, 106.74);

    const { legs, estimated } = await service.matrix(target(placeA, 10.7769, 106.7009), [
      target(uncached, 10.82, 106.74),
    ]);
    // Failing the request would trade a slightly-wrong itinerary for none.
    expect(legs).toHaveLength(1);
    expect(legs[0]!.minutes).toBeGreaterThan(0);
    expect(estimated).toBe(true);
  });

  it('does not cache a leg from a point that is not a catalog place', async () => {
    const provider = new CountingProvider();
    const service = new TravelTimeService(db, provider, true);
    // The room's origin is user-supplied and never repeats across rooms.
    await service.matrix({ lat: 10.9, lng: 106.9 }, [target(placeB, 10.7843, 106.6844)]);
    const [rows] = await db
      .execute(
        sql`
      select count(*)::int as n from travel_legs where to_place_id = ${placeB}
        and from_place_id not in (${placeA}::uuid)
    `,
      )
      .then((r) => r.rows as { n: number }[]);
    expect(rows!.n).toBe(0);
  });
});
