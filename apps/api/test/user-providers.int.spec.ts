import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { OutboxDispatcher, PrivacyJobs } from '@gogo/modules';
import { AREA_AUTOCOMPLETE, FakePush, PLACE_PROVIDER } from '@gogo/providers';
import type { FakeAreaAutocomplete, FakePlaceProvider } from '@gogo/providers';

/**
 * BE-BFF-009/010/011/013/016 + DB-010 acceptance: place import pipeline with
 * reason codes, areas fallback, saved/review/privacy, outbox fan-out,
 * retention jobs.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let fakePlaces: FakePlaceProvider;
let fakeAreas: FakeAreaAutocomplete;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.30.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: email.split('@')[0] },
  });
  const b = res.json();
  return { token: b.accessToken as string, userId: b.userId as string };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_user_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_MAPS_API_KEY = ''; // force fakes

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  await db.insert(schema.serviceAreas).values({
    key: 'hcm_q1',
    name: 'Quận 1, TP.HCM',
    centerLat: 10.7769,
    centerLng: 106.7009,
    radiusM: 5000,
  });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  fakePlaces = app.get(PLACE_PROVIDER);
  fakeAreas = app.get(AREA_AUTOCOMPLETE);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('place import (BE-BFF-013, FR-PLACE-001..006)', () => {
  it('verifies a good link → community_submitted place with provider facts', async () => {
    const { token } = await register('imp1@gogo.vn');
    fakePlaces.seed({
      providerPlaceId: 'good-place',
      name: 'Quán Mới Nổi',
      lat: 10.778,
      lng: 106.702,
      rating: 4.6,
      ratingCount: 120,
      priceLevel: 2,
    });
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { url: 'https://maps.google.com/maps?place_id=good-place' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('verified');
    expect(body.placeId).toBeTruthy();

    const [place] = await db.select().from(schema.places).where(eq(schema.places.id, body.placeId));
    expect(place!.status).toBe('community_submitted');
    expect(place!.name).toBe('Quán Mới Nổi');
    expect(place!.nameNormalized).toBe('quan moi noi');
    const sources = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.placeId, body.placeId));
    expect(sources[0]).toMatchObject({ provider: 'google', externalId: 'good-place' });

    // Polling endpoint returns the same status for the owner.
    const poll = await api().inject({
      method: 'GET',
      url: `/v1/places/imports/${body.id}`,
      headers: auth(token),
    });
    expect(poll.json().status).toBe('verified');
  });

  it('dedups by provider id instead of creating a duplicate (FR-PLACE-005)', async () => {
    const { token } = await register('imp2@gogo.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { url: 'https://maps.google.com/maps?place_id=good-place' },
    });
    expect(res.json().status).toBe('verified');
    const sources = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.externalId, 'good-place'));
    expect(sources).toHaveLength(1);
  });

  it('returns exact reason codes per failed rule (FR-PLACE-003)', async () => {
    const { token } = await register('imp3@gogo.vn');
    const cases: [string, Parameters<FakePlaceProvider['seed']>[0] | null, string][] = [
      ['not-a-maps-link', null, 'INVALID_URL'],
      ['https://maps.google.com/maps?place_id=ghost', null, 'NOT_FOUND'],
      [
        'https://maps.google.com/maps?place_id=few-reviews',
        { providerPlaceId: 'few-reviews', ratingCount: 3, lat: 10.777, lng: 106.701 },
        'INSUFFICIENT_REVIEWS',
      ],
      [
        'https://maps.google.com/maps?place_id=low-rating',
        { providerPlaceId: 'low-rating', rating: 2.9, lat: 10.777, lng: 106.701 },
        'LOW_RATING',
      ],
      [
        'https://maps.google.com/maps?place_id=far-away',
        { providerPlaceId: 'far-away', lat: 21.0, lng: 105.8 },
        'OUT_OF_AREA',
      ],
      [
        'https://maps.google.com/maps?place_id=closed-forever',
        {
          providerPlaceId: 'closed-forever',
          businessStatus: 'CLOSED_PERMANENTLY',
          lat: 10.777,
          lng: 106.701,
        },
        'CLOSED',
      ],
    ];
    for (const [url, seed, expected] of cases) {
      if (seed) fakePlaces.seed(seed);
      const res = await api().inject({
        method: 'POST',
        url: '/v1/places/imports',
        remoteAddress: ip(),
        headers: auth(token),
        payload: { url: url.startsWith('http') ? url : `https://example.com/${url}` },
      });
      if (expected === 'INVALID_URL') {
        // Either schema-level rejection or pipeline INVALID_URL — both 4xx/rejected.
        if (res.statusCode === 400) continue;
      }
      expect(res.json().status).toBe('rejected');
      expect(res.json().reasonCode).toBe(expected);
    }
  });

  it('provider outage → PROVIDER_ERROR rejection, no catalog record', async () => {
    const { token } = await register('imp4@gogo.vn');
    fakePlaces.failing = true;
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { url: 'https://maps.google.com/maps?place_id=whatever' },
    });
    fakePlaces.failing = false;
    expect(res.json().status).toBe('rejected');
    expect(res.json().reasonCode).toBe('PROVIDER_ERROR');
  });
});

describe('areas autocomplete (BE-BFF-016, FR-PLACE-007)', () => {
  it('proxies provider predictions with attribution', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/places/areas?query=Qu%E1%BA%ADn&sessionToken=sess-12345678',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('provider');
    expect(res.json().predictions.length).toBeGreaterThan(0);
  });

  it('falls back to static service areas when provider fails', async () => {
    fakeAreas.failing = true;
    const res = await api().inject({
      method: 'GET',
      url: '/v1/places/areas?query=quan%201&sessionToken=sess-12345678',
    });
    fakeAreas.failing = false;
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('fallback');
    expect(res.json().predictions[0].key).toBe('hcm_q1');
  });
});

describe('saved/review/profile/privacy (BE-BFF-009)', () => {
  it('save/unsave, review lifecycle, profile update', async () => {
    const { token } = await register('user1@gogo.vn');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Save Me',
        nameNormalized: 'x',
        geom: { x: 106.7, y: 10.77 },
        status: 'published',
      })
      .returning();

    const save = await api().inject({
      method: 'PUT',
      url: `/v1/me/saved/place/${place!.id}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    expect(save.statusCode).toBe(200);
    const list = await api().inject({ method: 'GET', url: '/v1/me/saved', headers: auth(token) });
    expect(list.json()).toHaveLength(1);

    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { placeId: place!.id, rating: 5, text: 'Tuyệt!' },
    });
    expect(review.statusCode).toBe(201);
    expect(review.json().status).toBe('pending'); // moderation first

    // Another user cannot edit my review (ownership rule FR-USER-002).
    const { token: other } = await register('user2@gogo.vn');
    const foreignEdit = await api().inject({
      method: 'PATCH',
      url: `/v1/reviews/${review.json().id}`,
      remoteAddress: ip(),
      headers: auth(other),
      payload: { rating: 1 },
    });
    expect(foreignEdit.statusCode).toBe(403);

    const profile = await api().inject({
      method: 'PATCH',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { displayName: 'Tên Mới' },
    });
    expect(profile.json().displayName).toBe('Tên Mới');
  });

  it('export returns owned data; delete anonymizes and kills sessions', async () => {
    const { token, userId } = await register('gone@gogo.vn');
    const exportRes = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.json().profile.email).toBe('gone@gogo.vn');

    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    expect(del.statusCode).toBe(200);

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.status).toBe('deleted');
    expect(user!.email).toBeNull();
    expect(user!.passwordHash).toBeNull();

    // Email is free for re-registration (partial unique index).
    const again = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'gone@gogo.vn', password: 'sufficiently-long-pw', displayName: 'Mới' },
    });
    expect(again.statusCode).toBe(201);
  });
});

describe('outbox dispatcher (BE-BFF-010)', () => {
  it('fans out plan.published to member notifications and push, idempotently', async () => {
    const { userId } = await register('notif@gogo.vn');
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `nf-${Date.now()}`,
        type: 'group',
        decisionMode: 'vote',
        hostUserId: userId,
        status: 'ready',
      })
      .returning();
    await db.insert(schema.roomMembers).values({
      roomId: room!.id,
      userId,
      role: 'host',
      displayName: 'Host',
    });
    await db.insert(schema.deviceTokens).values({
      userId,
      platform: 'ios',
      token: `device-${Date.now()}`,
    });
    await db.insert(schema.outboxEvents).values({
      eventType: 'plan.published',
      resourceType: 'room',
      resourceId: room!.id,
      payload: {},
    });

    const push = new FakePush();
    const dispatcher = new OutboxDispatcher(db as never, push);
    await dispatcher.dispatchBatch();
    await dispatcher.dispatchBatch(); // second run must not duplicate

    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.kind).toBe('plan_ready');
    expect(push.sent).toHaveLength(1);

    const inbox = await api().inject({
      method: 'GET',
      url: '/v1/me/notifications',
      headers: auth((await loginAgain('notif@gogo.vn')).token),
    });
    expect(inbox.json().notifications[0].kind).toBe('plan_ready');
  });

  it('respects per-kind opt-out for push while keeping the in-app row', async () => {
    const { userId, token } = await register('optout@gogo.vn');
    await api().inject({
      method: 'PUT',
      url: '/v1/me/notification-preferences',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { channel: 'push', kind: 'plan_ready', enabled: false },
    });
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `oo-${Date.now()}`,
        type: 'group',
        decisionMode: 'vote',
        hostUserId: userId,
        status: 'ready',
      })
      .returning();
    await db.insert(schema.roomMembers).values({
      roomId: room!.id,
      userId,
      role: 'host',
      displayName: 'H',
    });
    await db.insert(schema.deviceTokens).values({
      userId,
      platform: 'android',
      token: `device-oo-${Date.now()}`,
    });
    await db.insert(schema.outboxEvents).values({
      eventType: 'plan.published',
      resourceType: 'room',
      resourceId: room!.id,
      payload: {},
    });

    const push = new FakePush();
    await new OutboxDispatcher(db as never, push).dispatchBatch();
    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(notifications).toHaveLength(1); // in-app kept
    expect(push.sent).toHaveLength(0); // push suppressed
  });
});

describe('privacy retention jobs (DB-010)', () => {
  it('purges expired data and clears exact origins; dry-run reports only', async () => {
    await db.insert(schema.loginAttempts).values({
      identifierHash: 'x',
      ipHash: 'y',
      succeeded: false,
      createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
    });
    const { userId } = await register('privacy@gogo.vn');
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `pv-${Date.now()}`,
        type: 'couple',
        decisionMode: 'match',
        hostUserId: userId,
        status: 'completed',
      })
      .returning();
    await db.execute(
      sql`update rooms set updated_at = now() - interval '60 days' where id = ${room!.id}`,
    );
    await db.insert(schema.roomConstraints).values({
      roomId: room!.id,
      version: 1,
      budgetMode: 'total',
      budgetAmount: 100_000,
      currency: 'VND',
      originLat: 10.777,
      originLng: 106.701,
      dietaryKeys: [],
      accessibilityKeys: [],
    });

    const jobs = new PrivacyJobs(db as never);
    const dry = await jobs.run(true);
    expect(dry.loginAttemptsPurged).toBeGreaterThanOrEqual(1);
    expect(dry.originsCleared).toBeGreaterThanOrEqual(1);

    // Dry run wrote nothing.
    const [stillThere] = await db
      .select()
      .from(schema.roomConstraints)
      .where(eq(schema.roomConstraints.roomId, room!.id));
    expect(stillThere!.originLat).not.toBeNull();

    await jobs.run(false);
    const [cleared] = await db
      .select()
      .from(schema.roomConstraints)
      .where(eq(schema.roomConstraints.roomId, room!.id));
    expect(cleared!.originLat).toBeNull();
    expect(cleared!.originText).toBe(stillThere!.originText); // text survives
    const attempts = await db.select().from(schema.loginAttempts);
    expect(
      attempts.filter((a) => a.createdAt.getTime() < Date.now() - 30 * 24 * 3600 * 1000),
    ).toHaveLength(0);
  });
});

async function loginAgain(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw' },
  });
  return { token: res.json().accessToken as string };
}
