import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { desc, eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * PROF-BE-002 (#532), ADR-0022 — the profile's read and write path: null
 * clears, omitted keeps, every value validated against the tables it points
 * at, guests kept out, values kept out of the audit log.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let roomCode: string;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.40.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(email: string, displayName = email.split('@')[0]!) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName },
  });
  const b = res.json();
  return { token: b.accessToken as string, userId: b.userId as string };
}

function patchMe(token: string, payload: unknown) {
  return api().inject({
    method: 'PATCH',
    url: '/v1/me',
    remoteAddress: ip(),
    headers: auth(token),
    payload: payload as Record<string, unknown>,
  });
}

function getMe(token: string) {
  return api().inject({ method: 'GET', url: '/v1/me', remoteAddress: ip(), headers: auth(token) });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_profile_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  await db.insert(schema.serviceAreas).values([
    {
      key: 'hcm_q1',
      name: 'Quận 1',
      city: 'TP.HCM',
      centerLat: 10.7769,
      centerLng: 106.7009,
      radiusM: 5000,
    },
    {
      key: 'hcm_retired',
      name: 'Khu đã đóng',
      city: 'TP.HCM',
      centerLat: 10.8,
      centerLng: 106.7,
      radiusM: 5000,
      isActive: false,
    },
  ]);
  await db.insert(schema.taxonomies).values([
    { kind: 'mood', key: 'chill' },
    { kind: 'mood', key: 'lively' },
    { kind: 'category', key: 'food' },
  ]);

  const [host] = await db
    .insert(schema.users)
    .values({ displayName: 'Host', email: 'host-profile@gogo.id.vn' })
    .returning();
  const [room] = await db
    .insert(schema.rooms)
    .values({
      code: 'PROFILEROOM1',
      type: 'group',
      status: 'collecting',
      decisionMode: 'vote',
      hostUserId: host!.id,
      participantCount: 4,
    })
    .returning();
  roomCode = room!.code;

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('profile read and write (PROF-BE-002)', () => {
  it('a new account has an empty profile and knows whether avatars can be uploaded', async () => {
    const { token, userId } = await register('fresh@gogo.id.vn', 'Người Mới');
    const res = await getMe(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      actorType: 'user',
      id: userId,
      displayName: 'Người Mới',
      email: 'fresh@gogo.id.vn',
      locale: 'vi',
      avatarUrl: null,
      homeArea: null,
      interests: { mood: [] },
      usualBudget: null,
      // The test fake stands in for storage, so uploads are available here.
      capabilities: { avatarUpload: 'available' },
    });
  });

  it('sets every optional field and resolves the area label from the curated table', async () => {
    const { token } = await register('full@gogo.id.vn');
    const res = await patchMe(token, {
      displayName: 'Tên Mới',
      homeAreaKey: 'hcm_q1',
      interests: { mood: ['chill', 'lively'] },
      usualBudget: { perPerson: 300_000, currency: 'VND' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      displayName: 'Tên Mới',
      homeArea: { key: 'hcm_q1', name: 'Quận 1', city: 'TP.HCM' },
      interests: { mood: ['chill', 'lively'] },
      usualBudget: { perPerson: 300_000, currency: 'VND' },
    });
    // The read path composes the same row the write path returned.
    expect((await getMe(token)).json()).toEqual(res.json());
  });

  it('null clears a field and an omitted field is kept', async () => {
    const { token, userId } = await register('clear@gogo.id.vn');
    await patchMe(token, {
      homeAreaKey: 'hcm_q1',
      interests: { mood: ['chill'] },
      usualBudget: { perPerson: 500_000, currency: 'VND' },
    });

    const areaGone = await patchMe(token, { homeAreaKey: null });
    expect(areaGone.statusCode).toBe(200);
    expect(areaGone.json().homeArea).toBeNull();
    expect(areaGone.json().interests).toEqual({ mood: ['chill'] });
    expect(areaGone.json().usualBudget).toEqual({ perPerson: 500_000, currency: 'VND' });

    const rest = await patchMe(token, { interests: null, usualBudget: null });
    expect(rest.json().interests).toEqual({ mood: [] });
    expect(rest.json().usualBudget).toBeNull();
    expect(rest.json().displayName).toBe('clear');

    // An empty interests row is not kept as an empty object; it is gone.
    const rows = await db
      .select()
      .from(schema.userProfilePreferences)
      .where(eq(schema.userProfilePreferences.userId, userId));
    expect(rows).toHaveLength(0);

    // An empty patch changes nothing and still answers the profile.
    const noop = await patchMe(token, {});
    expect(noop.statusCode).toBe(200);
    expect(noop.json().displayName).toBe('clear');
  });

  it('refuses what it cannot store, field by field', async () => {
    const { token } = await register('strict@gogo.id.vn');

    const cases: { payload: unknown; code?: string; field?: string }[] = [
      { payload: { displayName: null } },
      { payload: { displayName: '' } },
      { payload: { locale: 'fr' } },
      { payload: { homeAreaKey: 'nope' }, code: 'INVALID_AREA_KEY', field: 'homeAreaKey' },
      { payload: { homeAreaKey: 'hcm_retired' }, code: 'INVALID_AREA_KEY', field: 'homeAreaKey' },
      {
        payload: { interests: { mood: ['nope'] } },
        code: 'INVALID_TAXONOMY_KEYS',
        field: 'selections.mood',
      },
      // A kind the profile does not model is refused by the DTO, not dropped.
      { payload: { interests: { category: ['food'] } } },
      { payload: { interests: { mood: ['chill'], category: ['food'] } } },
      { payload: { usualBudget: { perPerson: -1, currency: 'VND' } } },
      { payload: { usualBudget: { perPerson: 1000.5, currency: 'VND' } } },
      { payload: { usualBudget: { perPerson: 1000, currency: 'vnd' } } },
      { payload: { usualBudget: { perPerson: 1000 } } },
      { payload: { email: 'new@gogo.id.vn' } },
      { payload: { avatarUrl: 'https://evil.example/x.png' } },
    ];
    for (const c of cases) {
      const res = await patchMe(token, c.payload);
      expect(res.statusCode, JSON.stringify(c.payload)).toBe(400);
      if (c.code) expect(res.json().code).toBe(c.code);
      if (c.field) expect(res.json().field_errors[0].field).toBe(c.field);
    }

    // Nothing above touched the row.
    expect((await getMe(token)).json()).toMatchObject({
      displayName: 'strict',
      homeArea: null,
      interests: { mood: [] },
      usualBudget: null,
    });
  });

  it('guests keep their session facts and cannot patch a profile', async () => {
    const join = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode, displayName: 'Khách Vui' },
    });
    expect(join.statusCode).toBe(201);
    const token = join.json().accessToken as string;

    const me = await getMe(token);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ actorType: 'guest', displayName: 'Khách Vui' });
    expect(me.json().roomId).toBeTruthy();
    expect(me.json()).not.toHaveProperty('interests');

    const patch = await patchMe(token, { displayName: 'Khách Khác' });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().code).toBe('USER_ONLY');
  });

  it('audits which fields moved, never their values', async () => {
    const { token, userId } = await register('audit@gogo.id.vn');
    await patchMe(token, {
      displayName: 'Bí Mật',
      usualBudget: { perPerson: 42, currency: 'VND' },
    });
    const [row] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, userId))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(1);
    expect(row?.action).toBe('user.profile_updated');
    expect(row?.actorType).toBe('user');
    const diff = JSON.stringify(row?.diff);
    expect(diff).toContain('displayName');
    expect(diff).toContain('usualBudget');
    expect(diff).not.toContain('Bí Mật');
    expect(diff).not.toContain('42');
  });
});

