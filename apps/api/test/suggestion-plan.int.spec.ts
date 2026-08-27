import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * SG pipeline + BE-BFF-007/008/014 end-to-end over real HTTP + PostGIS:
 * group vote flow, couple match flow, locked-stop regenerate invariant
 * (release gate E2E #3), stale-on-constraint-change, check-in rules.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}

let ipc = 0;
const ip = () => `10.20.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: email.split('@')[0] },
  });
  return res.json().accessToken as string;
}

type Payload = Record<string, unknown>;
async function post(token: string, url: string, payload?: Payload) {
  return api().inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers: auth(token),
    payload: payload ?? {},
  });
}
async function put(token: string, url: string, payload: Payload) {
  return api().inject({ method: 'PUT', url, remoteAddress: ip(), headers: auth(token), payload });
}
async function patch(token: string, url: string, payload: Payload) {
  return api().inject({ method: 'PATCH', url, remoteAddress: ip(), headers: auth(token), payload });
}
async function get(token: string, url: string) {
  return api().inject({ method: 'GET', url, headers: auth(token) });
}

/** Seed a compact verified corpus around the origin. */
async function seedPlaces() {
  const cat = new Map<string, string>();
  for (const key of ['cafe', 'park', 'restaurant', 'bar']) {
    const [row] = await db.insert(schema.taxonomies).values({ kind: 'category', key }).returning();
    cat.set(key, row!.id);
  }
  const [mood] = await db
    .insert(schema.taxonomies)
    .values({ kind: 'mood', key: 'chill' })
    .returning();
  const [moodF] = await db
    .insert(schema.taxonomies)
    .values({ kind: 'mood', key: 'festive' })
    .returning();

  const defs = [
    {
      name: 'Cafe Uno',
      cat: 'cafe',
      mood: mood!.id,
      lat: 10.776,
      lng: 106.7,
      price: [50_000, 90_000],
    },
    { name: 'Park Xanh', cat: 'park', mood: mood!.id, lat: 10.777, lng: 106.702, price: [0, 0] },
    {
      name: 'Quán Ngon',
      cat: 'restaurant',
      mood: mood!.id,
      lat: 10.778,
      lng: 106.704,
      price: [80_000, 150_000],
    },
    {
      name: 'Bar Vui',
      cat: 'bar',
      mood: moodF!.id,
      lat: 10.779,
      lng: 106.706,
      price: [150_000, 250_000],
    },
    {
      name: 'Cafe Dos',
      cat: 'cafe',
      mood: mood!.id,
      lat: 10.775,
      lng: 106.698,
      price: [40_000, 80_000],
    },
  ];
  const ids: Record<string, string> = {};
  for (const d of defs) {
    const [p] = await db
      .insert(schema.places)
      .values({
        name: d.name,
        nameNormalized: 'x',
        status: 'published',
        geom: { x: d.lng, y: d.lat },
        rating: '4.40',
        ratingCount: 500,
        suitability: { couple: 0.9, group: 0.9 },
        avgVisitMinutes: 60,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
      })
      .returning();
    ids[d.name] = p!.id;
    await db.insert(schema.placeTaxonomies).values([
      { placeId: p!.id, taxonomyId: cat.get(d.cat)! },
      { placeId: p!.id, taxonomyId: d.mood },
    ]);
    await db.insert(schema.placePrices).values({
      placeId: p!.id,
      priceMin: d.price[0]!,
      priceMax: d.price[1]!,
      currency: 'VND',
      unit: 'per_person',
      confidence: '0.8',
      source: 'editor',
      verifiedAt: new Date(),
    });
    for (let day = 0; day < 7; day++) {
      await db.insert(schema.placeHours).values({
        placeId: p!.id,
        dayOfWeek: day,
        openMinute: 7 * 60,
        closeMinute: 23 * 60,
        isOvernight: false,
        source: 'editor',
      });
    }
  }
  return ids;
}

let placeIds: Record<string, string>;

/** Create a room with two user members, prefs completed → matching. */
async function matchingRoom(type: 'couple' | 'group', decisionMode: 'match' | 'vote') {
  const hostToken = await register(`h${Date.now()}${Math.random().toString(36).slice(2, 6)}@g.vn`);
  const memberToken = await register(
    `m${Date.now()}${Math.random().toString(36).slice(2, 6)}@g.vn`,
  );
  const create = await post(hostToken, '/v1/rooms', {
    type,
    decisionMode,
    participantCount: 2,
    constraint: {
      budgetMode: 'per_person',
      budgetAmount: 400_000,
      currency: 'VND',
      originLat: 10.776,
      originLng: 106.7,
      radiusM: 5000,
      startAt: '2026-08-29T03:00:00Z',
      endAt: '2026-08-29T10:00:00Z',
    },
  });
  const room = create.json();
  await patch(hostToken, `/v1/rooms/${room.id}/status`, { status: 'collecting' });
  const invite = await post(hostToken, `/v1/rooms/${room.id}/invites`, {});
  await post(memberToken, '/v1/rooms/join', { inviteCode: invite.json().code });

  for (const token of [hostToken, memberToken]) {
    await put(token, `/v1/rooms/${room.id}/preferences/me`, {
      selections: { mood: ['chill'] },
      expectedVersion: 0,
    });
    await post(token, `/v1/rooms/${room.id}/preferences/complete`);
  }
  return { hostToken, memberToken, roomId: room.id as string };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_sg_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  placeIds = await seedPlaces();

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('group vote flow (SG-002..006, BE-BFF-007)', () => {
  it('generates explainable ranked candidates, votes idempotently, host finalizes → plan', async () => {
    const { hostToken, memberToken, roomId } = await matchingRoom('group', 'vote');

    const gen = await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    expect(gen.statusCode).toBe(201);
    const current = gen.json();
    expect(current.candidates.length).toBeGreaterThanOrEqual(3);
    const top = current.candidates[0];
    expect(top.components).toHaveProperty('preference');
    expect(top.components).toHaveProperty('budget');
    expect(top.reasonCodes.length).toBeGreaterThan(0);
    expect(current.run.engineVersion).toBe('sg-1.0.0');

    // Vote idempotent: same member re-votes → single row, value updated.
    const target = current.candidates[0].placeId;
    await put(memberToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'yes' });
    await put(memberToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'star' });
    const rows = await db.select().from(schema.votes).where(eq(schema.votes.roomId, roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('star');

    // Voting outside the candidate allowlist is rejected.
    const outside = await put(memberToken, `/v1/rooms/${roomId}/votes/${placeIds['Bar Vui']}`, {
      value: 'yes',
    });
    if (
      !gen.json().candidates.some((c: { placeId: string }) => c.placeId === placeIds['Bar Vui'])
    ) {
      expect(outside.statusCode).toBe(400);
    }

    // Member cannot finalize; host can.
    const memberFinalize = await post(memberToken, `/v1/rooms/${roomId}/votes/finalize`);
    expect(memberFinalize.statusCode).toBe(403);
    const finalize = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
    expect(finalize.statusCode).toBe(201);
    const planId = finalize.json().planId;
    expect(planId).toBeTruthy();
    expect(finalize.json().winnerPlaceId).toBe(target);

    const plan = await get(hostToken, `/v1/plans/${planId}`);
    expect(plan.json().status).toBe('current');
    expect(plan.json().stops[0].placeId).toBe(target);
    expect(plan.json().totals.overBudget).toBe(false);

    const room = await get(hostToken, `/v1/rooms/${roomId}`);
    expect(room.json().status).toBe('ready');
  });
});

describe('couple match flow (FR-SUG-003)', () => {
  it('auto-creates the plan when both members match on a place', async () => {
    const { hostToken, memberToken, roomId } = await matchingRoom('couple', 'match');
    const gen = await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const target = gen.json().candidates[0].placeId;

    const v1 = await put(hostToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'yes' });
    expect(v1.json().matched).toBe(false);
    const v2 = await put(memberToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'yes' });
    expect(v2.json().matched).toBe(true);
    expect(v2.json().planId).toBeTruthy();
  });
});

describe('plan editing + locked regenerate (SG-007/008, BE-BFF-008)', () => {
  it('locked stops survive regenerate exactly; constraint edit marks plan stale', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    const target = cur.json().candidates[0].placeId;
    await put(hostToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'yes' });
    const fin = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
    const planId = fin.json().planId;

    // Lock the first stop.
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    const firstStop = plan.stops[0];
    const locked = await patch(hostToken, `/v1/plans/${planId}/stops/${firstStop.id}/lock`, {
      locked: true,
    });
    expect(locked.json().stops[0].isLocked).toBe(true);

    // Constraint edit → plan stale (core rule #6).
    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'matching' });
    const roomNow = (await get(hostToken, `/v1/rooms/${roomId}`)).json();
    await patch(hostToken, `/v1/rooms/${roomId}/constraints`, {
      budgetMode: 'per_person',
      budgetAmount: 350_000,
      currency: 'VND',
      originLat: 10.776,
      originLng: 106.7,
      radiusM: 5000,
      startAt: '2026-08-29T03:00:00Z',
      endAt: '2026-08-29T10:00:00Z',
      expectedConstraintVersion: roomNow.constraintVersion,
    });
    const stalePlan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    expect(stalePlan.isStale).toBe(true);

    // Regenerate: locked stop must survive with identical place/duration/cost.
    const regen = await post(hostToken, `/v1/plans/${planId}/regenerate`, {});
    expect(regen.statusCode).toBe(201);
    const newPlan = regen.json();
    expect(newPlan.version).toBe(stalePlan.version + 1);
    const keptStop = newPlan.stops.find(
      (s: { placeId: string }) => s.placeId === firstStop.placeId,
    );
    expect(keptStop).toBeTruthy();
    expect(keptStop.isLocked).toBe(true);
    expect(keptStop.position).toBe(firstStop.position);
    expect(keptStop.durationMinutes).toBe(firstStop.durationMinutes);
    expect(keptStop.costMax).toBe(firstStop.costMax);
    // Unlocked stops were replaced (or at minimum re-evaluated fresh).
    expect(newPlan.constraintVersion).toBe(stalePlan.constraintVersion + 1);
    // Old plan superseded; only one current per room.
    const old = await db.select().from(schema.plans).where(eq(schema.plans.id, planId));
    expect(old[0]!.status).toBe('superseded');
  });

  it('edit recalculates totals server-side and rejects version conflicts', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const fin = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
    const planId = fin.json().planId;
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();

    const edited = await patch(hostToken, `/v1/plans/${planId}`, {
      expectedVersion: plan.version,
      stops: [
        { placeId: placeIds['Cafe Uno'], isLocked: false },
        { placeId: placeIds['Park Xanh'], isLocked: true },
      ],
    });
    expect(edited.statusCode).toBe(200);
    const newPlan = edited.json();
    expect(newPlan.stops).toHaveLength(2);
    expect(newPlan.stops[1].isLocked).toBe(true);
    expect(newPlan.stops[1].travelMinutesFromPrev).toBeGreaterThan(0);
    expect(newPlan.totals.costMax).toBe(90_000); // park is free; recalc server-side

    const conflict = await patch(hostToken, `/v1/plans/${planId}`, {
      expectedVersion: plan.version, // stale — plan was superseded
      stops: [{ placeId: placeIds['Cafe Uno'], isLocked: false }],
    });
    expect([404, 409]).toContain(conflict.statusCode);
  });
});

describe('active date + check-in (BE-BFF-014, FR-PLAN-008/009)', () => {
  it('completes stops and validates bill-photo rule', async () => {
    const { hostToken, memberToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const fin = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
    const planId = fin.json().planId;
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    const stopId = plan.stops[0].id;

    // Completing before active is refused.
    const early = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/complete`);
    expect(early.statusCode).toBe(409);

    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'active' });
    const done = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/complete`);
    expect(done.statusCode).toBe(201);

    // Bill without photo → 400 (FR-PLAN-009).
    const noPhoto = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      rating: 5,
      billTotal: 500_000,
    });
    expect(noPhoto.statusCode).toBe(400);

    const checkin = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      rating: 5,
      tags: ['ngon', 'view đẹp'],
      note: 'Tuyệt vời',
      photoKeys: ['media/a.jpg'],
      billTotal: 500_000,
      billPeopleCount: 2,
      billPhotoKey: 'media/bill.jpg',
    });
    expect(checkin.statusCode).toBe(201);
    expect(checkin.json().billPerPerson).toBe(250_000);
    expect(checkin.json().moderation).toBe('pending');

    // Skipping check-in never blocks the flow — completing another stop works
    // without one (only if more stops exist).
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, 'stop.checkin_saved'));
    expect(events.length).toBeGreaterThan(0);
  });
});
