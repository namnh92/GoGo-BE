import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { MAX_DELIVERY_ATTEMPTS, OutboxDispatcher, PrivacyJobs } from '@gogo/modules';
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
const IDENTITY_APP_ID = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
const identityKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

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
  process.env.GOOGLE_PLACES_API_KEY = ''; // force fakes
  // #199: a throwaway ES256 key pair generated for this run — the provider's
  // key never leaves SSM, and the assertions only need the public half.
  process.env.ONESIGNAL_APP_ID = IDENTITY_APP_ID;
  process.env.ONESIGNAL_IDENTITY_VERIFICATION_KEY = identityKeys.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
    .replace(/\n/g, '\\n');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
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
    const { token } = await register('imp1@gogo.id.vn');
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
    // #334 — provenance lives in `place_provider_sources`, the table dedup and
    // attribution both read. `place_sources` no longer has a Google writer.
    const sources = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.placeId, body.placeId));
    expect(sources[0]).toMatchObject({ provider: 'google_places', externalId: 'good-place' });
    const legacy = await db
      .select()
      .from(schema.placeSources)
      .where(eq(schema.placeSources.placeId, body.placeId));
    expect(legacy).toHaveLength(0);

    // Polling endpoint returns the same status for the owner.
    const poll = await api().inject({
      method: 'GET',
      url: `/v1/places/imports/${body.id}`,
      headers: auth(token),
    });
    expect(poll.json().status).toBe('verified');
  });

  it('dedups by provider id instead of creating a duplicate (FR-PLACE-005)', async () => {
    const { token } = await register('imp2@gogo.id.vn');
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
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'good-place'));
    expect(sources).toHaveLength(1);
  });

  it('returns exact reason codes per failed rule (FR-PLACE-003)', async () => {
    const { token } = await register('imp3@gogo.id.vn');
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
    const { token } = await register('imp4@gogo.id.vn');
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
    const { token } = await register('user1@gogo.id.vn');
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
    const { token: other } = await register('user2@gogo.id.vn');
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
    const { token, userId } = await register('gone@gogo.id.vn');
    const exportRes = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.json().profile.email).toBe('gone@gogo.id.vn');

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
      payload: { email: 'gone@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'Mới' },
    });
    expect(again.statusCode).toBe(201);
  });
});