describe('avatar upload authorization (PROF-BE-003)', () => {
  async function presign(token: string, payload: Record<string, unknown>) {
    return api().inject({
      method: 'POST',
      url: '/v1/uploads',
      remoteAddress: ip(),
      headers: auth(token),
      payload,
    });
  }

  it('a user gets a private, one-day key under the avatar prefix', async () => {
    const { token, userId } = await register('avatar-presign@gogo.id.vn');
    const res = await presign(token, {
      purpose: 'avatar',
      contentType: 'image/jpeg',
      contentLength: 1024,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().key).toMatch(new RegExp(`^tmp/avatars/${userId}/[0-9a-f-]{36}\\.jpg$`));
    expect(res.json().uploadUrl).toContain('/upload/');

    const [row] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, res.json().key as string));
    expect(row).toMatchObject({
      actorType: 'user',
      actorId: userId,
      purpose: 'avatar',
      status: 'pending',
    });
  });

  it('refuses HEIC for an avatar, and says which types it takes', async () => {
    const { token } = await register('avatar-heic@gogo.id.vn');
    const res = await presign(token, {
      purpose: 'avatar',
      contentType: 'image/heic',
      contentLength: 1024,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNSUPPORTED_CONTENT_TYPE');
    expect(res.json().field_errors[0].message).toBe('allowed: image/jpeg, image/png, image/webp');

    // The check-in purpose still takes HEIC: the rule is per purpose.
    const checkin = await presign(token, {
      purpose: 'checkin_photo',
      contentType: 'image/heic',
      contentLength: 1024,
    });
    expect(checkin.statusCode).toBe(201);
    expect(checkin.json().key).toMatch(/^u\/user\//);
  });

  it('a guest cannot presign an avatar', async () => {
    const join = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode, displayName: 'Khách Ảnh' },
    });
    const res = await presign(join.json().accessToken as string, {
      purpose: 'avatar',
      contentType: 'image/jpeg',
      contentLength: 1024,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('USER_ONLY');
  });
});
