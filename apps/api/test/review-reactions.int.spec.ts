import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/**
 * BE-BFF-019 (#571), ADR-0026 (PROPOSAL) — `helpful` reactions and the
 * helpful-first preview, over real HTTP.
 *
 * What these cases hold: a mark counts once however it is repeated, removal is
 * as idempotent as adding, only signed-in accounts mark and never their own
 * review, anything unpublished is indistinguishable from missing, the ranking
 * is stable and falls back to newest, moderation outranks every count, and no
 * public answer names a reactor.
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
let guest = '';
let seq = 0;

type ReviewStatus = 'pending' | 'published' | 'rejected' | 'removed' | 'hidden';

async function place(status: 'published' | 'draft' = 'published') {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Quán reaction ${seq}`,
      nameNormalized: 'set-by-trigger',
      status,
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

async function account(displayName = 'Người đọc') {
  seq += 1;
  const email = `reaction-${seq}@gogo.id.vn`;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName },
  });
  const body = res.json();
  expect(body.accessToken).toBeTruthy();
  return { token: body.accessToken as string, userId: body.userId as string, email, displayName };
}

async function review(
  placeId: string,
  userId: string,
  over: Partial<{ id: string; status: ReviewStatus; createdAt: Date }> = {},
) {
  const [row] = await db
    .insert(schema.reviews)
    .values({
      ...(over.id ? { id: over.id } : {}),
      userId,
      placeId,
      rating: 4,
      text: 'Đáng ghé',
      status: over.status ?? 'published',
      createdAt: over.createdAt ?? new Date(),
    })
    .returning();
  return row!.id;
}

const mark = (token: string, reviewId: string, method: 'PUT' | 'DELETE' = 'PUT') =>
  api().inject({
    method,
    url: `/v1/reviews/${reviewId}/reactions/helpful`,
    remoteAddress: ip(),
    headers: auth(token),
  });

const preview = (placeId: string, order?: string) =>
  api().inject({
    method: 'GET',
    url: `/v1/places/${placeId}/reviews${order ? `?order=${order}` : ''}`,
    remoteAddress: ip(),
  });

const idsOf = (res: { json: () => { reviews: { id: string }[] } }) =>
  res.json().reviews.map((r) => r.id);

const minutesAgo = (m: number) => new Date(Date.UTC(2026, 8, 14, 5, 0, 0) - m * 60_000);

async function rowsFor(reviewId: string) {
  return db
    .select()
    .from(schema.reviewReactions)
    .where(eq(schema.reviewReactions.reviewId, reviewId));
}

/** `n` distinct readers mark `reviewId`. */
async function markedBy(reviewId: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    const reader = await account();
    expect((await mark(reader.token, reviewId)).statusCode).toBe(200);
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_review_reactions_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  const email = 'reactions-moderator@gogo.local';
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

  // A real guest session: joined to a room, scoped to it, not an account.
  const [host] = await db
    .insert(schema.users)
    .values({ displayName: 'Host', email: 'reaction-host@gogo.id.vn' })
    .returning();
  await db.insert(schema.rooms).values({
    code: 'REACTROOM7',
    type: 'group',
    status: 'collecting',
    decisionMode: 'vote',
    hostUserId: host!.id,
    participantCount: 4,
  });
  const joined = await api().inject({
    method: 'POST',
    url: '/v1/sessions/guest',
    remoteAddress: ip(),
    payload: { roomCode: 'REACTROOM7', displayName: 'Khách' },
  });
  expect(joined.statusCode).toBe(201);
  guest = joined.json().accessToken as string;
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // Reviews, and their reactions, cascade with the place.
  await db.execute(sql`truncate table places cascade`);
});

