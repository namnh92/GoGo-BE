import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { TokenService, UserContentService } from '@gogo/modules';
import { APP_CONFIG } from '../../../libs/modules/shared/config';
import {
  PLACE_PHOTO_DISPLAY,
  type FakePlacePhotoDisplay,
  PLACE_PROVIDER,
  type FakePlaceProvider,
} from '@gogo/providers';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let owner: { id: string; token: string };
let other: { id: string; token: string };
let ipSequence = 0;
const ip = () => `10.78.8.${++ipSequence}`;
const api = () => app.getHttpAdapter().getInstance();
const list = (token = owner.token, query = '') =>
  api().inject({
    method: 'GET',
    url: `/v1/me/place-submissions${query}`,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}` },
  });

const submit = (token: string, googlePlaceId: string, note?: string) =>
  api().inject({
    method: 'POST',
    url: '/v1/place-submissions',
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}` },
    payload: { googlePlaceId, note },
  });
function seedProvider() {
  const googlePlaceId = `shared-${randomUUID()}`;
  (app.get(PLACE_PROVIDER) as FakePlaceProvider).seed({
    providerPlaceId: googlePlaceId,
    name: 'Shared café',
    addressText: 'Hà Nội',
    lat: 21.02,
    lng: 105.84,
  });
  return googlePlaceId;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_my_submissions_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.METRICS_TOKEN = 'metrics-token-int-tests';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://assets.example.test';
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.PLACE_DISPLAY_DAILY_MAX_CALLS = '1000';
  process.env.PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD = '100';
  process.env.PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA = '1000';
  delete process.env.PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY;
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  const register = async (email: string) => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'Sufficiently-long-pw1!', displayName: 'Contributor' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const token = res.json().accessToken as string;
    return { id: app.get(TokenService).verifyAccessToken(token).sub, token };
  };
  owner = await register('my-submissions-owner@gogo.id.vn');
  other = await register('my-submissions-other@gogo.id.vn');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate place_submissions cascade`);
  await db.execute(sql`truncate places cascade`);
});

async function submission(over: Partial<typeof schema.placeSubmissions.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.placeSubmissions)
    .values({ googlePlaceId: randomUUID(), submittedByUserId: owner.id, ...over })
    .returning();
  return row!;
}

describe('GET /v1/me/place-submissions (#788)', () => {
  it.each(['approved', 'rejected', 'merged'] as const)(
    'retains both contributors to one proposal after reopening and a %s decision',
    async (status) => {
      const googlePlaceId = seedProvider();
      const first = await submit(owner.token, googlePlaceId, 'A private@example.test');
      expect(first.statusCode, first.body).toBe(201);
      const id = first.json().submissionId as string;
      for (let attempt = 0; attempt < 2; attempt++) {
        const second = await submit(other.token, googlePlaceId, 'B private@example.test');
        expect(second.statusCode, second.body).toBe(201);
        expect(second.json()).toEqual({ status: 'PENDING', submissionId: id, deduped: true });
      }
      const proposals = await db.select().from(schema.placeSubmissions);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ id, submissionCount: 3, submittedByUserId: owner.id });
      expect(
        (await db.select().from(schema.placeSubmissionContributors))
          .map((row) => row.userId)
          .sort(),
      ).toEqual([owner.id, other.id].sort());
      // An unrelated proposal remains private even when the accounts share another.
      await submission({ note: 'Unrelated A contribution' });
      const reopened: string[] = [];
      for (const email of ['my-submissions-owner@gogo.id.vn', 'my-submissions-other@gogo.id.vn']) {
        const login = await api().inject({
          method: 'POST',
          url: '/v1/auth/login',
          remoteAddress: ip(),
          payload: { email, password: 'Sufficiently-long-pw1!' },
        });
        expect(login.statusCode, login.body).toBe(201);
        const token = login.json().accessToken as string;
        reopened.push(token);
        const pending = await list(token);
        expect(pending.statusCode, pending.body).toBe(200);
        expect(pending.json().items).toContainEqual({
          id,
          status: 'pending',
          providerStatus: 'budget_exhausted',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        });
      }
      expect((await list(reopened[1]!)).json().items).toHaveLength(1);
      const [place] = await db
        .insert(schema.places)
        .values({
          name: 'GoGo shared café',
          nameNormalized: 'gogo shared cafe',
          geom: { x: 105.84, y: 21.02 },
        })
        .returning();
      await db
        .update(schema.placeSubmissions)
        .set({
          status,
          rejectionReason: status === 'rejected' ? 'incorrect_location' : null,
          resultPlaceId: status === 'rejected' ? null : place!.id,
          decisionReason: 'Moderator private@example.test',
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.placeSubmissions.id, id));
      for (const token of reopened) {
        const response = await list(token);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().items.find((item: { id: string }) => item.id === id)).toEqual({
          id,
          status,
          providerStatus: 'budget_exhausted',
          ...(status === 'rejected'
            ? { rejectionReason: 'incorrect_location' }
            : { placeId: place!.id, name: 'GoGo shared café' }),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          decidedAt: expect.any(String),
        });
        const poll = await api().inject({
          method: 'GET',
          url: `/v1/place-submissions/${id}`,
          remoteAddress: ip(),
          headers: { authorization: `Bearer ${token}` },
        });
        expect(poll.statusCode, poll.body).toBe(200);
        expect(poll.json().status).toBe(status);
      }
    },
  );

  it('deduplicates simultaneous first submissions with one event and both attributions', async () => {
    const googlePlaceId = seedProvider();
    const responses = await Promise.all([
      submit(owner.token, googlePlaceId),
      submit(other.token, googlePlaceId),
    ]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    const id = responses[0]!.json().submissionId;
    expect(responses[1]!.json().submissionId).toBe(id);
    expect(responses.map((response) => response.json().deduped).sort()).toEqual([false, true]);
    expect(await db.select().from(schema.placeSubmissions)).toMatchObject([
      { id, submissionCount: 2 },
    ]);
    expect(await db.select().from(schema.placeSubmissionContributors)).toHaveLength(2);
    const events = await db.execute(sql`select id from outbox_events
      where resource_id = ${id} and event_type = 'place.submission_created'`);
    expect(events.rows).toHaveLength(1);
    for (const token of [owner.token, other.token]) {
      expect((await list(token)).json().items.map((item: { id: string }) => item.id)).toEqual([id]);
    }
  });

  it('rolls back proposal creation and dedupe counts when attribution cannot persist', async () => {
    const googlePlaceId = seedProvider();
    const first = await submit(owner.token, googlePlaceId);
    expect(first.statusCode, first.body).toBe(201);
    await db.execute(sql`create function test_reject_attribution() returns trigger language plpgsql as $$
      begin raise exception 'attribution storage unavailable'; end $$;
      create trigger test_reject_attribution before insert on place_submission_contributors
      for each row execute function test_reject_attribution()`);
    try {
      for (const providerId of [googlePlaceId, seedProvider()]) {
        const response = await submit(other.token, providerId);
        expect(response.statusCode, response.body).toBe(500);
      }
      expect(await db.select().from(schema.placeSubmissions)).toMatchObject([
        { id: first.json().submissionId, submissionCount: 1 },
      ]);
      expect(await db.select().from(schema.placeSubmissionContributors)).toHaveLength(1);
      expect((await list(other.token)).json()).toEqual({ items: [], nextCursor: null });
      const poll = await api().inject({
        method: 'GET',
        url: `/v1/place-submissions/${first.json().submissionId}`,
        remoteAddress: ip(),
        headers: { authorization: `Bearer ${other.token}` },
      });
      expect(poll.statusCode, poll.body).toBe(403);
      expect(poll.json().code).toBe('FORBIDDEN');
    } finally {
      await db.execute(sql`drop trigger test_reject_attribution on place_submission_contributors;
        drop function test_reject_attribution()`);
    }
  });

  it('exports only the account’s shared attribution and erases it without deleting A’s proposal', async () => {
    const registered = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: `erased-${randomUUID()}@gogo.id.vn`,
        password: 'Sufficiently-long-pw1!',
        displayName: 'Contributor',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const token = registered.json().accessToken as string;
    const other = { token, id: app.get(TokenService).verifyAccessToken(token).sub };
    const googlePlaceId = seedProvider();
    const first = await submit(owner.token, googlePlaceId, 'A private@example.test');
    expect(first.statusCode, first.body).toBe(201);
    const second = await submit(other.token, googlePlaceId, 'B private@example.test');
    expect(second.statusCode, second.body).toBe(201);
    await submission({ note: 'A unrelated private@example.test' });
    const service = app.get(UserContentService);
    const exported = await service.exportData({ type: 'user', id: other.id, sessionId: 'export' });
    expect(exported.placeSubmissions).toEqual([
      {
        id: first.json().submissionId,
        status: 'pending',
        createdAt: expect.any(String),
        decidedAt: null,
      },
    ]);
    await service.deleteForUser(other.id, { actorType: 'user', actorId: other.id });
    expect(
      (await db.select().from(schema.placeSubmissionContributors)).map((row) => row.userId),
    ).toEqual([owner.id]);
    expect(await db.select().from(schema.placeSubmissions)).toHaveLength(2);
    expect((await list(owner.token)).json().items).toHaveLength(2);
  });

  it('backfills a pre-attribution snapshot and cascades links when a proposal is deleted', async () => {
    const legacy = await submission();
    await submission({ submittedByUserId: null, submittedByGuestSessionId: randomUUID() });
    const [deleted] = await db
      .insert(schema.users)
      .values({ displayName: 'Deleted', status: 'deleted' })
      .returning();
    await submission({ submittedByUserId: deleted!.id });
    const migration = await readFile(
      path.resolve(__dirname, '../../../migrations/0085_place-submission-contributors.sql'),
      'utf8',
    );
    const rollback = new Error('restore snapshot after migration verification');
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`drop table place_submission_contributors`);
        await tx.execute(sql.raw(migration));
        const links = await tx.select().from(schema.placeSubmissionContributors);
        expect(links).toEqual([
          { userId: owner.id, submissionId: legacy.id, createdAt: legacy.createdAt },
        ]);
        await tx.delete(schema.placeSubmissions).where(eq(schema.placeSubmissions.id, legacy.id));
        expect(await tx.select().from(schema.placeSubmissionContributors)).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('requires authentication and refuses authenticated guest and admin actors', async () => {
    const anonymous = await api().inject({ method: 'GET', url: '/v1/me/place-submissions' });
    expect(anonymous.statusCode).toBe(401);
    const tokens = app.get(TokenService);
    const [admin] = await db
      .insert(schema.adminUsers)
      .values({
        email: 'my-submissions-admin@gogo.id.vn',
        displayName: 'Staff',
        role: 'moderator',
      })
      .returning();
    const [session] = await db
      .insert(schema.adminSessions)
      .values({
        adminId: admin!.id,
        refreshTokenHash: tokens.hashOpaqueToken(tokens.generateOpaqueToken()),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    for (const actorType of ['guest', 'admin'] as const) {
      const token = tokens.issueAccessToken({
        actorId: actorType === 'admin' ? admin!.id : randomUUID(),
        actorType,
        sessionId: actorType === 'admin' ? session!.id : randomUUID(),
      });
      const response = await list(token);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().code).toBe('FORBIDDEN');
    }
  });

  it('returns 401 for an admin token without a live session', async () => {
    const token = app.get(TokenService).issueAccessToken({
      actorId: randomUUID(),
      actorType: 'admin',
      sessionId: randomUUID(),
    });
    const response = await list(token);
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().code).toBe('SESSION_REVOKED');
  });

  it('returns only owned records and an empty page for another account', async () => {
    const own = await submission({ note: 'private contributor note', decisionReason: 'PII' });
    await submission({ submittedByUserId: null, submittedByGuestSessionId: randomUUID() });
    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      items: [
        {
          id: own.id,
          status: 'pending',
          providerStatus: 'budget_exhausted',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
    expect((await list(other.token)).json()).toEqual({ items: [], nextCursor: null });
    const poll = await api().inject({
      method: 'GET',
      url: `/v1/place-submissions/${own.id}`,
      remoteAddress: ip(),
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(poll.statusCode, poll.body).toBe(403);
    expect(poll.json().code).toBe('FORBIDDEN');
  });

  it('paginates exact timestamp ties and microseconds while new rows arrive', async () => {
    const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    for (const id of ids) await submission({ id });
    await db.execute(sql`update place_submissions set created_at = '2026-11-07T01:00:00.123456Z'`);
    // A later timestamp with a smaller id catches millisecond-truncated cursors.
    await db.execute(sql`update place_submissions set created_at = '2026-11-07T01:00:00.123789Z'
      where id = ${ids[0]}::uuid`);
    const first = (await list(owner.token, '?limit=1')).json();
    expect(first.items.map((item: { id: string }) => item.id)).toEqual([ids[0]]);
    expect(first.items[0].createdAt).toBe('2026-11-07T01:00:00.123789Z');
    await submission({ createdAt: new Date('2026-11-07T02:00:00Z') });
    await submission({ submittedByUserId: other.id, createdAt: new Date('2026-11-07T03:00:00Z') });
    const seen = [first.items[0].id];
    let cursor = first.nextCursor as string | null;
    while (cursor) {
      const response = await list(owner.token, `?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json();
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(4);
    }
    expect(seen).toEqual([ids[0], ids[3], ids[2], ids[1]]);
    const foreign = await list(other.token, `?cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(foreign.json()).toEqual({ items: [], nextCursor: null });
  });

  it('returns all statuses, safe rejection keys, name and moderated owned photos without provider calls', async () => {
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'GoGo Café',
        nameNormalized: 'gogo cafe',
        geom: { x: 105.84, y: 21.02 },
      })
      .returning();
    await db.insert(schema.placeMedia).values([
      {
        placeId: place!.id,
        storageKey: 'places/pending.jpg',
        moderation: 'pending',
        isCover: true,
      },
      {
        placeId: place!.id,
        storageKey: 'places/provider.jpg',
        moderation: 'approved',
        sourceType: 'provider',
        sortOrder: -2,
      },
      { placeId: place!.id, storageKey: 'u/private.jpg', moderation: 'approved', sortOrder: -1 },
      {
        placeId: place!.id,
        storageKey: 'places/approved.jpg',
        moderation: 'approved',
        sourceType: 'community',
      },
    ]);
    for (const status of ['pending', 'approved', 'rejected', 'merged'] as const) {
      await submission({
        status,
        rejectionReason: status === 'rejected' ? 'incorrect_location' : null,
        resultPlaceId: status === 'approved' || status === 'merged' ? place!.id : null,
        reviewDraft: { name: 'Reviewed name' },
        decidedAt: status === 'pending' ? null : new Date('2026-11-07T01:00:00Z'),
        decisionReason: 'Contact moderator@example.test',
        note: 'other private information',
      });
    }
    const provider = app.get(PLACE_PROVIDER) as FakePlaceProvider;
    provider.tiersRequested.length = 0;
    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Record<string, unknown>[];
    expect(items.map((item) => item.status).sort()).toEqual([
      'approved',
      'merged',
      'pending',
      'rejected',
    ]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'status',
          'providerStatus',
          'name',
          'createdAt',
          'updatedAt',
          ...(item.status === 'pending' ? [] : ['decidedAt']),
          ...(item.status === 'rejected' ? ['rejectionReason'] : []),
          ...(item.status === 'approved' || item.status === 'merged'
            ? ['placeId', 'photoUrl']
            : []),
        ].sort(),
      );
      if (item.status === 'approved' || item.status === 'merged') {
        expect(item.placeId).toBe(place!.id);
        expect(item.name).toBe('GoGo Café');
        expect(item.photoUrl).toBe('https://assets.example.test/places/approved.jpg');
      } else expect(item.name).toBe('Reviewed name');
      if (item.status === 'rejected') expect(item.rejectionReason).toBe('incorrect_location');
    }
    expect(provider.tiersRequested).toEqual([]);
  });

  it('omits the public reason for a historical rejection with only a private note', async () => {
    const row = await submission({ status: 'rejected', decisionReason: 'private@example.test' });
    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0]).toMatchObject({ id: row.id, status: 'rejected' });
    expect(response.json().items[0]).not.toHaveProperty('rejectionReason');
    expect(response.body).not.toContain('private@example.test');
  });

  it('reads a later decision on reopening with a new login session', async () => {
    const row = await submission();
    expect((await list()).json().items[0].status).toBe('pending');
    await db
      .update(schema.placeSubmissions)
      .set({
        status: 'rejected',
        rejectionReason: 'incorrect_location',
        decisionReason: 'internal text',
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.placeSubmissions.id, row.id));
    const login = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip(),
      payload: { email: 'my-submissions-owner@gogo.id.vn', password: 'Sufficiently-long-pw1!' },
    });
    expect(login.statusCode, login.body).toBe(201);
    expect((await list(login.json().accessToken)).json().items[0]).toMatchObject({
      id: row.id,
      status: 'rejected',
      rejectionReason: 'incorrect_location',
      decidedAt: expect.any(String),
    });
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=1.5',
    '?cursor=',
    '?cursor=garbage',
    `?cursor=${Buffer.from(JSON.stringify(['not-a-date', randomUUID()])).toString('base64url')}`,
    `?cursor=${Buffer.from(JSON.stringify(['2026-11-07T00:00:00Z', '-'.repeat(36)])).toString('base64url')}`,
  ])('rejects malformed pagination %s with the error envelope', async (query) => {
    const res = await list(owner.token, query);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({
      code: expect.any(String),
      request_id: expect.any(String),
      retryable: false,
    });
  });
});

const detail = (id: string, token = owner.token) =>
  api().inject({
    method: 'GET',
    url: `/v1/me/place-submissions/${id}`,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}` },
  });

