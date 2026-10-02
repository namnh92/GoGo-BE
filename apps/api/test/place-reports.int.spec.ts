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
 * BE-BFF-P2 (#218) — `POST /v1/places/{id}/reports`, over real HTTP.
 *
 * What these cases hold: an account or a room guest can report a place they
 * can open, the reason is a stable key from a closed server-side set, the row
 * lands in the moderation queue the CMS already reads (`/cms/moderation/
 * reports`), a repeated open report is the same report, a place nobody can
 * open is indistinguishable from a missing one, anonymous callers and CMS
 * admins cannot file, and the endpoint is rate-limited per actor.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.72.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let moderator = '';
let guest = '';
let seq = 0;

async function place(status: 'published' | 'draft' | 'community_submitted' = 'published') {
  seq += 1;
  const [row] = await db
    .insert(schema.places)
    .values({
      name: `Quán báo sai ${seq}`,
      nameNormalized: 'set-by-trigger',
      status,
      geom: { x: 106.7 + seq / 1000, y: 10.77 },
      confidence: '0.9',
    })
    .returning();
  return row!.id;
}

async function account() {
  seq += 1;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: {
      email: `report-${seq}@gogo.id.vn`,
      password: 'sufficiently-long-pw',
      displayName: 'Người báo',
    },
  });
  const body = res.json();
  expect(body.accessToken).toBeTruthy();
  return { token: body.accessToken as string, userId: body.userId as string };
}

const report = (token: string | null, placeId: string, payload: unknown) =>
  api().inject({
    method: 'POST',
    url: `/v1/places/${placeId}/reports`,
    remoteAddress: ip(),
    headers: token ? auth(token) : {},
    payload: payload as Record<string, unknown>,
  });