describe('marking a review helpful (#571)', () => {
  it('counts one mark per account, however many times it is sent', async () => {
    const placeId = await place();
    const author = await account();
    const reviewId = await review(placeId, author.userId);
    const reader = await account();

    const first = await mark(reader.token, reviewId);
    const again = await mark(reader.token, reviewId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ reviewId, helpfulCount: 1, reactedByMe: true });
    expect(again.json()).toEqual(first.json());

    // A double tap that reaches the server as simultaneous requests.
    const other = await account();
    const burst = await Promise.all([1, 2, 3].map(() => mark(other.token, reviewId)));
    expect(burst.map((r) => r.statusCode)).toEqual([200, 200, 200]);

    expect(await rowsFor(reviewId)).toHaveLength(2);
    expect((await preview(placeId)).json().reviews[0].helpfulCount).toBe(2);
  });

  it('removes a mark idempotently', async () => {
    const placeId = await place();
    const author = await account();
    const reviewId = await review(placeId, author.userId);
    const reader = await account();
    await mark(reader.token, reviewId);

    const removed = await mark(reader.token, reviewId, 'DELETE');
    const removedAgain = await mark(reader.token, reviewId, 'DELETE');

    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ reviewId, helpfulCount: 0, reactedByMe: false });
    expect(removedAgain.json()).toEqual(removed.json());
    expect(await rowsFor(reviewId)).toHaveLength(0);
  });

  it('refuses a mark on your own review', async () => {
    const placeId = await place();
    const author = await account();
    const reviewId = await review(placeId, author.userId);

    const res = await mark(author.token, reviewId);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('OWN_REVIEW');
    expect(await rowsFor(reviewId)).toHaveLength(0);
  });

  it('lets guests and strangers read counts, and only accounts mark', async () => {
    const placeId = await place();
    const author = await account();
    const reviewId = await review(placeId, author.userId);
    await markedBy(reviewId, 1);

    const asGuest = await mark(guest, reviewId);
    expect(asGuest.statusCode).toBe(403);
    expect(asGuest.json().code).toBe('USER_ONLY');

    const anonymous = await api().inject({
      method: 'PUT',
      url: `/v1/reviews/${reviewId}/reactions/helpful`,
      remoteAddress: ip(),
    });
    expect(anonymous.statusCode).toBe(401);

    const guestList = await api().inject({
      method: 'GET',
      url: `/v1/me/review-reactions?placeId=${placeId}`,
      remoteAddress: ip(),
      headers: auth(guest),
    });
    expect(guestList.statusCode).toBe(403);

    expect((await preview(placeId)).json().reviews[0].helpfulCount).toBe(1);
  });

  it('answers an unpublished review, or one on a hidden place, exactly like a missing one', async () => {
    const placeId = await place();
    const author = await account();
    const reader = await account();
    for (const status of ['pending', 'rejected', 'removed', 'hidden'] as const) {
      const res = await mark(reader.token, await review(placeId, author.userId, { status }));
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('REVIEW_NOT_FOUND');
    }
    const draftPlace = await place('draft');
    const onDraft = await mark(reader.token, await review(draftPlace, author.userId));
    expect(onDraft.statusCode).toBe(404);
    const missing = await mark(reader.token, '7a0c2f7e-2f3b-4b8e-9d57-0b6a5f1d9c11');
    expect(missing.json().code).toBe('REVIEW_NOT_FOUND');
    // Even the author cannot learn that their hidden review is theirs this way.
    const ownHidden = await mark(
      author.token,
      await review(placeId, author.userId, { status: 'hidden' }),
    );
    expect(ownHidden.json().code).toBe('REVIEW_NOT_FOUND');
  });
});

describe('the most helpful three (#571)', () => {
  it('ranks by helpful count, and leaves the latest order untouched', async () => {
    const placeId = await place();
    const author = await account();
    const a = await review(placeId, author.userId, { createdAt: minutesAgo(50) });
    const b = await review(placeId, author.userId, { createdAt: minutesAgo(40) });
    const c = await review(placeId, author.userId, { createdAt: minutesAgo(10) });
    const d = await review(placeId, author.userId, { createdAt: minutesAgo(30) });
    await markedBy(a, 3);
    await markedBy(b, 2);
    await markedBy(d, 1);

    const helpful = await preview(placeId, 'helpful');
    expect(helpful.json().order).toBe('helpful');
    expect(idsOf(helpful)).toEqual([a, b, d]);
    expect(helpful.json().reviews.map((r: { helpfulCount: number }) => r.helpfulCount)).toEqual([
      3, 2, 1,
    ]);

    const latest = await preview(placeId);
    expect(latest.json().order).toBe('latest');
    expect(idsOf(latest)).toEqual([c, d, b]);
  });

  it('breaks equal counts on newest, then on id', async () => {
    const placeId = await place();
    const author = await account();
    const older = await review(placeId, author.userId, { createdAt: minutesAgo(20) });
    const newer = await review(placeId, author.userId, { createdAt: minutesAgo(5) });
    const same = minutesAgo(30);
    const low = await review(placeId, author.userId, {
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: same,
    });
    const high = await review(placeId, author.userId, {
      id: '00000000-0000-4000-8000-000000000002',
      createdAt: same,
    });
    for (const id of [older, newer, low, high]) await markedBy(id, 1);

    const first = idsOf(await preview(placeId, 'helpful'));
    expect(first).toEqual([newer, older, high]);
    expect(idsOf(await preview(placeId, 'helpful'))).toEqual(first);
    expect(low).not.toBe(high);
  });

  it('falls back to newest when nothing has a mark yet', async () => {
    const placeId = await place();
    const author = await account();
    for (const m of [40, 10, 30, 20]) {
      await review(placeId, author.userId, { createdAt: minutesAgo(m) });
    }

    expect(idsOf(await preview(placeId, 'helpful'))).toEqual(
      idsOf(await preview(placeId, 'latest')),
    );
  });

  it('rejects an order it does not know', async () => {
    const placeId = await place();
    expect((await preview(placeId, 'popular')).statusCode).toBe(400);
  });
});

