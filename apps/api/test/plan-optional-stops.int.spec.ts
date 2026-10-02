import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { PlansRepository } from '../../../libs/modules/plans/infrastructure/plans.repository';

/**
 * GoGo-BE#228 (ADR-0028) — optional stops over real HTTP + PostGIS: who may
 * set `isOptional`, in which states, omission/clear/default semantics, the
 * required/optional totals, anchors vs locks, locked schedules through
 * regenerate, and publication rechecks against interleaved writers.
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
async function matchingRoom(
  type: 'couple' | 'group',
  decisionMode: 'match' | 'vote' | 'host',
  options: { skipTransitions?: boolean } = {},
) {
  const hostToken = await register(`h${Date.now()}${Math.random().toString(36).slice(2, 6)}@g.vn`);
  const memberToken = await register(
    `m${Date.now()}${Math.random().toString(36).slice(2, 6)}@g.vn`,
  );
  const create = await post(hostToken, '/v1/rooms', {
    type,
    decisionMode,
    participantCount: 2,
    constraint: {
      // GoGo-BE#559: a couple budget is a total for two; only a group picks a
      // unit. The amount is doubled for the couple so the per-person ceiling
      // these cases rely on stays 400k either way.
      budgetMode: type === 'couple' ? 'total' : 'per_person',
      budgetAmount: type === 'couple' ? 800_000 : 400_000,
      currency: 'VND',
      originLat: 10.776,
      originLng: 106.7,
      radiusM: 5000,
      startAt: '2026-08-29T03:00:00Z',
      endAt: '2026-08-29T10:00:00Z',
    },
  });
  const room = create.json();
  // Kept for the existing cases, skipped by the ones proving a client no longer
  // has to walk the state machine itself (#155).
  if (!options.skipTransitions) {
    await patch(hostToken, `/v1/rooms/${room.id}/status`, { status: 'collecting' });
  }
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
    .withDatabase('gogo_opt_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
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

function latchCreatePlanVersion(onCall: (callIndex: number) => Promise<void>): {
  restore: () => void;
  calls: () => number;
} {
  const repo = app.get(PlansRepository);
  const original = repo.createPlanVersion.bind(repo);
  let calls = 0;
  repo.createPlanVersion = (async (input: Parameters<typeof original>[0]) => {
    const index = calls++;
    await onCall(index);
    return original(input);
  }) as typeof repo.createPlanVersion;
  return {
    restore: () => {
      repo.createPlanVersion = original;
    },
    calls: () => calls,
  };
}

type StopDto = {
  id: string;
  placeId: string;
  position: number;
  arriveAt?: string;
  departAt?: string;
  isLocked: boolean;
  isOptional: boolean;
};
type PlanDto = {
  id: string;
  version: number;
  isStale: boolean;
  totals: Record<string, number | boolean | string>;
  stops: StopDto[];
};

async function patchWith(token: string, url: string, payload: Payload, key: string) {
  return api().inject({
    method: 'PATCH',
    url,
    remoteAddress: ip(),
    headers: { ...auth(token), 'idempotency-key': key },
    payload,
  });
}

/**
 * A finalized group room whose current plan is exactly Cafe Uno → Park Xanh →
 * Quán Ngon, all unlocked and required, so every case starts from known stops.
 */
async function plannedRoom() {
  const { hostToken, memberToken, roomId } = await matchingRoom('group', 'vote');
  const gen = await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
  expect(gen.statusCode).toBe(201);
  const target = gen.json().candidates[0].placeId;
  await put(hostToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'yes' });
  const fin = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
  expect(fin.statusCode).toBe(201);
  const first = (await get(hostToken, `/v1/plans/${fin.json().planId}`)).json() as PlanDto;
  const edited = await patch(hostToken, `/v1/plans/${first.id}`, {
    expectedVersion: first.version,
    stops: [
      { placeId: placeIds['Cafe Uno'], isLocked: false, isOptional: false },
      { placeId: placeIds['Park Xanh'], isLocked: false, isOptional: false },
      { placeId: placeIds['Quán Ngon'], isLocked: false, isOptional: false },
    ],
  });
  expect(edited.statusCode).toBe(200);
  return { hostToken, memberToken, roomId, plan: edited.json() as PlanDto };
}

const byPlace = (plan: PlanDto, name: string) =>
  plan.stops.find((s) => s.placeId === placeIds[name])!;

