import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/**
 * GoGo-BE#217 (ADR-0028) — the GoGo community rating on Place Detail, over
 * real HTTP against a real database.
 *
 * What these cases hold: the count always travels and the score only from five
 * published reviews; the population is exactly the place's published reviews
 * (every one of them, not the three-review preview); a moderation decision
 * shows on the very next read; a merge carries reviews to the canonical place;
 * the provider rating stays its own fact; a broken read is an error, never
 * "not enough reviews"; and the aggregate rides `reviews_place_idx`.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.71.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let moderator = '';
let editor = '';
let seq = 0;

type ReviewStatus = 'pending' | 'published' | 'rejected' | 'removed' | 'hidden';
type PlaceStatus = 'published' | 'community_submitted' | 'draft' | 'suspended';

async function place(
  status: PlaceStatus = 'published',
  provider?: { rating: string; ratingCount: number },
) {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Quán rating ${seq}`,
      nameNormalized: 'set-by-trigger',
      status,
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      confidence: '0.9',
      ...(provider ? { rating: provider.rating, ratingCount: provider.ratingCount } : {}),
    })
    .returning();
  return row!.id;
}

async function account(displayName = 'Lan') {
  seq += 1;
  const email = `rating-author-${seq}@gogo.id.vn`;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName },
  });
  const body = res.json();
  expect(body.accessToken).toBeTruthy();
  return { token: body.accessToken as string, userId: body.userId as string };
}

async function review(
  placeId: string,
  userId: string,
  over: Partial<{ status: ReviewStatus; rating: number; text: string | null }> = {},
) {
  const [row] = await db
    .insert(schema.reviews)
    .values({
      userId,
      placeId,
      rating: over.rating ?? 4,
      text: over.text === undefined ? 'Ổn' : over.text,
      status: over.status ?? 'published',
    })
    .returning();
  return row!.id;
}

async function reviews(placeId: string, userId: string, ratings: number[]) {
  for (const rating of ratings) await review(placeId, userId, { rating });
}

const detail = (placeId: string) =>
  api().inject({ method: 'GET', url: `/v1/places/${placeId}`, remoteAddress: ip() });

async function admin(email: string, role: 'moderator' | 'editor') {
  await db.insert(schema.adminUsers).values({
    email,
    passwordHash: await argon2.hash('admin-password-123', { type: argon2.argon2id }),
    displayName: role,
    role,
  });
  const login = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  const token = login.json().accessToken as string;
  expect(token).toBeTruthy();
  return token;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_gogo_rating_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  moderator = await admin('rating-moderator@gogo.local', 'moderator');
  editor = await admin('rating-editor@gogo.local', 'editor');
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // Reviews, plan stops and check-ins all go with their place.
  await db.execute(sql`truncate table places cascade`);
});

describe('the sample threshold (#217)', () => {
  it.each([0, 1, 4])('at %i published reviews: count present, score absent', async (n) => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(
      placeId,
      userId,
      Array.from({ length: n }, () => 5),
    );

    const res = await detail(placeId);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gogoRatingCount).toBe(n);
    expect(Number.isInteger(body.gogoRatingCount)).toBe(true);
    // Omitted, not null and not 0 — the key is not in the JSON at all.
    expect(body).not.toHaveProperty('gogoRating');
    expect(res.body).not.toContain('"gogoRating":');
  });

  it.each([
    [5, [5, 4, 4, 4, 4], 4.2],
    [6, [1, 2, 3, 4, 5, 5], 3.3],
  ])('at %i published reviews: score and count, as JSON numbers', async (n, ratings, mean) => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(placeId, userId, ratings);

    const res = await detail(placeId);
    const body = res.json();

    expect(body.gogoRatingCount).toBe(n);
    expect(body.gogoRating).toBe(mean);
    expect(typeof body.gogoRating).toBe('number');
    expect(body.gogoRating).toBeGreaterThanOrEqual(1);
    expect(body.gogoRating).toBeLessThanOrEqual(5);
    expect(res.body).toContain(`"gogoRating":${mean}`);
  });

  it('rounds the mean once, half away from zero: 4.25 → 4.3', async () => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(placeId, userId, [5, 5, 4, 4, 4, 4, 4, 4]); // 34 / 8 = 4.25

    const body = (await detail(placeId)).json();

    expect(body).toMatchObject({ gogoRating: 4.3, gogoRatingCount: 8 });
  });
});

describe('who is in the population (#217)', () => {
  it('counts nothing still in, or taken out of, moderation', async () => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(placeId, userId, [4, 4, 4, 4]);
    for (const status of ['pending', 'rejected', 'removed', 'hidden'] as const) {
      await review(placeId, userId, { status, rating: 1 });
      await review(placeId, userId, { status, rating: 1 });
    }

    const body = (await detail(placeId)).json();

    expect(body.gogoRatingCount).toBe(4);
    expect(body).not.toHaveProperty('gogoRating');
  });

  it("never counts another place's reviews, plan reviews or check-ins", async () => {
    const here = await place();
    const elsewhere = await place();
    const { userId } = await account();
    await reviews(here, userId, [4, 4, 4, 4]);
    await reviews(elsewhere, userId, [1, 1, 1, 1, 1, 1]);

    // A plan review and a check-in with a rating, both about a plan whose stop
    // is this very place. Neither is a place review.
    await db.execute(sql`
      with r as (
        insert into rooms (code, type, decision_mode, host_user_id)
        values (${`gr-${seq}`}, 'couple', 'match', ${userId}) returning id
      ), m as (
        insert into room_members (room_id, user_id, role, display_name)
        select id, ${userId}, 'host', 'Lan' from r returning id, room_id
      ), p as (
        insert into plans (room_id, version, totals, constraint_version)
        select room_id, 1, '{}'::jsonb, 1 from m returning id
      ), s as (
        insert into plan_stops (plan_id, place_id, position, duration_minutes)
        select id, ${here}, 0, 60 from p returning id
      ), c as (
        insert into stop_checkins (plan_stop_id, member_id, rating)
        select s.id, m.id, 1 from s, m returning id
      )
      insert into reviews (user_id, plan_id, rating, status)
      select ${userId}, p.id, 1, 'published' from p
    `);

    const body = (await detail(here)).json();

    expect(body.gogoRatingCount).toBe(4);
    expect(body).not.toHaveProperty('gogoRating');
  });

  it('counts every published review — beyond the preview, repeated authors, no text', async () => {
    const placeId = await place();
    const a = await account('A');
    const b = await account('B');
    await reviews(placeId, a.userId, [5, 5, 5, 5]); // one author, four reviews
    await review(placeId, b.userId, { rating: 3, text: null });
    await review(placeId, b.userId, { rating: 3, text: '   ' });

    const body = (await detail(placeId)).json();
    const preview = (
      await api().inject({
        method: 'GET',
        url: `/v1/places/${placeId}/reviews`,
        remoteAddress: ip(),
      })
    ).json();

    expect(preview.reviews).toHaveLength(3);
    expect(body).toMatchObject({ gogoRatingCount: 6, gogoRating: 4.3 }); // 26 / 6
  });

  it('keeps the reviews of a deleted account in the population (ADR-0023)', async () => {
    const placeId = await place();
    const leaving = await account('Hoa');
    const staying = await account('Minh');
    await reviews(placeId, leaving.userId, [5, 5]);
    await reviews(placeId, staying.userId, [3, 3, 3]);

    const deleted = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(leaving.token),
    });
    expect(deleted.statusCode).toBe(200);

    expect((await detail(placeId)).json()).toMatchObject({
      gogoRatingCount: 5,
      gogoRating: 3.8,
    });
  });
});

describe('moderation shows on the next read (#217)', () => {
  it('follows publish, reject, edit-to-pending, re-publish and emergency hide: 4→5→4→5→4', async () => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(placeId, userId, [4, 4, 4, 4]);
    const author = await account('Tác giả');

    const created = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(author.token),
      payload: { placeId, rating: 5, text: 'Không gian yên tĩnh' },
    });
    expect(created.statusCode).toBe(201);
    const reviewId = created.json().id as string;

    const decide = (id: string, decision: 'published' | 'rejected') =>
      api().inject({
        method: 'POST',
        url: `/v1/cms/moderation/reviews/${id}`,
        remoteAddress: ip(),
        headers: auth(moderator),
        payload: { decision, reason: 'Checked against the guidelines' },
      });
    const facts = async () => {
      const res = await detail(placeId);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      return { count: body.gogoRatingCount, score: body.gogoRating };
    };

    expect(await facts()).toEqual({ count: 4, score: undefined }); // pending
    expect((await decide(reviewId, 'published')).statusCode).toBe(201);
    expect(await facts()).toEqual({ count: 5, score: 4.2 });

    const edited = await api().inject({
      method: 'PATCH',
      url: `/v1/reviews/${reviewId}`,
      remoteAddress: ip(),
      headers: auth(author.token),
      payload: { text: 'Không gian yên tĩnh, hơi đông cuối tuần' },
    });
    expect(edited.json().status).toBe('pending');
    expect(await facts()).toEqual({ count: 4, score: undefined });

    expect((await decide(reviewId, 'published')).statusCode).toBe(201);
    expect(await facts()).toEqual({ count: 5, score: 4.2 });

    const hidden = await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/reviews/${reviewId}/hide`,
      remoteAddress: ip(),
      headers: auth(moderator),
      payload: { reason: 'Reported as harassment, pending review' },
    });
    expect(hidden.statusCode).toBe(201);
    expect(await facts()).toEqual({ count: 4, score: undefined });
  });

  it('a rejected review never enters the population', async () => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(placeId, userId, [4, 4, 4, 4]);
    const author = await account();
    const created = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(author.token),
      payload: { placeId, rating: 1, text: 'spam spam' },
    });
    const rejected = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${created.json().id}`,
      remoteAddress: ip(),
      headers: auth(moderator),
      payload: { decision: 'rejected', reason: 'Spam content' },
    });
    expect(rejected.statusCode).toBe(201);

    const body = (await detail(placeId)).json();
    expect(body.gogoRatingCount).toBe(4);
    expect(body).not.toHaveProperty('gogoRating');
  });

  it('a merge carries the duplicate’s reviews to the canonical place', async () => {
    const canonical = await place();
    const duplicate = await place();
    const { userId } = await account();
    await reviews(canonical, userId, [5, 5, 5]);
    await reviews(duplicate, userId, [3, 3]);
    expect((await detail(canonical)).json()).not.toHaveProperty('gogoRating');

    const merged = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${canonical}/merge`,
      remoteAddress: ip(),
      headers: auth(editor),
      payload: { duplicateId: duplicate },
    });
    expect(merged.statusCode).toBe(201);

    expect((await detail(canonical)).json()).toMatchObject({
      gogoRatingCount: 5,
      gogoRating: 4.2,
    });
  });
});

describe('beside the provider rating, never merged with it (#217)', () => {
  it('leaves rating, ratingCount and the attribution exactly as they were', async () => {
    const placeId = await place('published', { rating: '4.60', ratingCount: 980 });
    await db.insert(schema.placeSources).values({
      placeId,
      provider: 'google',
      externalId: `ChIJrating${seq}`,
      attribution: 'Google Maps',
    });
    const { userId } = await account();
    await reviews(placeId, userId, [2, 2, 2, 2, 2]);

    const body = (await detail(placeId)).json();

    expect(body).toMatchObject({
      rating: 4.6,
      ratingCount: 980,
      gogoRating: 2,
      gogoRatingCount: 5,
    });
    expect(body.sources).toEqual([expect.objectContaining({ attribution: 'Google Maps' })]);
  });

  it('works for a place with no provider data at all', async () => {
    const placeId = await place();
    const { userId } = await account();
    await reviews(placeId, userId, [4, 4, 5, 5, 5]);

    const body = (await detail(placeId)).json();

    expect(body).not.toHaveProperty('rating');
    expect(body.ratingCount).toBe(0);
    expect(body.sources ?? []).toEqual([]);
    expect(body).toMatchObject({ gogoRating: 4.6, gogoRatingCount: 5 });
  });
});

describe('which places answer, and how a failure answers (#217)', () => {
  it('answers a community-submitted place; 404 for drafts, suspended and unknown ids', async () => {
    const community = await place('community_submitted');
    const ok = await detail(community);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().gogoRatingCount).toBe(0);

    for (const status of ['draft', 'suspended'] as const) {
      const hiddenPlace = await place(status);
      const { userId } = await account();
      await reviews(hiddenPlace, userId, [5, 5, 5, 5, 5]);
      const res = await detail(hiddenPlace);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLACE_NOT_FOUND');
    }
    expect((await detail('7a0c2f7e-2f3b-4b8e-9d57-0b6a5f1d9c11')).statusCode).toBe(404);
  });

  it('a database error is a 5xx, never a 200 saying "not enough reviews"', async () => {
    const placeId = await place();
    await db.execute(sql`alter table reviews rename to reviews_unavailable`);
    try {
      const res = await detail(placeId);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('gogoRatingCount');
    } finally {
      await db.execute(sql`alter table reviews_unavailable rename to reviews`);
    }
    expect((await detail(placeId)).statusCode).toBe(200);
  });
});

describe('read cost (#217)', () => {
  it('aggregates through reviews_place_idx on a representative volume', async () => {
    const { userId } = await account();
    const target = await place();
    // 300 places × 60 reviews = 18,000 rows, mixed statuses.
    await db.execute(sql`
      with ps as (
        insert into places (name, name_normalized, status, geom, confidence)
        select 'Vol ' || g, 'x', 'published',
               ST_SetSRID(ST_MakePoint(106.6 + g / 10000.0, 10.7), 4326), 0.9
        from generate_series(1, 300) g
        returning id
      )
      insert into reviews (user_id, place_id, rating, status)
      select ${userId}, ps.id, 1 + (n % 5),
             (case when n % 4 = 0 then 'pending' else 'published' end)::review_status
      from ps, generate_series(1, 60) n
    `);
    await reviews(target, userId, [4, 4, 4, 4, 5]);
    await db.execute(sql`analyze reviews`);

    const plan = await db.execute(sql`
      explain (analyze, format text)
      select count(*)::int, round(avg(r.rating)::numeric, 1)
      from reviews r where r.place_id = ${target} and r.status = 'published'
    `);
    const text = (plan.rows as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('reviews_place_idx');
    expect(text).not.toMatch(/Seq Scan on reviews/);

    const res = await detail(target);
    expect(res.json()).toMatchObject({ gogoRatingCount: 5, gogoRating: 4.2 });
  });
});
