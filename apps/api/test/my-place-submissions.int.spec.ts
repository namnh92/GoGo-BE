import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { TokenService } from '@gogo/modules';
import { PLACE_PROVIDER, type FakePlaceProvider } from '@gogo/providers';

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
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
    expect((await list(other.token)).json()).toEqual({ items: [], nextCursor: null });
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
      if (item.status === 'rejected') expect(item.rejectionReason).toBe('MODERATION_REJECTED');
    }
    expect(provider.tiersRequested).toEqual([]);
  });

  it('reads a later decision on reopening with a new login session', async () => {
    const row = await submission();
    expect((await list()).json().items[0].status).toBe('pending');
    await db
      .update(schema.placeSubmissions)
      .set({
        status: 'rejected',
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
      rejectionReason: 'MODERATION_REJECTED',
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