async function guestOf(roomId: string): Promise<string> {
  const [room] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
  await db.update(schema.rooms).set({ status: 'collecting' }).where(eq(schema.rooms.id, roomId));
  const guest = await api().inject({
    method: 'POST',
    url: '/v1/sessions/guest',
    remoteAddress: ip(),
    payload: { roomCode: room!.code, displayName: 'Khách' },
  });
  await db.update(schema.rooms).set({ status: room!.status }).where(eq(schema.rooms.id, roomId));
  expect(guest.statusCode).toBe(201);
  return guest.json().accessToken as string;
}

async function plansOf(roomId: string) {
  return db.select().from(schema.plans).where(eq(schema.plans.roomId, roomId));
}

async function changeConstraints(hostToken: string, roomId: string) {
  const room = (await get(hostToken, `/v1/rooms/${roomId}`)).json();
  const res = await patch(hostToken, `/v1/rooms/${roomId}/constraints`, {
    budgetMode: 'per_person',
    budgetAmount: 350_000,
    currency: 'VND',
    originLat: 10.776,
    originLng: 106.7,
    radiusM: 5000,
    startAt: '2026-08-29T03:00:00Z',
    endAt: '2026-08-29T10:00:00Z',
    expectedConstraintVersion: room.constraintVersion,
  });
  expect(res.statusCode).toBe(200);
}

describe('who may set isOptional (ADR-0028)', () => {
  it('host sets it; member, guest and another room’s host cannot; everyone in the room reads it', async () => {
    const { hostToken, memberToken, roomId, plan } = await plannedRoom();
    const body = {
      expectedVersion: plan.version,
      stops: plan.stops.map((s) => ({ placeId: s.placeId, isOptional: true })),
    };

    const member = await patch(memberToken, `/v1/plans/${plan.id}`, body);
    expect(member.statusCode).toBe(403);
    const guestToken = await guestOf(roomId);
    const guest = await patch(guestToken, `/v1/plans/${plan.id}`, body);
    expect(guest.statusCode).toBe(403);
    const other = await matchingRoom('group', 'vote');
    const stranger = await patch(other.hostToken, `/v1/plans/${plan.id}`, body);
    expect(stranger.statusCode).toBe(403);
    expect(await plansOf(roomId)).toHaveLength(2);

    const host = await patch(hostToken, `/v1/plans/${plan.id}`, body);
    expect(host.statusCode).toBe(200);
    const next = host.json() as PlanDto;
    for (const token of [memberToken, guestToken]) {
      const read = (await get(token, `/v1/plans/${next.id}`)).json() as PlanDto;
      expect(read.stops.every((s) => s.isOptional)).toBe(true);
    }
  });
});

describe('edit semantics (ADR-0028)', () => {
  it('omission keeps, explicit false clears, a new place starts required', async () => {
    const { hostToken, plan } = await plannedRoom();
    const marked = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: [
        { placeId: placeIds['Cafe Uno'] },
        { placeId: placeIds['Park Xanh'], isOptional: true },
        { placeId: placeIds['Quán Ngon'], isOptional: true },
      ],
    });
    expect(marked.statusCode).toBe(200);
    const v1 = marked.json() as PlanDto;
    expect(byPlace(v1, 'Park Xanh').isOptional).toBe(true);

    // Reorder with isOptional omitted everywhere, clear one, add one.
    const res = await patch(hostToken, `/v1/plans/${v1.id}`, {
      expectedVersion: v1.version,
      stops: [
        { placeId: placeIds['Park Xanh'] },
        { placeId: placeIds['Quán Ngon'], isOptional: false },
        { placeId: placeIds['Cafe Uno'] },
        { placeId: placeIds['Cafe Dos'] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const v2 = res.json() as PlanDto;
    expect(byPlace(v2, 'Park Xanh').isOptional).toBe(true);
    expect(byPlace(v2, 'Quán Ngon').isOptional).toBe(false);
    expect(byPlace(v2, 'Cafe Uno').isOptional).toBe(false);
    expect(byPlace(v2, 'Cafe Dos').isOptional).toBe(false);
    expect(byPlace(v2, 'Park Xanh').position).toBe(0);
  });

  it('rejects the same place twice', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: [
        { placeId: placeIds['Cafe Uno'], isOptional: true },
        { placeId: placeIds['Cafe Uno'], isOptional: false },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('DUPLICATE_STOP_PLACE');
    expect(res.json().field_errors[0].field).toBe('stops[1].placeId');
    expect(await plansOf(roomId)).toHaveLength(2);
  });

  it('replays an Idempotency-Key instead of writing a second version', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    const body = {
      expectedVersion: plan.version,
      stops: plan.stops.map((s, i) => ({ placeId: s.placeId, isOptional: i === 0 })),
    };
    const a = await patchWith(hostToken, `/v1/plans/${plan.id}`, body, 'opt-228-replay-key');
    const b = await patchWith(hostToken, `/v1/plans/${plan.id}`, body, 'opt-228-replay-key');
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.headers['x-idempotent-replay']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    expect(await plansOf(roomId)).toHaveLength(3);
  });

  it('an explicitly unlocked stop stays unlocked (FAIL-before: every edited stop came back locked)', async () => {
    const { hostToken, plan } = await plannedRoom();
    expect(plan.stops.map((s) => s.isLocked)).toEqual([false, false, false]);
    const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: [
        { placeId: placeIds['Cafe Uno'], isLocked: true, isOptional: true },
        { placeId: placeIds['Park Xanh'], isLocked: false, isOptional: true },
        { placeId: placeIds['Quán Ngon'], isLocked: true, isOptional: false },
      ],
    });
    expect(res.statusCode).toBe(200);
    const next = res.json() as PlanDto;
    expect(next.stops.map((s) => [s.isLocked, s.isOptional])).toEqual([
      [true, true],
      [false, true],
      [true, false],
    ]);
  });
});

