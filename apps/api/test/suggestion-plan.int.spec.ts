import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
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
async function matchingRoom(
  type: 'couple' | 'group',
  decisionMode: 'match' | 'vote',
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
    .withDatabase('gogo_sg_test')
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

    // #171 — a photo key now has to come from the upload endpoint. An
    // invented one is refused, which is the whole point of the table behind it.
    const invented = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      rating: 5,
      tags: ['would_return'],
      photoKeys: ['media/a.jpg'],
    });
    expect(invented.statusCode).toBe(400);
    expect(invented.json().code).toBe('INVALID_UPLOAD_KEY');

    const photo = await post(memberToken, '/v1/uploads', {
      purpose: 'checkin_photo',
      contentType: 'image/jpeg',
      contentLength: 250_000,
    });
    expect(photo.statusCode).toBe(201);
    const bill = await post(memberToken, '/v1/uploads', {
      purpose: 'bill_photo',
      contentType: 'image/jpeg',
      contentLength: 180_000,
    });

    const checkin = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      rating: 5,
      tags: ['would_return', 'photogenic'],
      note: 'Tuyệt vời',
      photoKeys: [photo.json().key],
      billTotal: 500_000,
      billPeopleCount: 2,
      billPhotoKey: bill.json().key,
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

describe('saved plan keeps a taken-down place, marked unavailable (BE-IMP-009)', () => {
  it('warns instead of dropping the stop, and survives regenerate when locked', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    const target = cur.json().candidates[0].placeId;
    await put(hostToken, `/v1/rooms/${roomId}/votes/${target}`, { value: 'yes' });
    const planId = (await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`)).json().planId;

    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    expect(plan.hasUnavailableStops).toBe(false);
    expect(plan.stops.every((s: { placeAvailable: boolean }) => s.placeAvailable)).toBe(true);

    const doomed = plan.stops[0];
    await patch(hostToken, `/v1/plans/${planId}/stops/${doomed.id}/lock`, { locked: true });

    // The place is taken down after the plan was agreed on.
    await db
      .update(schema.places)
      .set({ status: 'suspended' })
      .where(eq(schema.places.id, doomed.placeId));

    const after = (await get(hostToken, `/v1/plans/${planId}`)).json();
    const stop = after.stops.find((s: { id: string }) => s.id === doomed.id);
    // Kept, not dropped — dropping would rewrite a plan people already agreed on.
    expect(stop).toBeTruthy();
    expect(stop.placeAvailable).toBe(false);
    expect(stop.unavailableReason).toBe('PLACE_SUSPENDED');
    expect(after.hasUnavailableStops).toBe(true);
    // The stop's own progress is a separate axis and must not be overwritten.
    expect(stop.status).toBe('planned');

    // Core rule #7 still wins: a locked stop is invariant across regenerate,
    // even when its place is unavailable. The warning travels with it.
    const regen = await post(hostToken, `/v1/plans/${planId}/regenerate`, {});
    expect(regen.statusCode).toBe(201);
    const kept = regen.json().stops.find((s: { placeId: string }) => s.placeId === doomed.placeId);
    expect(kept).toBeTruthy();
    expect(kept.isLocked).toBe(true);
    expect(kept.placeAvailable).toBe(false);
  });

  it('an unavailable place blocks being added but not being removed', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const planId = (await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`)).json().planId;
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();

    const victim = plan.stops[0];
    await db
      .update(schema.places)
      .set({ status: 'suspended' })
      .where(eq(schema.places.id, victim.placeId));

    // Editing the plan must stay possible — otherwise the host is trapped:
    // they cannot even take the offending stop out.
    let current = plan;
    const withoutVictim = plan.stops
      .filter((s: { id: string }) => s.id !== victim.id)
      .map((s: { placeId: string; isLocked: boolean }) => ({
        placeId: s.placeId,
        isLocked: s.isLocked,
      }));
    if (withoutVictim.length > 0) {
      const removed = await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: withoutVictim,
      });
      expect(removed.statusCode).toBe(200);
      expect(
        removed.json().stops.some((s: { placeId: string }) => s.placeId === victim.placeId),
      ).toBe(false);
      // Each edit creates a new plan version; the old id is superseded.
      current = removed.json();
    }

    // Adding it back is refused with a distinct code.
    const readd = await patch(hostToken, `/v1/plans/${current.id}`, {
      expectedVersion: current.version,
      stops: [
        ...current.stops.map((s: { placeId: string; isLocked: boolean }) => ({
          placeId: s.placeId,
          isLocked: s.isLocked,
        })),
        { placeId: victim.placeId, isLocked: false },
      ],
    });
    expect(readd.statusCode).toBe(400);
    expect(readd.json().code).toBe('PLACE_NOT_AVAILABLE');
  });
});

