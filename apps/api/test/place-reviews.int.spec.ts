import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/**
 * BE-BFF-018 (#570) — the latest three GoGo reviews of a place, over real HTTP.
 *
 * What these cases hold: only a moderator's `published` verdict is public, the
 * order is newest first and stays the same when two reviews share a timestamp,
 * a moderation change is visible on the very next read, and the author is a
 * display name and nothing that identifies or reaches the person.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.70.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let moderator = '';
let seq = 0;

type ReviewStatus = 'pending' | 'published' | 'rejected' | 'removed' | 'hidden';
type PlaceStatus = 'published' | 'community_submitted' | 'draft' | 'suspended';

async function place(status: PlaceStatus = 'published') {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Quán review ${seq}`,
      nameNormalized: 'set-by-trigger',
      status,
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

async function account(displayName = 'Lan') {
  seq += 1;
  const email = `review-author-${seq}@gogo.id.vn`;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName },
  });
  const body = res.json();
  expect(body.accessToken).toBeTruthy();
  return { token: body.accessToken as string, userId: body.userId as string, email };
}

async function review(
  placeId: string,
  userId: string,
  over: Partial<{
    id: string;
    status: ReviewStatus;
    rating: number;
    text: string | null;
    createdAt: Date;
  }> = {},
) {
  const [row] = await db
    .insert(schema.reviews)
    .values({
      ...(over.id ? { id: over.id } : {}),
      userId,
      placeId,
      rating: over.rating ?? 4,
      text: over.text === undefined ? 'Ngon, phục vụ nhanh' : over.text,
      status: over.status ?? 'published',
      createdAt: over.createdAt ?? new Date(),
    })
    .returning();
  return row!.id;
}

const read = (placeId: string) =>
  api().inject({ method: 'GET', url: `/v1/places/${placeId}/reviews`, remoteAddress: ip() });

const idsOf = (res: { json: () => { reviews: { id: string }[] } }) =>
  res.json().reviews.map((r) => r.id);

/** A fixed clock, so "newest" never depends on how fast the inserts ran. */
const minutesAgo = (m: number) => new Date(Date.UTC(2026, 8, 14, 5, 0, 0) - m * 60_000);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_reviews_test')
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

  const email = 'reviews-moderator@gogo.local';
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: 'moderator', role: 'moderator' });
  const login = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  moderator = login.json().accessToken as string;
  expect(moderator).toBeTruthy();
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // Reviews cascade with their place.
  await db.execute(sql`truncate table places cascade`);
});

