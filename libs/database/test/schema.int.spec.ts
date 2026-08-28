import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema';

/**
 * DB integrity anchors (DB-003..006, DB-009): migrations apply cleanly to a
 * fresh PostGIS instance and the schema enforces the invariants the domain
 * relies on.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, '../../../migrations'),
  });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/** Drizzle wraps pg errors; the violated constraint name sits on the cause. */
async function expectConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${constraint} violation`);
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string; message?: string } }).cause;
    expect(cause?.constraint ?? cause?.message ?? String(err)).toContain(constraint);
  }
}

async function createRoomFixture() {
  const [user] = await db
    .insert(schema.users)
    .values({ displayName: 'Host', email: `h${Date.now()}-${Math.random()}@x.vn` })
    .returning();
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: `code-${Date.now()}-${Math.random()}`,
      type: 'couple',
      decisionMode: 'match',
      hostUserId: user!.id,
    })
    .returning();
  const [member] = await db
    .insert(schema.roomMembers)
    .values({ roomId: room!.id, userId: user!.id, role: 'host', displayName: 'Host' })
    .returning();
  return { user: user!, room: room!, member: member! };
}

describe('schema integrity', () => {
  it('applies all migrations on fresh PostGIS (extensions, tables, indexes)', async () => {
    const res = await pool.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(res.rows[0].n).toBeGreaterThan(40);
    const idx = await pool.query(
      `select indexname from pg_indexes where tablename = 'places' and indexname in
       ('places_search_tsv_idx','places_name_trgm_idx','places_geom_gist_idx')`,
    );
    expect(idx.rows).toHaveLength(3);
  });

  it('normalizes Vietnamese place names via trigger', async () => {
    const [p] = await db
      .insert(schema.places)
      .values({
        name: 'Bún đậu Mắm tôm Cô Ba',
        nameNormalized: 'overwritten-by-trigger',
        geom: { x: 106.7, y: 10.77 },
        status: 'published',
      })
      .returning();
    expect(p!.nameNormalized).toBe('bun dau mam tom co ba');
  });

  it('enforces one current plan per room (FR-PLAN-001)', async () => {
    const { room } = await createRoomFixture();
    const totals = {
      costMin: 0,
      costMax: 0,
      currency: 'VND',
      durationMinutes: 0,
      travelDistanceM: 0,
      overBudget: false,
      uncertain: false,
    };
    await db.insert(schema.plans).values({
      roomId: room.id,
      version: 1,
      status: 'current',
      totals,
      constraintVersion: 1,
    });
    await expectConstraint(
      db.insert(schema.plans).values({
        roomId: room.id,
        version: 2,
        status: 'current',
        totals,
        constraintVersion: 1,
      }),
      'plans_room_current_unique',
    );
  });

  it('votes are idempotent via unique upsert target (FR-SUG-004)', async () => {
    const { room, member } = await createRoomFixture();
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Vote Target',
        nameNormalized: 'x',
        geom: { x: 106.7, y: 10.78 },
        status: 'published',
      })
      .returning();
    const voteOnce = () =>
      db
        .insert(schema.votes)
        .values({ roomId: room.id, memberId: member.id, targetPlaceId: place!.id, value: 'yes' })
        .onConflictDoUpdate({
          target: [schema.votes.roomId, schema.votes.memberId, schema.votes.targetPlaceId],
          set: { value: 'yes', updatedAt: sql`now()` },
        });
    await voteOnce();
    await voteOnce();
    const rows = await db
      .select()
      .from(schema.votes)
      .where(sql`${schema.votes.roomId} = ${room.id}`);
    expect(rows).toHaveLength(1);
  });

  it('membership is user XOR guest', async () => {
    const { room } = await createRoomFixture();
    await expectConstraint(
      db.insert(schema.roomMembers).values({
        roomId: room.id,
        userId: null,
        guestSessionId: null,
        displayName: 'Nobody',
      }),
      'room_members_one_identity',
    );
  });

  it('bill amount requires bill photo (FR-PLAN-009)', async () => {
    const { room, member } = await createRoomFixture();
    const totals = {
      costMin: 0,
      costMax: 0,
      currency: 'VND',
      durationMinutes: 0,
      travelDistanceM: 0,
      overBudget: false,
      uncertain: false,
    };
    const [plan] = await db
      .insert(schema.plans)
      .values({ roomId: room.id, version: 1, status: 'draft', totals, constraintVersion: 1 })
      .returning();
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Checkin Place',
        nameNormalized: 'x',
        geom: { x: 106.71, y: 10.78 },
        status: 'published',
      })
      .returning();
    const [stop] = await db
      .insert(schema.planStops)
      .values({ planId: plan!.id, placeId: place!.id, position: 0, durationMinutes: 60 })
      .returning();
    await expectConstraint(
      db.insert(schema.stopCheckins).values({
        planStopId: stop!.id,
        memberId: member.id,
        billTotal: 250000,
        billPhotoKey: null,
      }),
      'stop_checkins_bill_photo_required',
    );
  });

  it('provider source dedup constraint (FR-CMS-004)', async () => {
    const [p1] = await db
      .insert(schema.places)
      .values({ name: 'Dup A', nameNormalized: 'x', geom: { x: 106.7, y: 10.7 }, status: 'draft' })
      .returning();
    const [p2] = await db
      .insert(schema.places)
      .values({ name: 'Dup B', nameNormalized: 'x', geom: { x: 106.7, y: 10.7 }, status: 'draft' })
      .returning();
    await db.insert(schema.placeSources).values({
      placeId: p1!.id,
      provider: 'google',
      externalId: 'ChIJsame',
    });
    await expectConstraint(
      db.insert(schema.placeSources).values({
        placeId: p2!.id,
        provider: 'google',
        externalId: 'ChIJsame',
      }),
      'place_sources_provider_external_unique',
    );
  });

  it('geo radius query uses PostGIS and returns expected places', async () => {
    await db.insert(schema.places).values({
      name: 'Near Ben Thanh',
      nameNormalized: 'x',
      geom: { x: 106.698, y: 10.772 },
      status: 'published',
    });
    const res = await pool.query(
      `select name from places
       where status = 'published'
         and ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
      [106.7, 10.773, 1000],
    );
    expect(res.rows.map((r: { name: string }) => r.name)).toContain('Near Ben Thanh');
  });
});