describe('forbidden states (ADR-0028)', () => {
  it('refuses an active room with ROOM_ACTIVE', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'active' });
    const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: [{ placeId: placeIds['Cafe Uno'], isOptional: true }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ROOM_ACTIVE');
  });

  it('refuses a cancelled or expired room with ROOM_NOT_EDITABLE (FAIL-before: edited)', async () => {
    for (const status of ['cancelled', 'expired'] as const) {
      const { hostToken, roomId, plan } = await plannedRoom();
      await db.update(schema.rooms).set({ status }).where(eq(schema.rooms.id, roomId));
      const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: [{ placeId: placeIds['Cafe Uno'], isOptional: true }],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ROOM_NOT_EDITABLE');
    }
  });

  it('a stale plan cannot be edited, so an edit cannot clear staleness (FAIL-before)', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'matching' });
    await changeConstraints(hostToken, roomId);
    const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: plan.stops.map((s) => ({ placeId: s.placeId, isOptional: true })),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLAN_STALE');
    const current = await db
      .select()
      .from(schema.plans)
      .where(and(eq(schema.plans.roomId, roomId), eq(schema.plans.status, 'current')));
    expect(current[0]!.id).toBe(plan.id);
    expect(current[0]!.isStale).toBe(true);
  });
});

describe('totals (ADR-0028)', () => {
  it('splits required and optional; overBudget follows the required upper bound', async () => {
    const { hostToken, plan } = await plannedRoom();
    // Budget 400k per person. Required: Cafe Uno 50–90k + Quán Ngon 80–150k.
    // Optional: Bar Vui 150–250k. All stops: 280–490k (over); required: 130–240k.
    const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: [
        { placeId: placeIds['Cafe Uno'] },
        { placeId: placeIds['Quán Ngon'] },
        { placeId: placeIds['Bar Vui'], isOptional: true },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toMatchObject({
      costMin: 280_000,
      costMax: 490_000,
      requiredCostMin: 130_000,
      requiredCostMax: 240_000,
      optionalCostMin: 150_000,
      optionalCostMax: 250_000,
      overBudget: false,
      costScope: 'per_person',
      currency: 'VND',
    });

    // Make the bar required: now the required upper bound is over.
    const v1 = res.json() as PlanDto;
    const req = await patch(hostToken, `/v1/plans/${v1.id}`, {
      expectedVersion: v1.version,
      stops: v1.stops.map((s) => ({ placeId: s.placeId, isOptional: false })),
    });
    expect(req.json().totals).toMatchObject({
      requiredCostMax: 490_000,
      optionalCostMax: 0,
      overBudget: true,
    });
  });

  it('an all-optional plan is allowed and has no required cost', async () => {
    const { hostToken, plan } = await plannedRoom();
    const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: plan.stops.map((s) => ({ placeId: s.placeId, isOptional: true })),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toMatchObject({
      requiredCostMin: 0,
      requiredCostMax: 0,
      overBudget: false,
    });
    expect(res.json().totals.optionalCostMax).toBe(res.json().totals.costMax);
  });

  it('a plan stored before the split reads as all required', async () => {
    const { hostToken, plan } = await plannedRoom();
    const [row] = await db.select().from(schema.plans).where(eq(schema.plans.id, plan.id));
    const legacy = {
      costMin: row!.totals.costMin,
      costMax: row!.totals.costMax,
      currency: row!.totals.currency,
      durationMinutes: row!.totals.durationMinutes,
      travelDistanceM: row!.totals.travelDistanceM,
      overBudget: row!.totals.overBudget,
      uncertain: row!.totals.uncertain,
    };
    await db.update(schema.plans).set({ totals: legacy }).where(eq(schema.plans.id, plan.id));
    const read = (await get(hostToken, `/v1/plans/${plan.id}`)).json();
    expect(read.totals).toMatchObject({
      requiredCostMin: legacy.costMin,
      requiredCostMax: legacy.costMax,
      optionalCostMin: 0,
      optionalCostMax: 0,
    });
    expect(read.stops.every((s: StopDto) => s.isOptional === false)).toBe(true);
  });
});

describe('regenerate with optional and locked stops (ADR-0028)', () => {
  it('keeps a locked optional noninitial stop at its stored time (FAIL-before: rescheduled)', async () => {
    const { hostToken, plan } = await plannedRoom();
    const v1 = (
      await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: [
          { placeId: placeIds['Cafe Uno'], isLocked: false },
          { placeId: placeIds['Park Xanh'], isLocked: true, isOptional: true },
          { placeId: placeIds['Quán Ngon'], isLocked: false, isOptional: true },
        ],
      })
    ).json() as PlanDto;
    const park = byPlace(v1, 'Park Xanh');
    // Give the locked stop a distinctive stored slot, later than any recompute.
    await db
      .update(schema.planStops)
      .set({
        arriveAt: new Date('2026-08-29T06:00:00Z'),
        departAt: new Date('2026-08-29T07:00:00Z'),
      })
      .where(eq(schema.planStops.id, park.id));

    const regen = await post(hostToken, `/v1/plans/${v1.id}/regenerate`, {});
    expect(regen.statusCode).toBe(201);
    const v2 = regen.json() as PlanDto;
    const kept = byPlace(v2, 'Park Xanh');
    expect(kept).toMatchObject({
      isLocked: true,
      isOptional: true,
      arriveAt: '2026-08-29T06:00:00.000Z',
      departAt: '2026-08-29T07:00:00.000Z',
    });
    // Unlocked stops — optional or not — were replaced, and replacements are required.
    for (const s of v2.stops.filter((x) => !x.isLocked)) {
      expect(s.isOptional).toBe(false);
      expect([placeIds['Cafe Uno'], placeIds['Quán Ngon']]).not.toContain(s.placeId);
    }
  });

  it('refuses with PLAN_TIME_CONFLICT and leaves the plan intact when a locked time is unreachable', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    const first = plan.stops[0]!;
    await patch(hostToken, `/v1/plans/${plan.id}/stops/${first.id}/lock`, { locked: true });
    // Stored before the window opens: travel from the origin cannot make it.
    await db
      .update(schema.planStops)
      .set({
        arriveAt: new Date('2026-08-29T02:00:00Z'),
        departAt: new Date('2026-08-29T03:00:00Z'),
      })
      .where(eq(schema.planStops.id, first.id));

    const regen = await post(hostToken, `/v1/plans/${plan.id}/regenerate`, {});
    expect(regen.statusCode).toBe(409);
    expect(regen.json().code).toBe('PLAN_TIME_CONFLICT');
    const plans = await plansOf(roomId);
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.status === 'current')!.id).toBe(plan.id);
  });

  it('lock/unlock never changes optionality', async () => {
    const { hostToken, plan } = await plannedRoom();
    const v1 = (
      await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: plan.stops.map((s) => ({ placeId: s.placeId, isOptional: true })),
      })
    ).json() as PlanDto;
    const stop = v1.stops[1]!;
    const locked = await patch(hostToken, `/v1/plans/${v1.id}/stops/${stop.id}/lock`, {
      locked: true,
    });
    expect(locked.json().stops[1]).toMatchObject({ isLocked: true, isOptional: true });
    const unlocked = await patch(hostToken, `/v1/plans/${v1.id}/stops/${stop.id}/lock`, {
      locked: false,
    });
    expect(unlocked.json().stops[1]).toMatchObject({ isLocked: false, isOptional: true });
  });
});