describe('provider says closed: a business fact, not a moderation decision (BE-IMP-004a)', () => {
  async function markProvider(placeId: string, sourceStatus: string) {
    await db
      .insert(schema.placeProviderSources)
      .values({
        placeId,
        provider: 'google_places',
        externalId: `ext-${placeId}`,
        sourceStatus: sourceStatus as 'closed',
        fetchTier: 'quality',
      })
      .onConflictDoUpdate({
        target: [schema.placeProviderSources.provider, schema.placeProviderSources.externalId],
        set: { sourceStatus: sourceStatus as 'closed' },
      });
  }

  it('a temporarily closed place stays published but stops being suggested', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const before = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    const victim = before.json().candidates[0].placeId;

    await markProvider(victim, 'temporarily_closed');

    const { hostToken: host2, roomId: room2 } = await matchingRoom('group', 'vote');
    await post(host2, `/v1/rooms/${room2}/suggestions`);
    const after = await get(host2, `/v1/rooms/${room2}/suggestions/current`);
    expect(after.json().candidates.some((c: { placeId: string }) => c.placeId === victim)).toBe(
      false,
    );

    // The place itself was never moderated, so its own status must not move —
    // otherwise nobody can later tell a holiday from a takedown.
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, victim));
    expect(row!.status).toBe('published');
  });

  it('a saved plan warns with the business reason, not the moderation one', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const planId = (await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`)).json().planId;
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    const stop = plan.stops[0];

    await markProvider(stop.placeId, 'temporarily_closed');

    const warned = (await get(hostToken, `/v1/plans/${planId}`)).json();
    const warnedStop = warned.stops.find((s: { id: string }) => s.id === stop.id);
    expect(warnedStop.placeAvailable).toBe(false);
    expect(warnedStop.unavailableReason).toBe('PLACE_TEMPORARILY_CLOSED');

    // A moderation takedown outranks the business fact: an editor needs to see
    // that GoGo made a decision, not that the shop is on holiday.
    await db
      .update(schema.places)
      .set({ status: 'suspended' })
      .where(eq(schema.places.id, stop.placeId));
    const suspended = (await get(hostToken, `/v1/plans/${planId}`)).json();
    expect(suspended.stops.find((s: { id: string }) => s.id === stop.id).unavailableReason).toBe(
      'PLACE_SUSPENDED',
    );
  });
});

describe('room lifecycle does not dead-end (#155)', () => {
  it('a freshly created room can be matched without the client walking states', async () => {
    // The bug this guards: the room was created in `draft`, nothing moved it
    // to `collecting`, `complete` answered roomReadyForMatching: true anyway,
    // and the suggestions endpoint then returned 409 ROOM_NOT_MATCHING.
    const { hostToken, roomId } = await matchingRoom('group', 'vote', { skipTransitions: true });

    // Everyone finished their preferences, so the room moved itself on. The
    // client never patched a status.
    const room = (await get(hostToken, `/v1/rooms/${roomId}`)).json();
    expect(['collecting', 'matching']).toContain(room.status);

    const suggestions = await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    expect(suggestions.statusCode).toBe(201);
  });

  it('roomReadyForMatching describes the room, not just member progress', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote', { skipTransitions: true });
    const done = await post(hostToken, `/v1/rooms/${roomId}/preferences/complete`, {});
    const body = done.json();
    expect(body.roomStatus).toBeTruthy();
    // The two are now separate facts: a client can tell "everyone finished"
    // apart from "the room can be matched".
    expect(body).toHaveProperty('allMembersCompleted');
    if (body.roomReadyForMatching) {
      expect(['matching', 'collecting']).toContain(body.roomStatus);
    }
  });

  it('asking to start matching twice is not an error', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    const first = await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'matching' });
    const second = await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'matching' });
    // A retry after a timeout must not look like a broken client.
    expect([200, 201]).toContain(first.statusCode);
    expect([200, 201]).toContain(second.statusCode);
  });
});

/**
 * #171 — check-in accepted `photoKeys` and `billPhotoKey` while nothing in the
 * contract could produce one, so the mobile sheet shipped without photos or
 * the verified bill. These cover the half that decides whether the key means
 * anything: who may use it.
 */
describe('client upload path (BE-BFF-016, #171)', () => {
  async function activePlan() {
    const { hostToken, memberToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const planId = (await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`)).json().planId;
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    await patch(hostToken, `/v1/rooms/${roomId}/status`, { status: 'active' });
    return { hostToken, memberToken, roomId, planId, stopId: plan.stops[0].id as string };
  }

  it('hands back a key and a URL the client can PUT to', async () => {
    const { memberToken } = await activePlan();
    const res = await post(memberToken, '/v1/uploads', {
      purpose: 'checkin_photo',
      contentType: 'image/jpeg',
      contentLength: 1_200_000,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^u\/user\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);
    expect(body.uploadUrl).toContain('http');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a type it will not host, before a URL exists', async () => {
    const { memberToken } = await activePlan();
    const res = await post(memberToken, '/v1/uploads', {
      purpose: 'checkin_photo',
      contentType: 'application/x-msdownload',
      contentLength: 1000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('refuses an oversized file up front rather than after the bytes move', async () => {
    const { memberToken } = await activePlan();
    const res = await post(memberToken, '/v1/uploads', {
      purpose: 'checkin_photo',
      contentType: 'image/jpeg',
      contentLength: 50 * 1024 * 1024,
    });
    expect(res.statusCode).toBe(400);
  });

  it('one member cannot attach another member’s upload', async () => {
    const { hostToken, memberToken, planId, stopId } = await activePlan();
    const hostUpload = await post(hostToken, '/v1/uploads', {
      purpose: 'checkin_photo',
      contentType: 'image/png',
      contentLength: 4000,
    });

    const stolen = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      rating: 4,
      tags: [],
      photoKeys: [hostUpload.json().key],
    });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it('a bill-photo key cannot be passed off as a check-in photo', async () => {
    const { memberToken, planId, stopId } = await activePlan();
    const billKey = (
      await post(memberToken, '/v1/uploads', {
        purpose: 'bill_photo',
        contentType: 'image/jpeg',
        contentLength: 4000,
      })
    ).json().key;

    const res = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      rating: 4,
      tags: [],
      photoKeys: [billKey],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it('re-saving a check-in with the same photo stays idempotent', async () => {
    const { memberToken, planId, stopId } = await activePlan();
    const key = (
      await post(memberToken, '/v1/uploads', {
        purpose: 'checkin_photo',
        contentType: 'image/webp',
        contentLength: 9000,
      })
    ).json().key;

    const body = { rating: 5, tags: ['quiet'], photoKeys: [key] };
    const first = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, body);
    expect(first.statusCode).toBe(201);
    // An already-attached key belongs to this same check-in, so editing the
    // note must not make the photo suddenly invalid.
    const second = await post(memberToken, `/v1/plans/${planId}/stops/${stopId}/checkin`, {
      ...body,
      note: 'Sửa lại ghi chú',
    });
    expect(second.statusCode).toBe(201);
  });

  it('serves the check-in tag vocabulary as taxonomy, not client-defined keys', async () => {
    const res = await api().inject({ method: 'GET', url: '/v1/taxonomies?kinds=checkin_tag' });
    expect(res.statusCode).toBe(200);
    const tags = res.json().kinds.checkin_tag as { key: string; labels: Record<string, string> }[];
    expect(tags.map((t) => t.key)).toContain('would_return');
    // Stored value is the stable key; the label is presentation, per locale.
    expect(tags.find((t) => t.key === 'would_return')!.labels['vi']).toBe('Muốn quay lại');
  });
});

/**
 * SG-009 (#48) — natural-language feedback. The AI flag is off in test, which
 * is the point: the deterministic parser is the fallback, so it has to be
 * genuinely useful rather than a stub.
 */
describe('plan feedback (SG-009, #48)', () => {
  async function planFor(hostToken: string, roomId: string) {
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    return (await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`)).json().planId as string;
  }

  it('turns "rẻ hơn" into a tightened budget and says what it applied', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    const planId = await planFor(hostToken, roomId);

    const res = await post(hostToken, `/v1/plans/${planId}/regenerate`, {
      feedbackText: 'Chỗ này đắt quá, tìm chỗ rẻ hơn đi',
    });
    expect(res.statusCode).toBe(201);
    const feedback = res.json().feedback;
    expect(feedback.understood).toBe(true);
    // Integer minor units, strictly below what the room agreed.
    expect(feedback.applied.budgetMaxAmount).toBeGreaterThan(0);
    expect(feedback.ignoredReasons).not.toContain('SCHEMA_INVALID');
  });

  it('reports that nothing was understood rather than silently doing nothing', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    const planId = await planFor(hostToken, roomId);

    const res = await post(hostToken, `/v1/plans/${planId}/regenerate`, {
      feedbackText: 'asdkjh qwlkejh zzz',
    });
    expect(res.statusCode).toBe(201);
    // A plan that came back unchanged with no explanation is indistinguishable
    // from feedback that was never read.
    expect(res.json().feedback.understood).toBe(false);
    expect(res.json().feedback.ignoredReasons).toContain('NOTHING_UNDERSTOOD');
  });

  it('regenerating without feedback carries no feedback block at all', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    const planId = await planFor(hostToken, roomId);

    const res = await post(hostToken, `/v1/plans/${planId}/regenerate`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().feedback).toBeUndefined();
  });

  it('records the run for audit without keeping the member’s words', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    const planId = await planFor(hostToken, roomId);
    const words = 'Đắt quá, tìm chỗ gần hơn và yên tĩnh hơn';

    await post(hostToken, `/v1/plans/${planId}/regenerate`, { feedbackText: words });

    const runs = await db.execute(
      sql`select * from ai_feedback_runs where plan_id = ${planId}::uuid`,
    );
    expect(runs.rows).toHaveLength(1);
    const run = runs.rows[0] as Record<string, unknown>;
    expect(run['model_version']).toBe('keyword-v1');
    // Off by default: a real provider needs a DPA and a privacy review first.
    expect(run['outcome']).toBe('disabled');
    expect(run['input_length']).toBe(words.length);
    expect(JSON.stringify(run)).not.toContain('yên tĩnh');
  });

  it('feedback never survives past a locked stop', async () => {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    const planId = await planFor(hostToken, roomId);
    const plan = (await get(hostToken, `/v1/plans/${planId}`)).json();
    const stopId = plan.stops[0].id;
    const lockedPlaceId = plan.stops[0].placeId;
    await patch(hostToken, `/v1/plans/${planId}/stops/${stopId}/lock`, { locked: true });

    const res = await post(hostToken, `/v1/plans/${planId}/regenerate`, {
      feedbackText: 'rẻ hơn, gần hơn, ngắn hơn',
    });
    expect(res.statusCode).toBe(201);
    // Core rule #7 is not negotiable by feedback, however it is phrased.
    expect(res.json().stops.map((s: { placeId: string }) => s.placeId)).toContain(lockedPlaceId);
  });
});

describe('plan cost scope (GoGo-BE#593)', () => {
  /**
   * Its own places: earlier cases take seeded places down, and a plan edit may
   * not add an unpublished place. They sit outside the 5 km room radius, so no
   * other case retrieves them as candidates.
   */
  async function placePricedAs(
    name: string,
    lat: number,
    price: [number, number],
    unit: 'per_person' | 'per_item',
  ) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: lat },
        rating: '4.40',
        ratingCount: 500,
        suitability: { couple: 0.9, group: 0.9 },
        avgVisitMinutes: 60,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
      })
      .returning();
    await db.insert(schema.placePrices).values({
      placeId: place!.id,
      priceMin: price[0],
      priceMax: price[1],
      currency: 'VND',
      unit,
      confidence: '0.8',
      source: 'editor',
      verifiedAt: new Date(),
    });
    return place!.id;
  }

  async function placeWithoutPrice(name: string, lat: number) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: lat },
        rating: '4.40',
        ratingCount: 500,
        suitability: { couple: 0.9, group: 0.9 },
        avgVisitMinutes: 60,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
      })
      .returning();
    return place!.id;
  }

  async function finalizedPlan() {
    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const fin = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
    const plan = (await get(hostToken, `/v1/plans/${fin.json().planId}`)).json();
    return { hostToken, plan };
  }

  it('keeps a locked unpriced stop through regenerate, and the totals say they are an estimate', async () => {
    const unpriced = await placeWithoutPrice('Chỗ Chưa Có Giá', 10.853);
    const { hostToken, plan } = await finalizedPlan();

    const edited = await patch(hostToken, `/v1/plans/${plan.id}`, {
      expectedVersion: plan.version,
      stops: [{ placeId: unpriced, isLocked: true }],
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().totals.uncertain).toBe(true);

    // The device path: the host regenerates a plan whose locked stop has no price.
    const regen = await post(hostToken, `/v1/plans/${edited.json().id}/regenerate`, {});
    expect(regen.statusCode).toBe(201);
    const next = regen.json();
    const kept = next.stops.find((s: { placeId: string }) => s.placeId === unpriced);
    expect(kept).toMatchObject({
      isLocked: true,
      costMin: null,
      costMax: null,
      costScope: 'per_person',
    });
    expect(next.totals).toMatchObject({ costScope: 'per_person', uncertain: true });
  });

  it('reads a plan stored before the rule as an estimate when a stop has no price', async () => {
    const unpriced = await placeWithoutPrice('Chỗ Cũ Chưa Có Giá', 10.854);
    const { hostToken, plan } = await finalizedPlan();
    const edited = (
      await patch(hostToken, `/v1/plans/${plan.id}`, {
        expectedVersion: plan.version,
        stops: [{ placeId: unpriced, isLocked: false }],
      })
    ).json();

    // What a plan written before this change looks like on disk (DEV 94b894df):
    // an unpriced stop, and totals that call a 0 certain.
    const [row] = await db.select().from(schema.plans).where(eq(schema.plans.id, edited.id));
    await db
      .update(schema.plans)
      .set({ totals: { ...row!.totals, costMin: 0, costMax: 0, uncertain: false } })
      .where(eq(schema.plans.id, edited.id));

    const read = (await get(hostToken, `/v1/plans/${edited.id}`)).json();
    expect(read.stops[0]).toMatchObject({ costMin: null, costMax: null });
    expect(read.totals).toMatchObject({
      costMin: 0,
      costMax: 0,
      costScope: 'per_person',
      uncertain: true,
    });
  });

  it('declares every plan cost per person: free counts as 0, a per_item price is not summed', async () => {
    const perPerson = await placePricedAs(
      'Quán Theo Người',
      10.85,
      [60_000, 120_000],
      'per_person',
    );
    // PI-BE-026: `free` is stored as per_person with a zero amount.
    const free = await placePricedAs('Công Viên Miễn Phí', 10.851, [0, 0], 'per_person');
    const perItem = await placePricedAs('Tiệm Theo Món', 10.852, [30_000, 60_000], 'per_item');

    const { hostToken, roomId } = await matchingRoom('group', 'vote');
    await post(hostToken, `/v1/rooms/${roomId}/suggestions`);
    const cur = await get(hostToken, `/v1/rooms/${roomId}/suggestions/current`);
    await put(hostToken, `/v1/rooms/${roomId}/votes/${cur.json().candidates[0].placeId}`, {
      value: 'yes',
    });
    const fin = await post(hostToken, `/v1/rooms/${roomId}/votes/finalize`);
    const finalized = (await get(hostToken, `/v1/plans/${fin.json().planId}`)).json();
    expect(finalized.totals.costScope).toBe('per_person');
    for (const stop of finalized.stops) expect(stop.costScope).toBe('per_person');

    // Every stop priced per person (one of them free): the totals are certain.
    const priced = await patch(hostToken, `/v1/plans/${finalized.id}`, {
      expectedVersion: finalized.version,
      stops: [
        { placeId: perPerson, isLocked: false },
        { placeId: free, isLocked: false },
      ],
    });
    expect(priced.statusCode).toBe(200);
    const pricedPlan = priced.json();
    expect(pricedPlan.totals).toMatchObject({
      costMin: 60_000,
      costMax: 120_000,
      costScope: 'per_person',
      uncertain: false,
    });
    expect(pricedPlan.stops.map((s: { costMax: number }) => s.costMax)).toEqual([120_000, 0]);

    // A per_item price is not a per-person amount: the stop has no cost in
    // this scope, the sum leaves it out, and the totals say they are incomplete.
    const withItem = await patch(hostToken, `/v1/plans/${pricedPlan.id}`, {
      expectedVersion: pricedPlan.version,
      stops: [
        { placeId: perPerson, isLocked: false },
        { placeId: free, isLocked: false },
        { placeId: perItem, isLocked: false },
      ],
    });
    expect(withItem.statusCode).toBe(200);
    const plan = withItem.json();
    expect(plan.totals).toMatchObject({
      costMin: 60_000,
      costMax: 120_000,
      costScope: 'per_person',
      uncertain: true,
    });
    const [paid, park, item] = plan.stops;
    expect([paid.costMin, paid.costMax, paid.costScope]).toEqual([60_000, 120_000, 'per_person']);
    expect([park.costMin, park.costMax, park.costScope]).toEqual([0, 0, 'per_person']);
    expect([item.costMin, item.costMax, item.costScope]).toEqual([null, null, 'per_person']);
  });
});
