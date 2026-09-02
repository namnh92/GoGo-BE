import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { MATERIAL_MOVE_METERS, invalidateTravelOnMove } from '@gogo/modules';

/**
 * COST-BE-006 (#339) — what has to be thrown away when a place moves.
 *
 * `travel_legs` is keyed by place **ids**, not coordinates, so ADR-0007's claim
 * that "a place moving changes its coordinates, which changes the key" was
 * false: nothing evicted a leg, and a cached duration to a coordinate the place
 * no longer occupied was served indefinitely under its id. The plans built on
 * those legs showed arrival times nobody could reproduce.
 *
 * Asserted against a real PostGIS distance rather than a stubbed one, because
 * the threshold is the whole rule and `ST_Distance(geography)` is what decides
 * it.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** ~111m north — comfortably over the threshold. */
const MOVED_FAR = { lat: 10.7753, lng: 106.7038 };
/** ~11m north — an editor nudging a pin off the street. */
const MOVED_NUDGE = { lat: 10.77441, lng: 106.7038 };
const ORIGIN = { lat: 10.7743, lng: 106.7038 };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_relocation_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let seq = 0;

async function place(name: string, at: { lat: number; lng: number }): Promise<string> {
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: 'set-by-trigger',
      status: 'published',
      geom: { x: at.lng, y: at.lat },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

/** A room, a plan and one stop on `placeId` — the shape a live plan has. */
async function planContaining(placeId: string, status: 'current' | 'archived'): Promise<string> {
  seq += 1;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `reloc-${seq}@gogo.id.vn`, displayName: 'Reloc' })
    .returning();
  const [room] = await db
    .insert(schema.rooms)
    .values({
      hostUserId: user!.id,
      type: 'couple',
      decisionMode: 'match',
      code: `RELOC${seq}${Date.now() % 100000}`,
    })
    .returning();
  const [plan] = await db
    .insert(schema.plans)
    .values({
      roomId: room!.id,
      version: 1,
      status,
      totals: {
        costMin: 0,
        costMax: 0,
        currency: 'VND',
        durationMinutes: 60,
        travelDistanceM: 0,
        overBudget: false,
        uncertain: false,
      },
      constraintVersion: 1,
    })
    .returning();
  await db.insert(schema.planStops).values({
    planId: plan!.id,
    placeId,
    position: 0,
    durationMinutes: 60,
  });
  return plan!.id;
}

async function leg(from: string, to: string): Promise<void> {
  await db
    .insert(schema.travelLegs)
    .values({ fromPlaceId: from, toPlaceId: to, minutes: 12, distanceM: 3000 })
    .onConflictDoNothing();
}

const legCount = async (placeId: string): Promise<number> => {
  const rows = await db.execute(sql`
    select count(*)::int as n from travel_legs
    where from_place_id = ${placeId}::uuid or to_place_id = ${placeId}::uuid
  `);
  return (rows.rows[0] as { n: number }).n;
};

const isStale = async (planId: string): Promise<boolean> => {
  const [row] = await db
    .select({ isStale: schema.plans.isStale })
    .from(schema.plans)
    .where(eq(schema.plans.id, planId))
    .limit(1);
  return row!.isStale;
};

describe('#339 — a place that moves invalidates what was measured to it', () => {
  it('deletes legs in both directions and marks live plans stale', async () => {
    const moved = await place('Quán Dời Chỗ', ORIGIN);
    const other = await place('Quán Đứng Yên', { lat: 10.79, lng: 106.7 });
    await leg(moved, other);
    await leg(other, moved);
    const live = await planContaining(moved, 'current');

    expect(await legCount(moved)).toBe(2);

    const result = await invalidateTravelOnMove(db, moved, MOVED_FAR);

    expect(result?.invalidated).toBe(true);
    expect(result!.movedMeters).toBeGreaterThan(MATERIAL_MOVE_METERS);
    // Both directions. Deleting one side leaves half the cache measuring the
    // old position, and a plan would then mix distances from two places.
    expect(await legCount(moved), 'every leg touching the moved place is gone').toBe(0);
    expect(await isStale(live), 'a plan built on those legs is no longer defensible').toBe(true);
  });

  it('leaves a leg between two other places alone', async () => {
    const moved = await place('Quán Dời 2', ORIGIN);
    const a = await place('Quán A', { lat: 10.8, lng: 106.7 });
    const b = await place('Quán B', { lat: 10.81, lng: 106.71 });
    await leg(a, b);

    await invalidateTravelOnMove(db, moved, MOVED_FAR);

    // Invalidation is scoped to the place that moved. Clearing the table would
    // be correct and ruinous — every other pair costs Routes quota to recompute.
    expect(await legCount(a)).toBe(1);
  });

  it('does nothing for a nudge under the threshold', async () => {
    const nudged = await place('Quán Nhích Ghim', ORIGIN);
    const other = await place('Quán Kia', { lat: 10.79, lng: 106.71 });
    await leg(nudged, other);
    const live = await planContaining(nudged, 'current');

    const result = await invalidateTravelOnMove(db, nudged, MOVED_NUDGE);

    // Editors move markers by tens of metres all day — a pin dragged from the
    // street into the courtyard is the same place, and recomputing a Routes
    // matrix for it is spend with no change in the answer.
    expect(result?.invalidated).toBe(false);
    expect(result!.movedMeters).toBeLessThanOrEqual(MATERIAL_MOVE_METERS);
    expect(await legCount(nudged)).toBe(1);
    expect(await isStale(live)).toBe(false);
  });

  it('does not rewrite the history of a plan that already happened', async () => {
    const moved = await place('Quán Dời 3', ORIGIN);
    const archived = await planContaining(moved, 'archived');

    await invalidateTravelOnMove(db, moved, MOVED_FAR);

    // An archived plan is a record of an evening that happened. Marking it
    // stale says something false about it.
    expect(await isStale(archived)).toBe(false);
  });

  it('reports null for a place that does not exist', async () => {
    expect(
      await invalidateTravelOnMove(db, '00000000-0000-0000-0000-000000000000', MOVED_FAR),
    ).toBeNull();
  });
});