describe('moderation and privacy (#571)', () => {
  it('drops a hidden review from the ranking, and restores its count if it is re-published', async () => {
    const placeId = await place();
    const author = await account();
    const top = await review(placeId, author.userId, { createdAt: minutesAgo(30) });
    const next = await review(placeId, author.userId, { createdAt: minutesAgo(20) });
    await markedBy(top, 2);
    const reader = await account();
    await mark(reader.token, top);
    await mark(reader.token, next);

    const hidden = await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/reviews/${top}/hide`,
      remoteAddress: ip(),
      headers: auth(moderator),
      payload: { reason: 'Reported as harassment, pending review' },
    });
    expect(hidden.statusCode).toBe(201);

    expect(idsOf(await preview(placeId, 'helpful'))).toEqual([next]);
    expect((await mark(reader.token, top, 'DELETE')).statusCode).toBe(404);
    const mine = await api().inject({
      method: 'GET',
      url: `/v1/me/review-reactions?placeId=${placeId}`,
      remoteAddress: ip(),
      headers: auth(reader.token),
    });
    expect(mine.json()).toEqual({ placeId, helpful: [next] });

    const restored = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${top}`,
      remoteAddress: ip(),
      headers: auth(moderator),
      payload: { decision: 'published', reason: 'Takedown overturned on review' },
    });
    expect(restored.statusCode).toBe(201);
    const back = await preview(placeId, 'helpful');
    expect(idsOf(back)).toEqual([top, next]);
    expect(back.json().reviews[0].helpfulCount).toBe(3);
  });

  it('never names a reactor in public, and shows each person only their own marks', async () => {
    const placeId = await place();
    const author = await account();
    const reviewId = await review(placeId, author.userId);
    const one = await account('Người đọc Một');
    const two = await account('Người đọc Hai');
    await mark(one.token, reviewId);

    const publicBody = (await preview(placeId, 'helpful')).body;
    for (const leak of [one.userId, one.email, one.displayName]) {
      expect(publicBody).not.toContain(leak);
    }

    const twoList = await api().inject({
      method: 'GET',
      url: `/v1/me/review-reactions?placeId=${placeId}`,
      remoteAddress: ip(),
      headers: auth(two.token),
    });
    expect(twoList.json()).toEqual({ placeId, helpful: [] });
  });

  it('exports the marks a person gave and removes them with the account', async () => {
    const placeId = await place();
    const author = await account();
    const reviewId = await review(placeId, author.userId);
    const stays = await account();
    const leaves = await account();
    await mark(stays.token, reviewId);
    await mark(leaves.token, reviewId);

    const exported = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(leaves.token),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().reviewReactions).toEqual([
      { reviewId, type: 'helpful', createdAt: expect.any(String) },
    ]);

    const deleted = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(leaves.token),
    });
    expect(deleted.statusCode).toBe(200);

    const left = await db
      .select()
      .from(schema.reviewReactions)
      .where(
        and(
          eq(schema.reviewReactions.reviewId, reviewId),
          eq(schema.reviewReactions.userId, leaves.userId),
        ),
      );
    expect(left).toHaveLength(0);
    expect((await preview(placeId)).json().reviews[0].helpfulCount).toBe(1);
  });
});
