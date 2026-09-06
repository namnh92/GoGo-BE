import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * LNK-BE-002 (#205) — FR-LINK-001/002/005 acceptance.
 *
 * The public URL carries a random slug and nothing else; resolve answers type
 * and id only; a revoked link — and, for a room invite, the code it doubles as
 * — stops working immediately.
 */

const SHARE_HOST = 'https://go-test.gogo.id.vn';
const TENJIN_TEMPLATE = 'https://track.tenjin.com/v0/click/TeStTeMpLaTe?campaign_id=gogo_test';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
/** Every line the API logger wrote during this file — what a log reader would see. */
const logLines: string[] = [];
const logSink = new Writable({
  write(chunk, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
/** Every slug minted here, so the log assertion at the end can name them all. */
const mintedSlugs: string[] = [];

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.40.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: email.split('@')[0] },
  });
  expect(res.statusCode).toBe(201);
  const b = res.json();
  return { token: b.accessToken as string, userId: b.userId as string };
}

async function roomHostedBy(userId: string, status: 'collecting' | 'ready' = 'collecting') {
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: `SL${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      type: 'group',
      decisionMode: 'vote',
      participantCount: 4,
      hostUserId: userId,
      status,
    })
    .returning();
  await db
    .insert(schema.roomMembers)
    .values({ roomId: room!.id, userId, role: 'host', displayName: 'Host' });
  return room!;
}

async function mint(token: string, payload: Record<string, unknown>) {
  return api().inject({
    method: 'POST',
    url: '/v1/share-links',
    remoteAddress: ip(),
    headers: auth(token),
    payload,
  });
}

function slugOf(url: string): string {
  const match = new RegExp(`^${SHARE_HOST}/l/([A-Za-z0-9_-]{22})$`).exec(url);
  expect(match, `canonical URL shape: ${url}`).not.toBeNull();
  mintedSlugs.push(match![1]!);
  return match![1]!;
}

async function resolve(slug: string) {
  return api().inject({ method: 'GET', url: `/v1/share-links/${slug}`, remoteAddress: ip() });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_links_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  process.env.SHARE_LINK_BASE_URL = SHARE_HOST;
  // #206: a template shaped like Tenjin's; string building only, nothing is
  // called, and every minted link must carry it with the canonical URL as
  // deferred target.
  process.env.TENJIN_TRACKING_URL_TEMPLATE = TENJIN_TEMPLATE;

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp({ logDestination: logSink });
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('ROOM_INVITE share link — the slug is the invite code', () => {
  it('host mints a canonical URL; the slug resolves to itself as invite code and joins the room', async () => {
    const host = await register('link-host@gogo.id.vn');
    const room = await roomHostedBy(host.userId);

    const created = await mint(host.token, {
      type: 'ROOM_INVITE',
      entityId: room.id,
      source: 'room_share',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; url: string; type: string; expiresAt: string };
    const slug = slugOf(body.url);
    expect(body.type).toBe('ROOM_INVITE');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // FR-LINK-001: nothing but the slug in the URL.
    expect(body.url).not.toContain(room.id);
    expect(body.url).not.toContain(host.userId);

    // Stored hashed — the row never carries the slug (it is the invite code).
    const [row] = await db
      .select()
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.id, body.id));
    expect(row!.slugHash).not.toBe(slug);
    expect(row!.slugHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.inviteId).not.toBeNull();
    expect(row!.targetId).toBe(room.id);

    const resolved = await resolve(slug);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      type: 'ROOM_INVITE',
      target: { inviteCode: slug },
      provider: 'TENJIN',
      source: 'room_share',
    });
    // FR-LINK-002: the room id is not part of the public answer.
    expect(JSON.stringify(resolved.json())).not.toContain(room.id);
    // #206 / FR-LINK-003/006: the vendor URL is routing, carrying the canonical
    // link as deferred target and nothing about the person or the room.
    const tracking = new URL(resolved.json().trackingUrl as string);
    expect(tracking.origin + tracking.pathname).toBe(
      'https://track.tenjin.com/v0/click/TeStTeMpLaTe',
    );
    expect(tracking.searchParams.get('deeplink_url')).toBe(body.url);
    expect(tracking.searchParams.get('campaign_id')).toBe('gogo_test');
    expect(resolved.json().trackingUrl).not.toContain(room.id);
    expect(resolved.json().trackingUrl).not.toContain(host.userId);
    expect(resolved.json().trackingUrl).not.toContain(host.token);
    // The shared URL is still the canonical one, never the vendor's.
    expect(body.url.startsWith(SHARE_HOST)).toBe(true);

    // The same door a typed invite code goes through.
    const joiner = await register('link-joiner@gogo.id.vn');
    const joined = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(joiner.token),
      payload: { inviteCode: slug },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().roomId).toBe(room.id);
  });

  it('only the host may mint an invite link; guests and non-members are refused', async () => {
    const host = await register('link-host2@gogo.id.vn');
    const room = await roomHostedBy(host.userId);
    const stranger = await register('link-stranger@gogo.id.vn');
    const refused = await mint(stranger.token, { type: 'ROOM_INVITE', entityId: room.id });
    expect(refused.statusCode).toBe(403);

    const guest = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: room.code, displayName: 'Khách' },
    });
    expect(guest.statusCode).toBe(201);
    const guestRefused = await mint(guest.json().accessToken as string, {
      type: 'PLACE',
      entityId: room.id,
    });
    expect(guestRefused.statusCode).toBe(403);
    expect(guestRefused.json().code).toBe('USER_ONLY');
  });

  it('revoking the link revokes the invite with it: 410 on resolve, join refused', async () => {
    const host = await register('link-revoke@gogo.id.vn');
    const room = await roomHostedBy(host.userId);
    const created = await mint(host.token, { type: 'ROOM_INVITE', entityId: room.id });
    const slug = slugOf(created.json().url as string);

    const revoked = await api().inject({
      method: 'DELETE',
      url: `/v1/share-links/${slug}`,
      remoteAddress: ip(),
      headers: auth(host.token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: true });

    const gone = await resolve(slug);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe('SHARE_LINK_GONE');

    const late = await register('link-late@gogo.id.vn');
    const join = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join',
      remoteAddress: ip(),
      headers: auth(late.token),
      payload: { inviteCode: slug },
    });
    expect(join.statusCode).toBe(410);

    // Idempotent, and a stranger cannot revoke what is not theirs.
    const again = await api().inject({
      method: 'DELETE',
      url: `/v1/share-links/${slug}`,
      remoteAddress: ip(),
      headers: auth(host.token),
    });
    expect(again.statusCode).toBe(200);
    const other = await mint(host.token, { type: 'ROOM_INVITE', entityId: room.id });
    const otherSlug = slugOf(other.json().url as string);
    const stranger = await register('link-nobody@gogo.id.vn');
    const forbidden = await api().inject({
      method: 'DELETE',
      url: `/v1/share-links/${otherSlug}`,
      remoteAddress: ip(),
      headers: auth(stranger.token),
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await resolve(otherSlug)).statusCode).toBe(200);
  });
});

describe('PLAN and PLACE share links', () => {
  it('a member mints a plan link that resolves to the plan id only', async () => {
    const host = await register('plan-host@gogo.id.vn');
    const room = await roomHostedBy(host.userId, 'ready');
    const [plan] = await db
      .insert(schema.plans)
      .values({
        roomId: room.id,
        version: 1,
        constraintVersion: 1,
        totals: {
          costMin: 0,
          costMax: 0,
          currency: 'VND',
          durationMinutes: 60,
          travelDistanceM: 0,
          overBudget: false,
          uncertain: false,
        },
      })
      .returning();

    const created = await mint(host.token, { type: 'PLAN', entityId: plan!.id });
    expect(created.statusCode).toBe(201);
    expect(created.json().expiresAt).toBeNull();
    const slug = slugOf(created.json().url as string);
    const resolved = await resolve(slug);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().type).toBe('PLAN');
    expect(resolved.json().target).toEqual({ planId: plan!.id });
    expect(JSON.stringify(resolved.json())).not.toContain(room.id);

    const stranger = await register('plan-stranger@gogo.id.vn');
    expect((await mint(stranger.token, { type: 'PLAN', entityId: plan!.id })).statusCode).toBe(403);
    expect(
      (await mint(host.token, { type: 'PLAN', entityId: '00000000-0000-4000-8000-000000000001' }))
        .statusCode,
    ).toBe(404);
  });

  it('any signed-in user shares a published place; drafts and unknown ids are not found', async () => {
    const user = await register('place-sharer@gogo.id.vn');
    const [published, draft] = await db
      .insert(schema.places)
      .values([
        {
          name: 'Quán Chia Sẻ',
          nameNormalized: 'x',
          geom: { x: 106.7, y: 10.77 },
          status: 'published',
        },
        { name: 'Nháp', nameNormalized: 'x', geom: { x: 106.71, y: 10.78 }, status: 'draft' },
      ])
      .returning({ id: schema.places.id });

    const created = await mint(user.token, { type: 'PLACE', entityId: published!.id });
    expect(created.statusCode).toBe(201);
    const slug = slugOf(created.json().url as string);
    expect((await resolve(slug)).json().target).toEqual({ placeId: published!.id });
    expect((await mint(user.token, { type: 'PLACE', entityId: draft!.id })).statusCode).toBe(404);
  });

  it('reserved types are refused, unknown slugs are 404, malformed slugs are 400', async () => {
    const user = await register('reserved@gogo.id.vn');
    const reserved = await mint(user.token, {
      type: 'REFERRAL',
      entityId: '00000000-0000-4000-8000-000000000002',
    });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().code).toBe('SHARE_LINK_TYPE_UNSUPPORTED');
    expect((await resolve('Af82XcAf82XcAf82XcAf82')).statusCode).toBe(404);
    expect((await resolve('bad!')).statusCode).toBe(400);
    const unauthenticated = await api().inject({
      method: 'POST',
      url: '/v1/share-links',
      remoteAddress: ip(),
      payload: { type: 'PLACE', entityId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});

describe('request logs (review finding 2)', () => {
  it('never wrote a slug — resolve, revoke, 404, 410 and 400 paths alike', async () => {
    // One more of each failure shape, so the assertion covers them explicitly.
    expect((await resolve('Af82XcAf82XcAf82XcAf82')).statusCode).toBe(404);
    expect((await resolve('bad!')).statusCode).toBe(400);
    expect(mintedSlugs.length).toBeGreaterThanOrEqual(4);

    const out = logLines.join('');
    expect(out).toContain('"url":"/v1/share-links/[redacted]"');
    // The request logger did run for these routes; the slug is what is missing.
    expect(out).toContain('incoming request');
    for (const slug of mintedSlugs) expect(out).not.toContain(slug);
    expect(out).not.toContain('Af82XcAf82XcAf82XcAf82');
  });
});