describe('outbox dispatcher (BE-BFF-010)', () => {
  it('fans out plan.published to member notifications and push, idempotently', async () => {
    const { userId } = await register('notif@gogo.id.vn');
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
    // #193: one provider call per event, addressed by user id — never by the
    // device token registered above — and keyed by the event for provider-side
    // dedupe.
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.userIds).toEqual([userId]);
    expect(push.sent[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // #594 contract v1. No current plan exists yet, so the room is what opens.
    expect(push.sent[0]!.data).toEqual({
      type: 'plan_ready',
      version: '1',
      notificationId: push.sent[0]!.idempotencyKey,
      route: `gogo://room/${room!.id}`,
      entityType: 'room',
      entityId: room!.id,
      kind: 'plan_ready',
      roomId: room!.id,
      eventType: 'plan.published',
    });
    // Rendered copy in the account's locale (`vi` by default), never the kind key.
    expect(push.sent[0]!.headings).toEqual({
      vi: 'Kế hoạch đã sẵn sàng',
      en: 'Kế hoạch đã sẵn sàng',
    });
    expect(push.sent[0]!.body).not.toBe('plan_ready');

    const inbox = await api().inject({
      method: 'GET',
      url: '/v1/me/notifications',
      headers: auth((await loginAgain('notif@gogo.id.vn')).token),
    });
    expect(inbox.json().notifications[0].kind).toBe('plan_ready');
  });

  it('respects per-kind opt-out for push while keeping the in-app row', async () => {
    const { userId, token } = await register('optout@gogo.id.vn');
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

describe('push identity token (NTF-BE-008, #199)', () => {
  it('issues an ES256 JWT for the session user; a userId in the request changes nothing', async () => {
    const { token, userId } = await register('identity@gogo.id.vn');
    const res = await api().inject({
      method: 'GET',
      // Somebody else's id in the query is not read.
      url: '/v1/notifications/identity?userId=00000000-0000-4000-8000-000000000999',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { externalId: string; token: string; expiresAt: string };
    expect(body.externalId).toBe(userId);

    // Verified with the public half through node:crypto, the way the provider
    // would: ES256 is ECDSA P-256 over SHA-256 with an IEEE P1363 signature.
    const [headerB64, payloadB64, signatureB64] = body.token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(headerB64, 'base64url').toString())).toEqual({
      alg: 'ES256',
      typ: 'JWT',
    });
    expect(
      verifySignature(
        'sha256',
        Buffer.from(`${headerB64}.${payloadB64}`),
        { key: identityKeys.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signatureB64, 'base64url'),
      ),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as {
      iss: string;
      iat: number;
      exp: number;
      identity: { external_id: string };
    };
    expect(claims.iss).toBe(IDENTITY_APP_ID);
    expect(claims.identity.external_id).toBe(userId);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3_600);
    expect(new Date(body.expiresAt).getTime()).toBe(claims.exp * 1_000);
    // The response header set carries no token either.
    expect(JSON.stringify(res.headers)).not.toContain(body.token);
  });

  it('a guest has no push identity', async () => {
    const { userId } = await register('identity-host@gogo.id.vn');
    const roomCode = `ID${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await db.insert(schema.rooms).values({
      code: roomCode,
      type: 'group',
      decisionMode: 'vote',
      hostUserId: userId,
      status: 'collecting',
    });
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode, displayName: 'Khách' },
    });
    expect(guest.statusCode).toBe(201);
    const res = await api().inject({
      method: 'GET',
      url: '/v1/notifications/identity',
      remoteAddress: ip(),
      headers: auth(guest.json().accessToken as string),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('USER_ONLY');
  });

  it('requires authentication', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/notifications/identity',
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(401);
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
    const { userId } = await register('privacy@gogo.id.vn');
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

/**
 * BE-BFF-010 (#59) — delivery is at-least-once, which only works if a repeat
 * is harmless and a permanent failure eventually stops. Neither was true.
 */
describe('outbox delivery: retry, dead-letter, dedupe', () => {
  async function roomWithHost(email: string) {
    const { token, userId } = await register(email);
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `OB${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        type: 'group',
        decisionMode: 'vote',
        participantCount: 3,
        status: 'collecting',
        hostUserId: userId,
      })
      .returning();
    await db.insert(schema.roomMembers).values({
      roomId: room!.id,
      userId,
      role: 'host',
      displayName: 'Host',
    });
    return { token, userId, roomId: room!.id };
  }

  /** Reads fine, cannot write a notification — the failure a retry is for. */
  function brokenInsert() {
    return new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return () => {
            throw new Error('database unavailable');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  async function queueEvent(roomId: string) {
    const [event] = await db
      .insert(schema.outboxEvents)
      .values({
        eventType: 'plan.published',
        resourceType: 'room',
        resourceId: roomId,
        payload: {},
      })
      .returning();
    return event!;
  }

  it('a redelivered event does not put the same notification in an inbox twice', async () => {
    const { userId, roomId } = await roomWithHost('outbox-dedupe@gogo.id.vn');
    const event = await queueEvent(roomId);
    const dispatcher = new OutboxDispatcher(db as never, new FakePush());

    await dispatcher.dispatchBatch();
    // Force the redelivery an at-least-once queue is allowed to produce.
    await db
      .update(schema.outboxEvents)
      .set({ publishedAt: null })
      .where(eq(schema.outboxEvents.id, event.id));
    await dispatcher.dispatchBatch();

    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(notifications).toHaveLength(1);
    // A sole recipient holds the bare event id: the key the previous release
    // wrote, kept so that release cannot add a second row after a rollback.
    expect(notifications[0]!.dedupeKey).toBe(event.id);
  });

  /**
   * #584 — one event, several recipients. The inbox rows used to share the
   * event id as their dedupe key, and the global `notifications_dedupe_unique`
   * index (0026) let only the first of them in.
   */
  async function roomWithMembers(prefix: string, members: number) {
    const host = await roomWithHost(`${prefix}-host@gogo.id.vn`);
    const userIds = [host.userId];
    for (let i = 0; i < members; i++) {
      const { userId } = await register(`${prefix}-m${i}@gogo.id.vn`);
      await db.insert(schema.roomMembers).values({
        roomId: host.roomId,
        userId,
        role: 'member',
        displayName: `Member ${i}`,
      });
      userIds.push(userId);
    }
    return { roomId: host.roomId, userIds };
  }

  async function inboxCounts(userIds: string[], resourceId: string) {
    const rows = await db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(sql`${schema.notifications.payload}->>'resourceId' = ${resourceId}`);
    return userIds.map((id) => rows.filter((row) => row.userId === id).length);
  }

  it('renders each recipient in their account locale and opens the current plan (#594)', async () => {
    const { roomId, userIds } = await roomWithMembers('push-locale', 2);
    const [hostId, viMember, enMember] = userIds as [string, string, string];
    await db.update(schema.users).set({ locale: 'en' }).where(eq(schema.users.id, enMember));
    const [plan] = await db
      .insert(schema.plans)
      .values({
        roomId,
        version: 1,
        status: 'current',
        constraintVersion: 1,
        totals: {
          costMin: 0,
          costMax: 0,
          currency: 'VND',
          durationMinutes: 0,
          travelDistanceM: 0,
          overBudget: false,
          uncertain: false,
        },
      })
      .returning();
    const event = await queueEvent(roomId);
    const push = new FakePush();
    await new OutboxDispatcher(db as never, push).dispatchBatch();

    // One provider call per language; Vietnamese first, under the bare event id
    // every earlier release used, so a retry across the deploy is a replay.
    expect(push.sent).toHaveLength(2);
    const [vi, en] = push.sent;
    expect([...vi!.userIds].sort()).toEqual([hostId, viMember].sort());
    expect(en!.userIds).toEqual([enMember]);
    expect(vi!.idempotencyKey).toBe(event.id);
    expect(en!.idempotencyKey).toBe(`${event.id}:en`);
    expect(vi!.headings).toEqual({ vi: 'Kế hoạch đã sẵn sàng', en: 'Kế hoạch đã sẵn sàng' });
    expect(en!.headings).toEqual({ en: 'Your plan is ready' });

    const [room] = await db
      .select({ code: schema.rooms.code })
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId));
    for (const call of push.sent) {
      expect(call.data).toEqual({
        type: 'plan_ready',
        version: '1',
        notificationId: event.id,
        route: `gogo://plan/${plan!.id}`,
        entityType: 'plan',
        entityId: plan!.id,
        kind: 'plan_ready',
        roomId,
        eventType: 'plan.published',
      });
      // What a lock screen can show names no member and no room code.
      const shown = JSON.stringify([call.headings, call.contents, call.data]);
      expect(shown).not.toContain(room!.code);
      expect(shown).not.toContain('Member 0');
    }
  });

  it('a plan.changed on a superseded plan opens the current one; an opted-out en member gets none (#594)', async () => {
    const { roomId, userIds } = await roomWithMembers('push-superseded', 3);
    const [hostId, viMember, enMember, enOptedOut] = userIds as [string, string, string, string];
    await db
      .update(schema.users)
      .set({ locale: 'en' })
      .where(inArray(schema.users.id, [enMember, enOptedOut]));
    await db
      .insert(schema.notificationSettings)
      .values({ userId: enOptedOut, pushEnabled: false, source: 'explicit' });
    const totals = {
      costMin: 0,
      costMax: 0,
      currency: 'VND',
      durationMinutes: 0,
      travelDistanceM: 0,
      overBudget: false,
      uncertain: false,
    };
    const [oldPlan, currentPlan] = await db
      .insert(schema.plans)
      .values([
        { roomId, version: 1, status: 'superseded', constraintVersion: 1, totals },
        { roomId, version: 2, status: 'current', constraintVersion: 1, totals },
      ])
      .returning();
    // A regenerate names the plan it replaced, which is no longer the one to open.
    const [event] = await db
      .insert(schema.outboxEvents)
      .values({
        eventType: 'plan.changed',
        resourceType: 'plan',
        resourceId: oldPlan!.id,
        payload: {},
      })
      .returning();
    const push = new FakePush();
    await new OutboxDispatcher(db as never, push).dispatchBatch();

    // Everyone keeps the inbox row, the opted-out member included.
    expect(await inboxCounts(userIds, oldPlan!.id)).toEqual([1, 1, 1, 1]);
    expect(push.sent).toHaveLength(2);
    const [vi, en] = push.sent;
    expect([...vi!.userIds].sort()).toEqual([hostId, viMember].sort());
    expect(en!.userIds).toEqual([enMember]);
    expect(push.sent.flatMap((call) => call.userIds)).not.toContain(enOptedOut);
    expect(vi!.idempotencyKey).toBe(event!.id);
    expect(en!.idempotencyKey).toBe(`${event!.id}:en`);
    expect(vi!.headings).toEqual({ vi: 'Kế hoạch có thay đổi', en: 'Kế hoạch có thay đổi' });
    expect(en!.headings).toEqual({ en: 'Plan updated' });
    for (const call of push.sent) {
      expect(call.data).toEqual({
        type: 'plan_changed',
        version: '1',
        notificationId: event!.id,
        route: `gogo://plan/${currentPlan!.id}`,
        entityType: 'plan',
        entityId: currentPlan!.id,
        kind: 'plan_changed',
        roomId,
        eventType: 'plan.changed',
      });
    }
  });

  it('every member of a members event gets exactly one inbox row (#584)', async () => {
    const { roomId, userIds } = await roomWithMembers('outbox-fanout', 2);
    await queueEvent(roomId);
    const push = new FakePush();
    await new OutboxDispatcher(db as never, push).dispatchBatch();

    expect(await inboxCounts(userIds, roomId)).toEqual([1, 1, 1]);
    // Still one provider call for the whole event, addressed to all three.
    expect(push.sent).toHaveLength(1);
    expect([...push.sent[0]!.userIds].sort()).toEqual([...userIds].sort());
  });

  it('a redelivery after a complete fan-out adds no row for anyone (#584)', async () => {
    const { roomId, userIds } = await roomWithMembers('outbox-refan', 2);
    const event = await queueEvent(roomId);
    const dispatcher = new OutboxDispatcher(db as never, new FakePush());
    await dispatcher.dispatchBatch();
    await db
      .update(schema.outboxEvents)
      .set({ publishedAt: null })
      .where(eq(schema.outboxEvents.id, event.id));
    await dispatcher.dispatchBatch();

    expect(await inboxCounts(userIds, roomId)).toEqual([1, 1, 1]);
  });

  it('a fan-out that crashed part-way is completed by the retry, one row each (#584)', async () => {
    const { roomId, userIds } = await roomWithMembers('outbox-partial', 2);
    const event = await queueEvent(roomId);
    // The first inbox write lands, the second fails: a worker dying mid-loop.
    let inserts = 0;
    const flaky = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (...args: unknown[]) => {
            inserts += 1;
            if (inserts > 1) throw new Error('connection lost');
            return (db.insert as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    await new OutboxDispatcher(flaky as never, new FakePush()).dispatchBatch();
    expect((await inboxCounts(userIds, roomId)).reduce((a, b) => a + b, 0)).toBe(1);

    await db
      .update(schema.outboxEvents)
      .set({ nextAttemptAt: null })
      .where(eq(schema.outboxEvents.id, event.id));
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();

    expect(await inboxCounts(userIds, roomId)).toEqual([1, 1, 1]);
  });

  it('an event retried across the deploy keeps the row the old key wrote, adding none (#584)', async () => {
    const { roomId, userIds } = await roomWithMembers('outbox-legacy', 2);
    const event = await queueEvent(roomId);
    // What the previous release left behind: the first recipient's row keyed by
    // the bare event id, the others missing.
    await db.insert(schema.notifications).values({
      userId: userIds[0]!,
      kind: 'plan_ready',
      payload: { eventType: 'plan.published', roomId, resourceId: roomId },
      dedupeKey: event.id,
    });
    await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();

    expect(await inboxCounts(userIds, roomId)).toEqual([1, 1, 1]);
  });

  it('two dispatchers racing on one event still write one row per member (#584)', async () => {
    const { roomId, userIds } = await roomWithMembers('outbox-race', 3);
    await queueEvent(roomId);
    await Promise.all([
      new OutboxDispatcher(db as never, new FakePush()).dispatchBatch(),
      new OutboxDispatcher(db as never, new FakePush()).dispatchBatch(),
    ]);

    expect(await inboxCounts(userIds, roomId)).toEqual([1, 1, 1, 1]);
  });

  it('backs off instead of retrying a broken event every tick', async () => {
    const { roomId } = await roomWithHost('outbox-backoff@gogo.id.vn');
    const event = await queueEvent(roomId);
    // A push failure alone is swallowed by design, so break the write the
    // fan-out depends on. `select` and `update` still work, which is what
    // lets the dispatcher pick the event up and record the failure.
    const brokenDb = brokenInsert();
    await new OutboxDispatcher(brokenDb as never, new FakePush()).dispatchBatch();
    const [afterFirst] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event.id));
    expect(afterFirst!.attempts).toBe(1);
    // Not due again immediately — that is the whole point.
    expect(afterFirst!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // And it is not selected while it is not due.
    const picked = await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();
    expect(picked).toBe(0);
  });

  it('dead-letters after the attempts run out, so it stops blocking the queue', async () => {
    const { roomId } = await roomWithHost('outbox-deadletter@gogo.id.vn');
    const event = await queueEvent(roomId);
    await db
      .update(schema.outboxEvents)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
      .where(eq(schema.outboxEvents.id, event.id));

    await new OutboxDispatcher(brokenInsert() as never, new FakePush()).dispatchBatch();

    const [dead] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event.id));
    expect(dead!.failedAt).not.toBeNull();
    // Kept, not deleted: the failure is the thing worth having.
    expect(dead!.lastError).toContain('database unavailable');

    // A newer event behind it still gets through.
    const fresh = await queueEvent(roomId);
    const handled = await new OutboxDispatcher(db as never, new FakePush()).dispatchBatch();
    expect(handled).toBeGreaterThanOrEqual(1);
    const [published] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, fresh.id));
    expect(published!.publishedAt).not.toBeNull();
  });

  it('a permanent provider refusal does not block the event: the in-app row is the durable half', async () => {
    const { userId, roomId } = await roomWithHost('outbox-refused@gogo.id.vn');
    const event = await queueEvent(roomId);

    const rejecting = {
      sendToUser: async () => {
        throw new Error('payload rejected');
      },
      sendToUsers: async () => {
        throw new Error('payload rejected');
      },
    };
    await new OutboxDispatcher(db as never, rejecting as never).dispatchBatch();

    const [row] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event.id));
    // Published: retrying a refused payload returns the same refusal, and the
    // in-app notification already exists.
    expect(row!.publishedAt).not.toBeNull();
    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(notifications).toHaveLength(1);
  });

  it('a provider answer with nobody subscribed is counted as no target, never as sent (#193 review)', async () => {
    const { userId, roomId } = await roomWithHost('outbox-notarget@gogo.id.vn');
    await queueEvent(roomId);
    const push = new FakePush();
    push.unknownUserIds.add(userId);
    const counted: [string, Record<string, string> | undefined, number | undefined][] = [];
    const metrics = {
      increment: (name: string, labels?: Record<string, string>, by?: number) => {
        counted.push([name, labels, by]);
      },
    };
    await new OutboxDispatcher(db as never, push, metrics).dispatchBatch();

    expect(push.sent).toHaveLength(1);
    const names = counted.map(([name]) => name);
    expect(names).toContain('push_delivery_no_target_total');
    expect(names).toContain('push_delivery_unknown_user_total');
    expect(names).not.toContain('push_delivery_sent_total');
    expect(names).not.toContain('push_delivery_failed_total');
    // The inbox row still exists: the person sees it when they next sign in.
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('a transient provider outage backs the event off and retries it (#193)', async () => {
    const { userId, roomId } = await roomWithHost('outbox-outage@gogo.id.vn');
    const event = await queueEvent(roomId);

    const push = new FakePush();
    push.unavailable = true;
    const dispatcher = new OutboxDispatcher(db as never, push);
    await dispatcher.dispatchBatch();

    const [afterOutage] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event.id));
    // Not published, due later: the provider may be back by then.
    expect(afterOutage!.publishedAt).toBeNull();
    expect(afterOutage!.attempts).toBe(1);
    expect(afterOutage!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // The in-app row was written before the send and is not written twice.
    const before = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(before).toHaveLength(1);

    // Provider recovers; make the event due and run again.
    push.unavailable = false;
    await db
      .update(schema.outboxEvents)
      .set({ nextAttemptAt: null })
      .where(eq(schema.outboxEvents.id, event.id));
    await dispatcher.dispatchBatch();

    const [recovered] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event.id));
    expect(recovered!.publishedAt).not.toBeNull();
    expect(push.sent).toHaveLength(1);
    // Same provider key as the first attempt would have carried: a replay.
    expect(push.sent[0]!.idempotencyKey).toBe(event.id);
    const after = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    expect(after).toHaveLength(1);
  });
});
