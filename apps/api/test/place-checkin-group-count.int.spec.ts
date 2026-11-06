import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { checkedInGroupCountQuery } from '../../../libs/modules/search/infrastructure/checked-in-group-counts';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let otherApp: NestFastifyApplication;
let userId: string;
let seq = 0;
const api = () => app.getHttpAdapter().getInstance();
const detail = (placeId: string) => api().inject({ method: 'GET', url: `/v1/places/${placeId}` });

async function place(status: 'published' | 'community_submitted' | 'draft' = 'published') {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Check-in place ${++seq}`,
      nameNormalized: 'trigger',
      status,
      geom: { x: 106.7, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

async function room(type: 'couple' | 'group' = 'group') {
  const [row] = await db
    .insert(schema.rooms)
    .values({
      code: randomUUID(),
      type,
      decisionMode: 'host',
      hostUserId: userId,
      status: 'completed',
      participantCount: 3,
    })
    .returning();
  return row!.id;
}

async function member(roomId: string) {
  const [guest] = await db
    .insert(schema.guestSessions)
    .values({
      roomId,
      displayName: 'Guest',
      tokenHash: randomUUID(),
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    })
    .returning();
  const [row] = await db
    .insert(schema.roomMembers)
    .values({
      roomId,
      guestSessionId: guest!.id,
      role: 'member',
      displayName: 'Guest',
    })
    .returning();
  return row!;
}

async function stop(placeId: string, roomId: string, version = 1, checkedIn = true) {
  const [plan] = await db
    .insert(schema.plans)
    .values({
      roomId,
      version,
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
      status: 'archived',
    })
    .returning();
  const [s] = await db
    .insert(schema.planStops)
    .values({
      planId: plan!.id,
      placeId,
      position: 0,
      durationMinutes: 60,
      status: 'completed',
      completedAt: new Date('2020-01-01T00:00:00Z'),
    })
    .returning();
  const m = await member(roomId);
  if (checkedIn)
    await db.insert(schema.stopCheckins).values({
      planStopId: s!.id,
      memberId: m.id,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
  return { stopId: s!.id, memberId: m.id };
}

async function visits(placeId: string, n: number) {
  for (let i = 0; i < n; i++) await stop(placeId, await room(i % 2 ? 'couple' : 'group'));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_checkin_count_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const [user] = await db.insert(schema.users).values({ displayName: 'Visitor' }).returning();
  userId = user!.id;
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  // Separate DI graph, DB pool and repository, as in another API process.
  otherApp = await createApp();
  await otherApp.init();
  await otherApp.getHttpAdapter().getInstance().ready();
}, 600_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await otherApp?.close();
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('PlaceDetail checked-in group count (#785)', () => {
  it.each([0, 1, 4, 5, 7])('counts %i distinct rooms, suppressing below five', async (n) => {
    const id = await place();
    await visits(id, n);
    const response = await detail(id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().checkedInGroupCount).toBe(n < 5 ? null : n);
    expect(response.json()).not.toHaveProperty('roomIds');
    expect(response.json()).not.toHaveProperty('memberIds');
  });

  it('deduplicates members, repeated check-ins and archived plan versions in the same room', async () => {
    const id = await place();
    await visits(id, 4);
    const r = await room();
    const { stopId, memberId } = await stop(id, r);
    const other = await member(r);
    await db.insert(schema.stopCheckins).values({ planStopId: stopId, memberId: other.id });
    await db
      .insert(schema.stopCheckins)
      .values({ planStopId: stopId, memberId })
      .onConflictDoUpdate({
        target: [schema.stopCheckins.planStopId, schema.stopCheckins.memberId],
        set: { note: 'Edited check-in' },
      });
    await stop(id, r, 2);
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
  });

  it('excludes rooms without check-ins, completed stops alone and visits at another place', async () => {
    const id = await place();
    await visits(id, 4);
    for (let n = 0; n < 6; n++) await stop(id, await room(), 1, false);
    await visits(await place(), 6);
    await db.insert(schema.reviews).values({ userId, placeId: id, rating: 5, status: 'published' });
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
  });

  it('counts visit records independently of content moderation, including textless check-ins', async () => {
    const id = await place();
    for (const moderation of ['pending', 'approved', 'rejected', 'hidden', 'pending']) {
      const { stopId } = await stop(id, await room());
      await db
        .update(schema.planStops)
        .set({ status: 'planned', completedAt: null })
        .where(eq(schema.planStops.id, stopId));
      await db
        .update(schema.stopCheckins)
        .set({ moderation })
        .where(eq(schema.stopCheckins.planStopId, stopId));
    }
    const body = (await detail(id)).json();
    expect(body.checkedInGroupCount).toBe(5);
    expect(body.gogoRatingCount).toBe(0);
  });

  it('reflects a new room and check-in deletion immediately', async () => {
    const id = await place();
    await visits(id, 4);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
    const fifth = await stop(id, await room());
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await db.delete(schema.stopCheckins).where(eq(schema.stopCheckins.planStopId, fifth.stopId));
    expect((await detail(id)).json().checkedInGroupCount).toBeNull();
  });

  it.each(['check-in deletion', 'room cascade', 'place merge'] as const)(
    'F-01: suppresses 5→4 immediately across API instances after %s commits',
    async (mutation) => {
      const id = await place();
      const canonical = await place();
      await visits(id, 4);
      const fifthRoom = await room();
      const fifth = await stop(id, fifthRoom);
      const otherDetail = () =>
        otherApp
          .getHttpAdapter()
          .getInstance()
          .inject({ method: 'GET', url: `/v1/places/${id}` });
      // Freeze time so neither instance can rely on expiry for correctness.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      expect((await detail(id)).json().checkedInGroupCount).toBe(5);
      expect((await otherDetail()).json().checkedInGroupCount).toBe(5);

      // Writes commit through the fixture's pool, independently of either API.
      await db.transaction(async (tx) => {
        if (mutation === 'check-in deletion') {
          await tx
            .delete(schema.stopCheckins)
            .where(eq(schema.stopCheckins.planStopId, fifth.stopId));
        } else if (mutation === 'room cascade') {
          await tx.delete(schema.rooms).where(eq(schema.rooms.id, fifthRoom));
        } else {
          await tx
            .update(schema.planStops)
            .set({ placeId: canonical })
            .where(eq(schema.planStops.id, fifth.stopId));
        }
      });
      expect((await detail(id)).json().checkedInGroupCount).toBeNull();
      expect((await otherDetail()).json().checkedInGroupCount).toBeNull();
    },
  );

  it('answers community places and retains existing 404 behavior', async () => {
    expect(
      (await detail(await place('community_submitted'))).json().checkedInGroupCount,
    ).toBeNull();
    expect((await detail(await place('draft'))).statusCode).toBe(404);
    expect((await detail(randomUUID())).statusCode).toBe(404);
  });

  it('deduplicates overlapping rooms when place references are merged', async () => {
    const canonical = await place();
    const duplicate = await place();
    await visits(canonical, 3);
    await visits(duplicate, 2);
    const overlap = await room();
    await stop(canonical, overlap, 1);
    await stop(duplicate, overlap, 2);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await detail(canonical)).json().checkedInGroupCount).toBeNull();
    // The place merge's existing reference move; no counter-specific write.
    await db
      .update(schema.planStops)
      .set({ placeId: canonical })
      .where(eq(schema.planStops.placeId, duplicate));
    expect((await detail(canonical)).json().checkedInGroupCount).toBe(6);
    expect((await detail(duplicate)).json().checkedInGroupCount).toBeNull();
  });

  it('fails a previously successful request on a database error rather than returning a fabricated zero/null', async () => {
    const id = await place();
    await visits(id, 5);
    expect((await detail(id)).json().checkedInGroupCount).toBe(5);
    await db.execute(sql`alter table stop_checkins rename to stop_checkins_unavailable`);
    try {
      const response = await detail(id);
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.body).not.toContain('checkedInGroupCount');
    } finally {
      await db.execute(sql`alter table stop_checkins_unavailable rename to stop_checkins`);
    }
    expect((await detail(id)).statusCode).toBe(200);
  });

  it('uses existing place and check-in indexes for the production aggregate statement', async () => {
    const target = await place();
    await visits(target, 5);
    // A meaningful competing population, without forcing the planner's choice.
    const elsewhere = await place();
    const r = await room();
    const { stopId, memberId } = await stop(elsewhere, r);
    await db.execute(sql`
      with stops as (
        insert into plan_stops (plan_id, place_id, position, duration_minutes)
        select plan_id, ${elsewhere}, n, 60
        from plan_stops, generate_series(1, 20000) n where id = ${stopId}
        returning id
      )
      insert into stop_checkins (plan_stop_id, member_id)
      select id, ${memberId} from stops
    `);
    await db.execute(sql`analyze plan_stops`);
    await db.execute(sql`analyze stop_checkins`);
    const result = await db.execute(
      sql`explain (analyze, format text) ${checkedInGroupCountQuery(target)}`,
    );
    const plan = (result.rows as { 'QUERY PLAN': string }[])
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain('plan_stops_place_idx');
    expect(plan).toContain('stop_checkins_stop_member_unique');
    expect(plan).not.toMatch(/Seq Scan on (plan_stops|stop_checkins)/);
    expect((await detail(target)).json().checkedInGroupCount).toBe(5);
  });
});
