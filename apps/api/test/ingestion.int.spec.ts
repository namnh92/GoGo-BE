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
import { signResolutionAttestation } from '@gogo/modules';

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
  process.env.GOOGLE_PLACES_API_KEY = '';
  // #337 — with no secret the attestation is simply unavailable, which is the
  // state most of this file exercises by accident. The PR4 block below needs it
  // configured, so it is set here and the "unconfigured" path is asserted by
  // the unit spec instead.
  process.env.PLACE_RESOLUTION_ATTESTATION_SECRET = 'ingestion-int-attestation-secret-0123456789';

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

/**
 * COST-BE-004 (#337) — the duplicate Google call is gone, and nothing about
 * Google is stored to replace it.
 *
 * Every assertion here is on `places.tiersRequested`, the fake provider's log
 * of what a flow would actually be billed for. Asserting the response body
 * alone would pass with the calls still happening, which is the whole failure
 * mode this PR exists to fix.
 */
describe('#337 — duplicate Google calls', () => {
  const ATTESTATION_SECRET = 'ingestion-int-attestation-secret-0123456789';

  const submit = (payload: Record<string, unknown>, token: string) =>
    api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(token),
      payload,
    });

  /** What a flow cost, from the point this is called. */
  function billed(): string[] {
    return [...places.tiersRequested];
  }
  function resetBilling(): void {
    places.tiersRequested.length = 0;
  }

  it('preview → attested submit → approve costs two Details, not three', async () => {
    const moderator = await createAdmin('pr4-mod@gogo.local', 'moderator');
    const user = await register('pr4-new@gogo.id.vn');
    places.seed({
      providerPlaceId: 'ChIJpr4New',
      name: 'Quán PR4 Mới',
      lat: 10.7769,
      lng: 106.7009,
    });

    resetBilling();
    const preview = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJpr4New' });
    expect(preview.statusCode).toBe(201);
    expect(preview.json().status).toBe('RESOLVED');
    const resolutionToken = preview.json().resolutionToken as string;
    expect(resolutionToken, 'an operational place gets a token').toBeTruthy();
    // #338 — the one preview that stays Enterprise, and the assertion below is
    // why: the candidate the client renders carries Google's rating, and the
    // mobile card drops the whole rating row when it is absent. A `core`
    // preview would be cheaper by $3 per thousand and would quietly delete the
    // fact a submitter decides on.
    expect(billed(), 'preview is one Details, at the tier it renders').toEqual(['quality']);
    expect(preview.json().candidate.googleRating).toBe(4.4);
    expect(preview.json().candidate.googleRatingCount).toBe(250);

    resetBilling();
    const submitted = await submit({ googlePlaceId: 'ChIJpr4New', resolutionToken }, user);
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('PENDING');
    expect(billed(), 'the attested submit asks Google nothing').toEqual([]);

    resetBilling();
    const decided = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submitted.json().submissionId}/decide`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'approved', reason: 'đã duyệt' },
    });
    expect(decided.statusCode).toBe(201);
    // Approve re-verifies on purpose: moderation outlives any attestation.
    expect(billed(), 'approve revalidates').toEqual(['quality']);
  });

  it('a place GoGo already holds is answered from the catalogue, not from Google', async () => {
    const moderator = await createAdmin('pr4-mod-known@gogo.local', 'moderator');
    const user = await register('pr4-known@gogo.id.vn');
    places.seed({
      providerPlaceId: 'ChIJpr4Known',
      name: 'Quán PR4 Đã Có',
      lat: 10.7779,
      lng: 106.7019,
    });

    const preview = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJpr4Known' });
    const first = await submit(
      { googlePlaceId: 'ChIJpr4Known', resolutionToken: preview.json().resolutionToken },
      user,
    );
    await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${first.json().submissionId}/decide`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'approved', reason: 'đã duyệt' },
    });

    // Now the id is catalogued. Scenario C: both halves must cost nothing.
    resetBilling();
    const second = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJpr4Known' });
    expect(second.json().status).toBe('ALREADY_EXISTS');
    expect(second.json().existingPlaceId).toBeTruthy();
    expect(second.json().reasonCodes).toContain('DB_FIRST');
    // Served from the stored row, so it must say when that row was fetched —
    // never `now()`, which would claim a freshness we did not check.
    expect(second.json().candidate.fetchedAt).toBeTruthy();
    // And no token: nothing was verified with Google in that request.
    expect(second.json().resolutionToken).toBeUndefined();

    const again = await submit(
      { googlePlaceId: 'ChIJpr4Known' },
      await register('pr4-known-2@gogo.id.vn'),
    );
    expect(again.json().status).toBe('ALREADY_EXISTS');
    expect(billed(), 'a catalogued place costs no Details at all').toEqual([]);
  });

  it('submitting without a token still works, and still pays', async () => {
    const user = await register('pr4-notoken@gogo.id.vn');
    places.seed({ providerPlaceId: 'ChIJpr4NoToken', name: 'Quán PR4 Không Token' });

    resetBilling();
    const submitted = await submit({ googlePlaceId: 'ChIJpr4NoToken' }, user);
    expect(submitted.statusCode).toBe(201);
    // #338 — the rollback path still costs one Details, and it is now Pro
    // rather than Enterprise: this branch reads `businessStatus` and hands the
    // object to dedup, and neither wants a rating.
    expect(billed(), 'the old path is the rollback, and it still pays once').toEqual(['core']);
  });

  it.each([
    [
      'edited',
      () =>
        `${signResolutionAttestation({
          googlePlaceId: 'ChIJpr4Bad',
          secret: 'not-the-servers-secret',
          ttlSeconds: 600,
        })}`,
    ],
    [
      'expired',
      () =>
        signResolutionAttestation({
          googlePlaceId: 'ChIJpr4Bad',
          secret: ATTESTATION_SECRET,
          ttlSeconds: 600,
          now: new Date(Date.now() - 3_600_000),
        }),
    ],
    [
      'minted for another place',
      () =>
        signResolutionAttestation({
          googlePlaceId: 'ChIJsomewhere-else',
          secret: ATTESTATION_SECRET,
          ttlSeconds: 600,
        }),
    ],
  ])('refuses a %s token instead of quietly fetching Google', async (_label, mint) => {
    const user = await register(`pr4-bad-${_label.replace(/\W+/g, '')}@gogo.id.vn`);
    places.seed({ providerPlaceId: 'ChIJpr4Bad', name: 'Quán PR4 Token Hỏng' });

    resetBilling();
    const res = await submit({ googlePlaceId: 'ChIJpr4Bad', resolutionToken: mint() }, user);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('RESOLUTION_TOKEN_INVALID');
    // The client is told to re-resolve; it is not silently charged for one.
    expect(res.json().retryable).toBe(true);
    expect(billed(), 'a rejected token never becomes a Google call').toEqual([]);
  });

  it('mints no token for a closed place, so submit still refuses it', async () => {
    const user = await register('pr4-closed@gogo.id.vn');
    places.seed({
      providerPlaceId: 'ChIJpr4Closed',
      name: 'Quán PR4 Đã Đóng',
      businessStatus: 'CLOSED_PERMANENTLY',
    });

    const preview = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJpr4Closed' });
    expect(preview.json().status).toBe('RESOLVED');
    // Closure is Google content and may not ride in the token, so the token's
    // absence is what carries it (plan §2.8).
    expect(preview.json().resolutionToken).toBeUndefined();

    const res = await submit({ googlePlaceId: 'ChIJpr4Closed' }, user);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_CLOSED');
  });

  /**
   * ADR-0006 §9.5, asserted rather than promised: PR4 may remove provider
   * calls, and may not add a single stored provider-derived field.
   */
  it('stores no Google content it did not store before', async () => {
    const before = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name in ('place_submissions', 'place_imports')
      order by column_name
    `);
    const columns = (before.rows as { column_name: string }[]).map((r) => r.column_name);

    // `place_imports.provider_snapshot` is still here: #348 stopped writing it
    // and purged it, and the column drops one release later. What must not
    // appear is anything *this* PR could have been tempted to add — a stored
    // token, or the provider facts the attestation deliberately does not carry.
    for (const forbidden of [
      'resolution_token',
      'resolution_attestation',
      'provider_name',
      'provider_address',
      'provider_business_status',
    ]) {
      expect(columns, `${forbidden} would be a new Google content store`).not.toContain(forbidden);
    }
    const snapshot = await db.execute(
      sql`select count(*)::int as n from place_imports where provider_snapshot is not null`,
    );
    expect(
      (snapshot.rows[0] as { n: number }).n,
      'the R5 column stays empty — PR4 must not start filling it again',
    ).toBe(0);
  });
});

/**
 * COST-BE-004 review (#337) — identity and verification are different questions
 * and must not share a freshness window.
 *
 * `refresh_after` says how long the catalogue may keep serving a provider row.
 * It says nothing about whether that row is recent enough to decide, right now,
 * that a place is open. Answering both with one window meant a `source_status`
 * from three weeks ago could refuse a reopened place — and, had anyone wired a
 * DB-derived shortcut into the creating path, could have stood in for
 * verification on a proposal for a place GoGo does not have.
 */
describe('#337 review — a stored fact may prove identity, never freshness', () => {
  const submit = (payload: Record<string, unknown>, token: string) =>
    api().inject({
      method: 'POST',
      url: '/v1/place-submissions',
      remoteAddress: ip(),
      headers: auth(token),
      payload,
    });

  /** Puts a place in the catalogue through the product's own path. */
  async function catalogue(googlePlaceId: string, name: string): Promise<string> {
    const moderator = await createAdmin(`rev-${googlePlaceId}@gogo.local`, 'moderator');
    const user = await register(`rev-${googlePlaceId}@gogo.id.vn`);
    places.seed({ providerPlaceId: googlePlaceId, name, lat: 10.7769, lng: 106.7009 });
    const preview = await resolve({
      url: `https://www.google.com/maps?place_id=${googlePlaceId}`,
    });
    const submitted = await submit(
      { googlePlaceId, resolutionToken: preview.json().resolutionToken },
      user,
    );
    const decided = await api().inject({
      method: 'POST',
      url: `/v1/cms/place-submissions/${submitted.json().submissionId}/decide`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'approved', reason: 'đã duyệt' },
    });
    expect(decided.statusCode, JSON.stringify(decided.json())).toBe(201);
    return decided.json().placeId as string;
  }

  /** Ages the provider row without touching how long it may be served for. */
  async function ageProviderRow(googlePlaceId: string, interval: string): Promise<void> {
    await db.execute(sql`
      update place_provider_sources
      set fetched_at = now() - ${interval}::interval,
          refresh_after = now() + interval '20 days'
      where external_id = ${googlePlaceId}
    `);
  }

  async function setStoredStatus(googlePlaceId: string, status: string): Promise<void> {
    await db.execute(sql`
      update place_provider_sources set source_status = ${status}
      where external_id = ${googlePlaceId}
    `);
  }

  it('refuses a closed place from a stored status only while that status is recent', async () => {
    await catalogue('ChIJrevFresh', 'Quán Vừa Đóng');
    await setStoredStatus('ChIJrevFresh', 'closed');
    await ageProviderRow('ChIJrevFresh', '30 seconds');
    const user = await register('rev-fresh-closed@gogo.id.vn');

    places.tiersRequested.length = 0;
    const res = await submit({ googlePlaceId: 'ChIJrevFresh' }, user);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_CLOSED');
    expect(places.tiersRequested, 'a recent closure needs no confirmation').toEqual([]);
  });

  it('asks Google again when the only closure proof is weeks old', async () => {
    const placeId = await catalogue('ChIJrevStale', 'Quán Mở Lại');
    await setStoredStatus('ChIJrevStale', 'closed');
    // Well outside PLACE_RESOLUTION_TTL_S, comfortably inside `refresh_after`:
    // the exact gap the review is about.
    await ageProviderRow('ChIJrevStale', '21 days');
    const user = await register('rev-stale-closed@gogo.id.vn');

    places.tiersRequested.length = 0;
    const res = await submit({ googlePlaceId: 'ChIJrevStale' }, user);

    // Google still has it operational, so the reopened place is not refused on
    // a three-week-old fact — and the answer cost exactly one Details call,
    // at the tier that answers it: `businessStatus` is a `core` field (#338).
    expect(places.tiersRequested, 'stale closure is re-verified, not trusted').toEqual(['core']);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ status: 'ALREADY_EXISTS', placeId });
  });

  it('still answers identity from an old row — identity does not go stale', async () => {
    const placeId = await catalogue('ChIJrevIdentity', 'Quán Vẫn Còn Đó');
    await ageProviderRow('ChIJrevIdentity', '21 days');
    const user = await register('rev-identity@gogo.id.vn');

    places.tiersRequested.length = 0;
    const res = await submit({ googlePlaceId: 'ChIJrevIdentity' }, user);

    expect(res.json()).toEqual({ status: 'ALREADY_EXISTS', placeId });
    expect(
      places.tiersRequested,
      'which place an ID belongs to is not a question Google needs to re-answer',
    ).toEqual([]);
    // …and the cheap answer is still the true one.
    const preview = await resolve({
      url: 'https://www.google.com/maps?place_id=ChIJrevIdentity',
    });
    expect(preview.json().status).toBe('ALREADY_EXISTS');
    expect(preview.json().existingPlaceId).toBe(placeId);
  });

  /**
   * The invariant the review asked to be enforced rather than emergent: a
   * proposal for a place GoGo does not hold is only ever created on evidence
   * minutes old. `assertFreshlyVerified` is the runtime half; this is the half
   * that would notice if the runtime half were deleted.
   */
  it('creates a proposal only after a live fetch or a valid attestation', async () => {
    const before = await db.execute(sql`select count(*)::int as n from place_submissions`);
    const startCount = (before.rows[0] as { n: number }).n;

    // 1 · no token → one live Details, then the proposal.
    places.seed({ providerPlaceId: 'ChIJrevNew1', name: 'Quán Mới Một' });
    places.tiersRequested.length = 0;
    const live = await submit(
      { googlePlaceId: 'ChIJrevNew1' },
      await register('rev-new-1@gogo.id.vn'),
    );
    expect(live.json().status).toBe('PENDING');
    expect(places.tiersRequested).toEqual(['core']);

    // 2 · valid token → no Details, and the proposal still requires the token
    //     to have been minted from a live check moments ago.
    places.seed({ providerPlaceId: 'ChIJrevNew2', name: 'Quán Mới Hai' });
    const preview = await resolve({ url: 'https://www.google.com/maps?place_id=ChIJrevNew2' });
    places.tiersRequested.length = 0;
    const attested = await submit(
      { googlePlaceId: 'ChIJrevNew2', resolutionToken: preview.json().resolutionToken },
      await register('rev-new-2@gogo.id.vn'),
    );
    expect(attested.json().status).toBe('PENDING');
    expect(places.tiersRequested).toEqual([]);

    // 3 · neither → no proposal at all, and no silent fetch to rescue it.
    places.failing = true;
    try {
      const refused = await submit(
        { googlePlaceId: 'ChIJrevNever' },
        await register('rev-new-3@gogo.id.vn'),
      );
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      places.failing = false;
    }

    const after = await db.execute(sql`select count(*)::int as n from place_submissions`);
    expect(
      (after.rows[0] as { n: number }).n - startCount,
      'exactly the two that were verified — never the third',
    ).toBe(2);
  });

  /**
   * Review item 1: the legacy import path may skip its create-gating rules on a
   * DB-first hit **only** because that hit creates nothing. Asserted, not
   * assumed.
   */
  it('legacy import links to the existing place without creating or touching one', async () => {
    const placeId = await catalogue('ChIJrevImport', 'Quán Nhập Lại');
    const user = await register('rev-import@gogo.id.vn');
    const snapshot = await db.execute(sql`
      select count(*)::int as places, max(updated_at) as newest from places
    `);
    const before = snapshot.rows[0] as { places: number; newest: string };

    places.tiersRequested.length = 0;
    const res = await api().inject({
      method: 'POST',
      url: '/v1/places/imports',
      remoteAddress: ip(),
      headers: auth(user),
      payload: { url: 'https://www.google.com/maps?place_id=ChIJrevImport' },
    });

    expect(res.json().status).toBe('verified');
    expect(res.json().placeId).toBe(placeId);
    expect(places.tiersRequested, 'no Details for a place we already hold').toEqual([]);

    const after = await db.execute(sql`
      select count(*)::int as places, max(updated_at) as newest from places
    `);
    const now = after.rows[0] as { places: number; newest: string };
    expect(now.places, 'no canonical place created').toBe(before.places);
    expect(String(now.newest), 'no canonical place materially updated').toBe(String(before.newest));
  });
});