describe('how many reviews a place shows (#570)', () => {
  it('answers an empty GoGo list, not an error, when nothing is published', async () => {
    const placeId = await place();

    const res = await read(placeId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ source: 'gogo', order: 'latest', reviews: [] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('shows the one published review and nothing still in or taken out of moderation', async () => {
    const placeId = await place();
    const { userId } = await account();
    for (const status of ['pending', 'rejected', 'removed', 'hidden'] as const) {
      // Newer than the published one: order must not be what keeps them out.
      await review(placeId, userId, { status, createdAt: minutesAgo(1) });
    }
    const published = await review(placeId, userId, { createdAt: minutesAgo(30) });

    expect(idsOf(await read(placeId))).toEqual([published]);
  });

  it('shows all three when there are exactly three, newest first', async () => {
    const placeId = await place();
    const { userId } = await account();
    const oldest = await review(placeId, userId, { createdAt: minutesAgo(30) });
    const newest = await review(placeId, userId, { createdAt: minutesAgo(10) });
    const middle = await review(placeId, userId, { createdAt: minutesAgo(20) });

    expect(idsOf(await read(placeId))).toEqual([newest, middle, oldest]);
  });

  it('shows only the newest three when there are more', async () => {
    const placeId = await place();
    const { userId } = await account();
    const byAge = new Map<number, string>();
    for (const m of [50, 10, 40, 20, 30]) {
      byAge.set(m, await review(placeId, userId, { createdAt: minutesAgo(m) }));
    }

    const res = await read(placeId);

    expect(idsOf(res)).toEqual([byAge.get(10), byAge.get(20), byAge.get(30)]);
  });

  it('breaks a tied timestamp on id, and every read agrees', async () => {
    const placeId = await place();
    const { userId } = await account();
    const sameInstant = minutesAgo(5);
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    for (const n of [2, 4, 1, 3]) {
      await review(placeId, userId, { id: id(n), createdAt: sameInstant });
    }

    const first = idsOf(await read(placeId));
    const second = idsOf(await read(placeId));

    expect(first).toEqual([id(4), id(3), id(2)]);
    expect(second).toEqual(first);
  });

  it("keeps one place's reviews on that place", async () => {
    const here = await place();
    const elsewhere = await place();
    const { userId } = await account();
    const mine = await review(here, userId);
    await review(elsewhere, userId, { createdAt: new Date(Date.now() + 60_000) });

    expect(idsOf(await read(here))).toEqual([mine]);
  });
});

describe('which places answer (#570)', () => {
  it('answers for every place Place Detail opens, and 404 for the rest', async () => {
    const community = await place('community_submitted');
    expect((await read(community)).statusCode).toBe(200);

    for (const status of ['draft', 'suspended'] as const) {
      const hiddenPlace = await place(status);
      const detail = await api().inject({
        method: 'GET',
        url: `/v1/places/${hiddenPlace}`,
        remoteAddress: ip(),
      });
      const res = await read(hiddenPlace);
      expect(detail.statusCode).toBe(404);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLACE_NOT_FOUND');
    }

    const unknown = await read('7a0c2f7e-2f3b-4b8e-9d57-0b6a5f1d9c11');
    expect(unknown.statusCode).toBe(404);
    expect((await read('not-a-uuid')).statusCode).toBe(400);
  });
});

describe('moderation decides what is public, on the next read (#570)', () => {
  it('follows a review through publish, edit, re-publish and emergency hide', async () => {
    const placeId = await place();
    const author = await account();

    const created = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(author.token),
      payload: { placeId, rating: 5, text: 'Không gian yên tĩnh' },
    });
    expect(created.statusCode).toBe(201);
    const reviewId = created.json().id as string;
    expect(idsOf(await read(placeId))).toEqual([]);

    const decide = (decision: 'published' | 'rejected', id = reviewId) =>
      api().inject({
        method: 'POST',
        url: `/v1/cms/moderation/reviews/${id}`,
        remoteAddress: ip(),
        headers: auth(moderator),
        payload: { decision, reason: 'Checked against the guidelines' },
      });

    expect((await decide('published')).statusCode).toBe(201);
    const afterPublish = await read(placeId);
    expect(idsOf(afterPublish)).toEqual([reviewId]);
    expect(afterPublish.json().reviews[0]).toMatchObject({
      rating: 5,
      text: 'Không gian yên tĩnh',
    });

    // An edit goes back through moderation, and off the place until decided.
    const edited = await api().inject({
      method: 'PATCH',
      url: `/v1/reviews/${reviewId}`,
      remoteAddress: ip(),
      headers: auth(author.token),
      payload: { text: 'Không gian yên tĩnh, hơi đông cuối tuần' },
    });
    expect(edited.json().status).toBe('pending');
    expect(idsOf(await read(placeId))).toEqual([]);

    expect((await decide('published')).statusCode).toBe(201);
    expect((await read(placeId)).json().reviews[0].text).toBe(
      'Không gian yên tĩnh, hơi đông cuối tuần',
    );

    const hidden = await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/reviews/${reviewId}/hide`,
      remoteAddress: ip(),
      headers: auth(moderator),
      payload: { reason: 'Reported as harassment, pending review' },
    });
    expect(hidden.statusCode).toBe(201);
    expect(idsOf(await read(placeId))).toEqual([]);
  });

  it('never lists a review a moderator rejected', async () => {
    const placeId = await place();
    const author = await account();
    const created = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(author.token),
      payload: { placeId, rating: 1, text: 'spam spam' },
    });
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${created.json().id}`,
      remoteAddress: ip(),
      headers: auth(moderator),
      payload: { decision: 'rejected', reason: 'Spam content' },
    });
    expect(res.statusCode).toBe(201);
    expect(idsOf(await read(placeId))).toEqual([]);
  });
});

describe('what a stranger learns about the author (#570)', () => {
  it('reads a display name, a date, a rating and the text — no id, email or avatar', async () => {
    const placeId = await place();
    const author = await account('Minh');
    await db
      .update(schema.users)
      .set({ avatarKey: 'avatars/0123456789abcdef.webp' })
      .where(eq(schema.users.id, author.userId));
    await review(placeId, author.userId, { rating: 3, createdAt: minutesAgo(3) });

    const res = await read(placeId);
    const [item] = res.json().reviews;

    expect(Object.keys(item).sort()).toEqual([
      'author',
      'createdAt',
      'helpfulCount',
      'id',
      'rating',
      'text',
    ]);
    expect(item.author).toEqual({ displayName: 'Minh' });
    expect(item.createdAt).toBe(minutesAgo(3).toISOString());
    expect(res.body).not.toContain(author.userId);
    expect(res.body).not.toContain(author.email);
    expect(res.body).not.toContain('avatars/');
  });

  it('omits the text of a review that has none', async () => {
    const placeId = await place();
    const { userId } = await account();
    await review(placeId, userId, { text: null });

    const [item] = (await read(placeId)).json().reviews;

    expect(item).not.toHaveProperty('text');
  });

  it('keeps the review of a deleted account but drops its name (ADR-0023)', async () => {
    const placeId = await place();
    const author = await account('Hoa');
    const reviewId = await review(placeId, author.userId);

    const deleted = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(author.token),
    });
    expect(deleted.statusCode).toBe(200);

    const [item] = (await read(placeId)).json().reviews;
    expect(item.id).toBe(reviewId);
    expect(item.author).toEqual({ displayName: null });
  });
});