describe('publication rechecks against interleaved writers (ADR-0028, FAIL-before)', () => {
  it('a lock that lands while an edit computes makes the edit 409, never lost', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    const target = plan.stops[2]!;
    let lockStatus = 0;
    const latch = latchCreatePlanVersion(async () => {
      const res = await patch(hostToken, `/v1/plans/${plan.id}/stops/${target.id}/lock`, {
        locked: true,
      });
      lockStatus = res.statusCode;
    });
    try {
      const edit = await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: plan.stops.map((s) => ({ placeId: s.placeId, isLocked: false, isOptional: true })),
      });
      expect(lockStatus).toBe(200);
      expect(edit.statusCode).toBe(409);
      expect(edit.json().code).toBe('PLAN_VERSION_CONFLICT');
    } finally {
      latch.restore();
    }
    const current = (await get(hostToken, `/v1/rooms/${roomId}/plans/current`)).json() as PlanDto;
    expect(current.id).toBe(plan.id);
    expect(current.stops.find((s) => s.id === target.id)!.isLocked).toBe(true);
  });

  it('a lock on a superseded plan is refused instead of silently lost', async () => {
    const { hostToken, plan } = await plannedRoom();
    const next = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: plan.stops.map((s) => ({ placeId: s.placeId })),
    });
    expect(next.statusCode).toBe(200);
    const res = await patch(hostToken, `/v1/plans/${plan.id}/stops/${plan.stops[0]!.id}/lock`, {
      locked: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLAN_NOT_CURRENT');
  });

  it('a constraint change while an edit computes cannot publish a falsely fresh plan', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'matching' });
    const latch = latchCreatePlanVersion(async () => changeConstraints(hostToken, roomId));
    try {
      const edit = await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: plan.stops.map((s) => ({ placeId: s.placeId, isOptional: true })),
      });
      expect(edit.statusCode).toBe(409);
      expect(edit.json().code).toBe('PLAN_STALE');
    } finally {
      latch.restore();
    }
    const fresh = (await plansOf(roomId)).filter((p) => !p.isStale);
    expect(fresh).toHaveLength(0);
  });

  it('a constraint change while regenerate computes cannot publish a falsely fresh plan', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'matching' });
    const latch = latchCreatePlanVersion(async () => changeConstraints(hostToken, roomId));
    try {
      const regen = await post(hostToken, `/v1/plans/${plan.id}/regenerate`, {});
      expect(regen.statusCode).toBe(409);
      expect(regen.json().code).toBe('PLAN_STALE');
    } finally {
      latch.restore();
    }
    const current = (await get(hostToken, `/v1/rooms/${roomId}/plans/current`)).json() as PlanDto;
    expect(current.id).toBe(plan.id);
    expect(current.isStale).toBe(true);
  });

  it('an edit that lands while regenerate computes makes regenerate 409', async () => {
    const { hostToken, roomId, plan } = await plannedRoom();
    let editStatus = 0;
    let fired = false;
    const latch = latchCreatePlanVersion(async () => {
      if (fired) return;
      fired = true;
      const res = await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: plan.stops.map((s) => ({ placeId: s.placeId, isOptional: true })),
      });
      editStatus = res.statusCode;
    });
    try {
      const regen = await post(hostToken, `/v1/plans/${plan.id}/regenerate`, {});
      expect(editStatus).toBe(200);
      expect(regen.statusCode).toBe(409);
      expect(regen.json().code).toBe('PLAN_VERSION_CONFLICT');
    } finally {
      latch.restore();
    }
    expect(await plansOf(roomId)).toHaveLength(3);
  });
});