describe('#801 contribution cards and shared pending detail', () => {
  let config: Record<string, unknown>;
  let previous: Record<string, unknown>;
  const displayConfig = {
    PLACE_DISPLAY_DAILY_MAX_CALLS: 1000,
    PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD: 100,
    PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY: 1000,
    PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA: 1000,
    FLAG_PLACE_PROVIDER_PHOTOS: true,
  };
  beforeEach(async () => {
    config = app.get(APP_CONFIG);
    previous = {};
    for (const [key, value] of Object.entries(displayConfig)) {
      previous[key] = config[key];
      config[key] = value;
    }
    await db
      .insert(schema.taxonomies)
      .values({ kind: 'category', key: 'cafe' })
      .onConflictDoNothing();
    await db.execute(sql`delete from feature_flags where key = 'place_provider_photos.enabled'`);
    (app.get(PLACE_PROVIDER) as FakePlaceProvider).tiersRequested.length = 0;
  });
  afterEach(() => {
    Object.assign(config, previous);
    (app.get(PLACE_PROVIDER) as FakePlaceProvider).failing = false;
  });

  it('renders real pending facts in list and detail, with proxy credit and no durable Google content', async () => {
    const googlePlaceId = seedProvider();
    (app.get(PLACE_PROVIDER) as FakePlaceProvider).seed({
      providerPlaceId: googlePlaceId,
      name: 'Tên thật',
      shortAddress: 'Bến Thành, TP.HCM',
      rating: 4.6,
      ratingCount: 980,
      attribution: 'Google Maps',
      hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false }],
    });
    const photos = app.get(PLACE_PHOTO_DISPLAY) as FakePlacePhotoDisplay;
    const refsBefore = photos.refCalls.length;
    const mediaBefore = photos.mediaCalls.length;
    photos.seed(googlePlaceId, [
      {
        reference: `places/${googlePlaceId}/photos/never-save-this`,
        widthPx: 800,
        heightPx: 600,
        authorAttributions: [{ displayName: 'Lan', uri: null, photoUri: null }],
        googleMapsUri: null,
      },
    ]);
    const row = await submission({ googlePlaceId, note: 'My private tip' });
    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
    const card = response.json().items[0];
    expect(card).toMatchObject({
      id: row.id,
      name: 'Tên thật',
      addressShort: 'Bến Thành, TP.HCM',
      categoryKey: 'cafe',
      status: 'pending',
      providerStatus: 'ok',
      providerDisplay: {
        source: 'google_places',
        attributions: ['Google Maps'],
        googleRating: 4.6,
        googleRatingCount: 980,
        openingHours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false }],
        photo: {
          url: `/v1/places/google-provider-photo/${googlePlaceId}`,
          authorAttributions: [{ displayName: 'Lan', uri: null, photoUri: null }],
        },
      },
    });
    expect(card).not.toHaveProperty('contribution');
    expect(card).not.toHaveProperty('photoUrl');
    const opened = await detail(row.id);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.headers['cache-control']).toBe('no-store');
    expect(opened.json()).toMatchObject({
      status: 'pending',
      name: 'Tên thật',
      contribution: { verificationStatus: 'unverified', note: 'My private tip' },
    });
    expect(opened.body).not.toMatch(/never-save-this|dataBase64|submittedBy|decidedBy|reviewDraft/);
    expect(await db.select().from(schema.placeMedia)).toEqual([]);
    expect(await db.select().from(schema.places)).toEqual([]);
    const stored = (await db.select().from(schema.placeSubmissions))[0]!;
    expect(stored).toEqual(row);
    expect(photos.refCalls.length - refsBefore).toBe(2);
    expect(photos.mediaCalls.length).toBe(mediaBefore);
  });

  it('checks identity/ownership before billing; recorded contributors see status but no original input or PII', async () => {
    const googlePlaceId = seedProvider();
    const row = await submission({
      googlePlaceId,
      note: 'owner-private@example.test',
      decisionReason: 'moderator-private@example.test',
    });
    const provider = app.get(PLACE_PROVIDER) as FakePlaceProvider;
    for (const id of [row.id, randomUUID()]) {
      const response = await detail(id, other.token);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().code).toBe('SUBMISSION_NOT_FOUND');
    }
    expect(provider.tiersRequested).toEqual([]);
    await db
      .insert(schema.placeSubmissionContributors)
      .values({ userId: other.id, submissionId: row.id });
    const response = await detail(row.id, other.token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: row.id, status: 'pending', providerStatus: 'ok' });
    expect(response.json()).not.toHaveProperty('contribution');
    expect(response.body).not.toMatch(/private@example|reviewDraft|submitted_by/);
    expect(provider.tiersRequested).toEqual(['quality']);
    const invalid = await detail('bad-uuid');
    expect(invalid.statusCode).toBe(400);
  });

  it('keeps approved navigation and rejected reason readable during provider failure', async () => {
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Verified café',
        nameNormalized: 'verified cafe',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    const provider = app.get(PLACE_PROVIDER) as FakePlaceProvider;
    provider.failing = true;
    for (const status of ['approved', 'merged', 'rejected'] as const) {
      const row = await submission({
        status,
        resultPlaceId: status === 'rejected' ? null : place!.id,
        rejectionReason: status === 'rejected' ? 'incorrect_location' : null,
        decisionReason: 'NEVER EXPOSE',
        decidedAt: new Date(),
      });
      const response = await detail(row.id);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        status,
        providerStatus: 'unavailable',
        ...(status === 'rejected'
          ? { rejectionReason: 'incorrect_location' }
          : { placeId: place!.id, name: 'Verified café' }),
      });
      expect(response.json()).not.toHaveProperty('providerDisplay');
      expect(response.body).not.toContain('NEVER EXPOSE');
    }
  });

  it('reads only allowlisted #796 enrichment after additive schema rollout and hides it from co-contributors', async () => {
    const row = await submission();
    expect((await detail(row.id)).json().contribution).not.toHaveProperty('enrichment');
    // Compatibility proof: #801 deploys before or after the independent #796 migration.
    const existingColumn = await db.execute(sql`select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'place_submissions' and column_name = 'enrichment'`);
    if (!existingColumn.rows.length)
      await db.execute(sql`alter table place_submissions add column enrichment jsonb`);
    try {
      await db.execute(
        sql`update place_submissions set enrichment = ${JSON.stringify({ visitTips: 'Own tips', photos: [{ mediaId: randomUUID(), kind: 'bill' }], internalNote: 'PRIVATE' })}::jsonb where id = ${row.id}`,
      );
      const response = await detail(row.id);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().contribution).toMatchObject({
        verificationStatus: 'unverified',
        enrichment: {
          visitTips: 'Own tips',
          photos: [{ kind: 'bill', mediaId: expect.any(String) }],
        },
      });
      expect(response.body).not.toContain('PRIVATE');
      await db
        .insert(schema.placeSubmissionContributors)
        .values({ userId: other.id, submissionId: row.id });
      expect((await detail(row.id, other.token)).json()).not.toHaveProperty('contribution');
    } finally {
      if (!existingColumn.rows.length)
        await db.execute(sql`alter table place_submissions drop column enrichment`);
    }
  });
});