async function rowsFor(placeId: string) {
  return db.select().from(schema.reports).where(eq(schema.reports.targetId, placeId));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_reports_test')
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

  const email = 'reports-moderator@gogo.local';
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
    .values({ displayName: 'Host', email: 'report-host@gogo.id.vn' })
    .returning();
  await db.insert(schema.rooms).values({
    code: 'REPORTRM7',
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
    payload: { roomCode: 'REPORTRM7', displayName: 'Khách' },
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
  await db.execute(sql`truncate table reports`);
  await db.execute(sql`truncate table places cascade`);
});

describe('reporting wrong place information (#218)', () => {
  it('files an open report from an account and answers facts, not copy', async () => {
    const placeId = await place();
    const reader = await account();

    const res = await report(reader.token, placeId, {
      reasonCode: 'wrong_hours',
      note: '  Quán đóng cửa lúc 21h, không phải 23h  ',
    });
    // The note goes to the moderator, not back over the wire.
    expect(res.body).not.toContain('21h');

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      id: expect.any(String),
      placeId,
      reasonCode: 'wrong_hours',
      status: 'open',
      createdAt: expect.any(String),
    });
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);

    const rows = await rowsFor(placeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      targetType: 'place',
      reasonCode: 'wrong_hours',
      note: 'Quán đóng cửa lúc 21h, không phải 23h',
      status: 'open',
      reporterUserId: reader.userId,
      reporterGuestSessionId: null,
    });
  });

  it('lands in the CMS moderation queue the console already reads', async () => {
    const placeId = await place();
    const reader = await account();
    const filed = await report(reader.token, placeId, { reasonCode: 'permanently_closed' });
    expect(filed.statusCode).toBe(201);

    const queue = await api().inject({
      method: 'GET',
      url: `/v1/cms/moderation/reports?targetType=place&targetId=${placeId}`,
      remoteAddress: ip(),
      headers: auth(moderator),
    });
    expect(queue.statusCode).toBe(200);
    const items = queue.json().items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: filed.json().id,
      status: 'open',
      targetType: 'place',
      targetId: placeId,
      reasonCode: 'permanently_closed',
      reporterKind: 'user',
      reporterUserId: reader.userId,
    });
  });

  it('lets a room guest report, recorded as a guest without exposing the session', async () => {
    const placeId = await place();
    const res = await report(guest, placeId, { reasonCode: 'wrong_location' });
    expect(res.statusCode).toBe(201);

    const [row] = await rowsFor(placeId);
    expect(row!.reporterUserId).toBeNull();
    expect(row!.reporterGuestSessionId).toEqual(expect.any(String));

    const queue = await api().inject({
      method: 'GET',
      url: `/v1/cms/moderation/reports?targetType=place&targetId=${placeId}`,
      remoteAddress: ip(),
      headers: auth(moderator),
    });
    const [item] = queue.json().items as Record<string, unknown>[];
    expect(item).toMatchObject({ reporterKind: 'guest' });
    expect(JSON.stringify(item)).not.toContain(row!.reporterGuestSessionId!);
  });

  it('treats a repeated open report of the same reason as the same report', async () => {
    const placeId = await place();
    const reader = await account();

    const first = await report(reader.token, placeId, { reasonCode: 'wrong_price' });
    const again = await report(reader.token, placeId, { reasonCode: 'wrong_price', note: 'x' });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect(await rowsFor(placeId)).toHaveLength(1);

    // A different reason is a different fact, and is its own report.
    const other = await report(reader.token, placeId, { reasonCode: 'wrong_hours' });
    expect(other.statusCode).toBe(201);
    expect(await rowsFor(placeId)).toHaveLength(2);
  });

  it('files a new report once the earlier one has been decided', async () => {
    const placeId = await place();
    const reader = await account();
    const first = await report(reader.token, placeId, { reasonCode: 'other' });
    await db
      .update(schema.reports)
      .set({ status: 'dismissed', decidedAt: new Date() })
      .where(eq(schema.reports.id, first.json().id));

    const again = await report(reader.token, placeId, { reasonCode: 'other' });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(first.json().id);
  });

  it('accepts a community-submitted place, which Place Detail opens', async () => {
    const placeId = await place('community_submitted');
    const reader = await account();
    expect((await report(reader.token, placeId, { reasonCode: 'other' })).statusCode).toBe(201);
  });

  it('answers 404 for a place nobody can open, exactly like a missing one', async () => {
    const reader = await account();
    const draft = await place('draft');
    const hidden = await report(reader.token, draft, { reasonCode: 'other' });
    const missing = await report(reader.token, '00000000-0000-4000-8000-000000000000', {
      reasonCode: 'other',
    });
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.json().code).toBe('PLACE_NOT_FOUND');
    expect(missing.json().code).toBe('PLACE_NOT_FOUND');
    expect(await rowsFor(draft)).toHaveLength(0);
  });

  it('refuses a reason outside the stable key set, and an oversized note', async () => {
    const placeId = await place();
    const reader = await account();

    const unknownReason = await report(reader.token, placeId, { reasonCode: 'Sai giờ mở cửa' });
    const missingReason = await report(reader.token, placeId, { note: 'không có lý do' });
    const longNote = await report(reader.token, placeId, {
      reasonCode: 'other',
      note: 'a'.repeat(501),
    });
    for (const res of [unknownReason, missingReason, longNote]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    }
    expect(await rowsFor(placeId)).toHaveLength(0);
  });

  it('stores a blank note as no note', async () => {
    const placeId = await place();
    const reader = await account();
    expect(
      (await report(reader.token, placeId, { reasonCode: 'other', note: '   ' })).statusCode,
    ).toBe(201);
    const [row] = await rowsFor(placeId);
    expect(row!.note).toBeNull();
  });

  it('requires a signed-in actor, and refuses CMS admin tokens', async () => {
    const placeId = await place();
    const anonymous = await report(null, placeId, { reasonCode: 'other' });
    expect(anonymous.statusCode).toBe(401);

    const admin = await report(moderator, placeId, { reasonCode: 'other' });
    expect(admin.statusCode).toBe(403);
    expect(admin.json().code).toBe('REPORTER_NOT_ALLOWED');
    expect(await rowsFor(placeId)).toHaveLength(0);
  });

  it('is rate-limited per actor, not per place', async () => {
    const reader = await account();
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      // A different place each time, so dedupe cannot be what stops it.
      const placeId = await place();
      codes.push((await report(reader.token, placeId, { reasonCode: 'other' })).statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(codes[5]).toBe(429);

    // Another person's budget is untouched.
    const other = await account();
    expect((await report(other.token, await place(), { reasonCode: 'other' })).statusCode).toBe(
      201,
    );
  });
});