describe('migration 0068 (ADR-0028)', () => {
  it('defaults historical rows to required, and the documented down/up rehearses cleanly', async () => {
    const { plan } = await plannedRoom();
    const client = await pool.connect();
    try {
      // A writer that predates the column omits it: the row is required.
      const inserted = await client.query<{ is_optional: boolean }>(
        `insert into plan_stops (plan_id, place_id, position, duration_minutes)
         values ($1, $2, 99, 30) returning is_optional`,
        [plan.id, placeIds['Bar Vui']],
      );
      expect(inserted.rows[0]!.is_optional).toBe(false);

      await client.query('begin');
      await client.query('alter table plan_stops drop column is_optional');
      const gone = await client.query(
        `select 1 from information_schema.columns
         where table_name = 'plan_stops' and column_name = 'is_optional'`,
      );
      expect(gone.rowCount).toBe(0);
      const up = readFileSync(
        path.resolve(__dirname, '../../../migrations/0068_plan-stops-optional.sql'),
        'utf8',
      );
      await client.query(up);
      // Re-applied forward: every row, old and new, reads as required.
      const after = await client.query<{ n: string }>(
        `select count(*) as n from plan_stops where is_optional`,
      );
      expect(after.rows[0]!.n).toBe('0');
      await client.query('rollback');
    } finally {
      await client.query('delete from plan_stops where position = 99');
      client.release();
    }
  });
});
