import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { PLACE_PROVIDER } from '@gogo/providers';
import type { FakePlaceProvider } from '@gogo/providers';

/**
 * PI-BE-003..010, PI-BE-018..020 acceptance over real HTTP + PostGIS:
 * resolver, SSRF guard, dedup, provider snapshot, submission dedupe,
 * moderation decisions.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let places: FakePlaceProvider;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.60.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createAdmin(email: string, role: 'moderator' | 'editor' | 'ops_admin') {
  const argon2 = (await import('argon2')).default;
  await db.insert(schema.adminUsers).values({
    email,
    passwordHash: await argon2.hash('admin-password-123', { type: argon2.argon2id }),
    displayName: 'Admin',
    role,
  });
  const login = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  return { token: login.json().accessToken as string };
}

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'U' },
  });
  return res.json().accessToken as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_ingest_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_MAPS_API_KEY = '';

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
    radiusM: 8000,
  });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  places = app.get(PLACE_PROVIDER);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const resolve = (payload: Record<string, unknown>) =>
  api().inject({
    method: 'POST',
    url: '/v1/places/resolve-google-maps-link',
    remoteAddress: ip(),
    payload,
  });

describe('resolve link (PI-BE-018, FR-INGEST-002/010)', () => {
  it('resolves a provider-id URL and returns attribution + separate scores', async () => {
    places.seed({
      providerPlaceId: 'ChIJfight',
      name: 'FIGHT STATION',
      addressText: '12 Điện Biên Phủ, Bình Thạnh, Hồ Chí Minh',
      lat: 10.8012,
      lng: 106.7109,
      rating: 4.7,
      ratingCount: 120,
    });
    const res = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJfight' });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.status).toBe('RESOLVED');
    expect(b.reasonCodes).toContain('EXACT_PROVIDER_ID');
    expect(b.candidate.name).toBe('FIGHT STATION');
    // Raw provider rating and derived score are separate fields (ADR-0006).
    expect(b.candidate.googleRating).toBe(4.7);
    expect(b.candidate.googleRatingCount).toBe(120);
    expect(b.candidate.googleScore).toBeGreaterThan(0);
    expect(b.candidate.attributions[0]).toContain('Fake Provider');
    expect(b.candidate.fetchedAt).toBeTruthy();
  });

  it('blocks SSRF and spoofed hosts with distinct reason codes', async () => {
    const ssrf = await resolve({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(ssrf.json().status).toBe('UNRESOLVED');
    expect(ssrf.json().reasonCodes).toContain('UNSAFE_TARGET');

    const spoof = await resolve({ url: 'https://google.com.evil.tld/maps?place_id=ChIJfight' });
    expect(spoof.json().reasonCodes).toContain('HOST_NOT_ALLOWED');
  });

  it('unknown provider place → UNRESOLVED NOT_FOUND, no catalog write', async () => {
    const before = await db.select().from(schema.places);
    const res = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJghost' });
    expect(res.json().reasonCodes).toContain('NOT_FOUND');
    const after = await db.select().from(schema.places);
    expect(after.length).toBe(before.length);
  });
});

describe('submission dedupe + moderation (PI-BE-019, FR-INGEST-012)', () => {
  it('two users submitting the same link produce one pending draft', async () => {
    const t1 = await register('sub1@gogo.id.vn');
    const t2 = await register('sub2@gogo.id.vn');
    const payload = {
      googlePlaceId: 'ChIJfight',
      category: 'cafe',
      estimatedPrice: { min: 100_000, max: 250_000, unit: 'per_person' },
      vibes: ['playful'],
    };
    const a = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(t1),
      payload,
    });
    const b = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(t2),
      payload,
    });
    expect(a.json().status).toBe('PENDING');
    expect(b.json().deduped).toBe(true);
    expect(b.json().submissionId).toBe(a.json().submissionId);

    const rows = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.googlePlaceId, 'ChIJfight'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.submissionCount).toBe(2);
  });

  it('closed place cannot be submitted', async () => {
    places.seed({
      providerPlaceId: 'ChIJclosed',
      name: 'Quán Đóng Cửa',
      businessStatus: 'CLOSED_PERMANENTLY',
      lat: 10.78,
      lng: 106.7,
    });
    const t = await register('closed@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(t),
      payload: { googlePlaceId: 'ChIJclosed' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_CLOSED');
  });

  it('moderator approval creates a community_submitted place + provider snapshot', async () => {
    const [sub] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.googlePlaceId, 'ChIJfight'));
    const argon2 = (await import('argon2')).default;
    const [admin] = await db
      .insert(schema.adminUsers)
      .values({
        email: 'mod-ingest@gogo.local',
        passwordHash: await argon2.hash('admin-password-123', { type: argon2.argon2id }),
        displayName: 'Mod',
        role: 'moderator',
      })
      .returning();
    void admin;
    const login = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      payload: { email: 'mod-ingest@gogo.local', password: 'admin-password-123' },
    });
    const modToken = login.json().accessToken as string;

    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${sub!.id}/decide`,
      remoteAddress: ip(),
      headers: auth(modToken),
      payload: { decision: 'approved', reason: 'đủ dữ liệu, đúng khu vực' },
    });
    expect(res.statusCode).toBe(201);
    const placeId = res.json().placeId as string;
    expect(placeId).toBeTruthy();

    const [place] = await db.select().from(schema.places).where(eq(schema.places.id, placeId));
    expect(place!.status).toBe('community_submitted');
    expect(place!.nameNormalized).toBe('fight station');

    const [src] = await db
      .select()
      .from(schema.placeProviderSources)
      .where(eq(schema.placeProviderSources.externalId, 'ChIJfight'));
    expect(src!.placeId).toBe(placeId);
    expect(Number(src!.rating)).toBe(4.7); // raw aggregate untouched
    expect(Number(src!.derivedScore)).toBeGreaterThan(0); // derived kept apart
    expect(src!.refreshAfter).not.toBeNull(); // freshness window set
    expect(src!.fetchTier).toBe('quality');

    // Audit + reindex event exist.
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, 'place_submission.decided'));
    expect(audits.length).toBeGreaterThan(0);
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(sql`${schema.outboxEvents.eventType} in ('place.submission_created','place.updated')`);
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Deciding twice is refused.
    const again = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${sub!.id}/decide`,
      remoteAddress: ip(),
      headers: auth(modToken),
      payload: { decision: 'rejected', reason: 'thử lại' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('re-submitting an already-linked provider place returns the canonical id', async () => {
    const t = await register('again@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(t),
      payload: { googlePlaceId: 'ChIJfight' },
    });
    expect(res.json().status).toBe('ALREADY_EXISTS');
    expect(res.json().placeId).toBeTruthy();

    // And resolving the link now reports the existing place instead of new.
    const r = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJfight' });
    expect(r.json().status).toBe('ALREADY_EXISTS');
    expect(r.json().existingPlaceId).toBeTruthy();
  });
});

describe('permissions (FR-INGEST-011)', () => {
  it('submission requires auth; guests need a room-scoped session', async () => {
    const anon = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      payload: { googlePlaceId: 'ChIJfight' },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('a normal user cannot reach the CMS decision endpoint', async () => {
    const t = await register('nobody@gogo.id.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/place-submissions/00000000-0000-0000-0000-000000000000/decide',
      remoteAddress: ip(),
      headers: auth(t),
      payload: { decision: 'approved', reason: 'nope' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PI-CMS-007 — submission queue (list)', () => {
  it('lists pending proposals newest first, pages by cursor, and hides who sent them', async () => {
    const moderator = await createAdmin('sub-queue@gogo.local', 'moderator');
    for (let i = 0; i < 4; i++) {
      places.seed({ providerPlaceId: `fake-queue-${i}`, name: `Quán Queue ${i}` });
      const token = await register(`queue-user-${i}@gogo.id.vn`);
      const res = await api().inject({
        method: 'POST',
        url: '/v1/place-submissions',
        remoteAddress: ip(),
        headers: auth(token),
        payload: { googlePlaceId: `fake-queue-${i}`, note: `đề xuất ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    const first = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?limit=2',
      remoteAddress: ip(),
      headers: auth(moderator.token),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    // Moderating does not need the person, only whether it came from an account.
    expect(page.items[0]).not.toHaveProperty('submittedByUserId');
    expect(page.items[0].fromRegisteredUser).toBe(true);

    const second = await api().inject({
      method: 'GET',
      url: `/v1/cms/place-submissions?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
    });
    const ids = new Set([
      ...page.items.map((i: { id: string }) => i.id),
      ...second.json().items.map((i: { id: string }) => i.id),
    ]);
    expect(ids.size).toBe(4);
  });

  it('counts repeat proposals of the same place as one row', async () => {
    const moderator = await createAdmin('sub-dupe@gogo.local', 'moderator');
    places.seed({ providerPlaceId: 'fake-popular', name: 'Quán Ai Cũng Gửi' });
    for (let i = 0; i < 3; i++) {
      const token = await register(`popular-${i}@gogo.id.vn`);
      await api().inject({
        method: 'POST',
        url: '/v1/place-submissions',
        remoteAddress: ip(),
        headers: auth(token),
        payload: { googlePlaceId: 'fake-popular' },
      });
    }

    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?limit=100',
      remoteAddress: ip(),
      headers: auth(moderator.token),
    });
    const rows = res
      .json()
      .items.filter((i: { googlePlaceId: string }) => i.googlePlaceId === 'fake-popular');
    // One row, not three — the count is the signal to prioritise by.
    expect(rows).toHaveLength(1);
    expect(rows[0].submissionCount).toBe(3);
  });

  it('a decided submission leaves the pending queue and keeps its reason', async () => {
    const moderator = await createAdmin('sub-decide@gogo.local', 'moderator');
    places.seed({ providerPlaceId: 'fake-decide', name: 'Quán Quyết Định' });
    const token = await register('decide-user@gogo.id.vn');
    const submitted = await api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { googlePlaceId: 'fake-decide' },
    });

    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submitted.json().submissionId}/decide`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'rejected', reason: 'trùng địa điểm đã có' },
    });

    const pending = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?status=pending&limit=100',
      remoteAddress: ip(),
      headers: auth(moderator.token),
    });
    expect(
      pending.json().items.some((i: { id: string }) => i.id === submitted.json().submissionId),
    ).toBe(false);

    const rejected = await api().inject({
      method: 'GET',
      url: '/v1/cms/place-submissions?status=rejected&limit=100',
      remoteAddress: ip(),
      headers: auth(moderator.token),
    });
    const row = rejected
      .json()
      .items.find((i: { id: string }) => i.id === submitted.json().submissionId);
    expect(row.decisionReason).toBe('trùng địa điểm đã có');
    expect(row.decidedAt).toBeTruthy();
  });
});
