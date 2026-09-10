import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { desc, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { MediaCleanupService } from '@gogo/modules';
import {
  CACHE_PURGE,
  PUBLIC_STORAGE_PROVIDER,
  STORAGE_PROVIDER,
  type FakeCachePurge,
  type FakeStorage,
} from '@gogo/providers';
import sharp from 'sharp';

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
  // ADR-0022: a public base is what turns a stored key into a URL.
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://assets-test.local';

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

describe('avatar pipeline (PROF-BE-004, ADR-0022)', () => {
  const PUBLIC_URL = /^https:\/\/assets-test\.local\/avatars\/[0-9a-f]{32}\.webp$/;
  const privateStore = () => app.get<FakeStorage>(STORAGE_PROVIDER);
  const publicStore = () => app.get<FakeStorage>(PUBLIC_STORAGE_PROVIDER);
  const purge = () => app.get<FakeCachePurge>(CACHE_PURGE);
  const cleanup = () => app.get(MediaCleanupService);

  /** A real JPEG with EXIF metadata and a landscape shape, as a phone would send. */
  async function photo(): Promise<Uint8Array> {
    const out = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'EXIF must not survive' } } })
      .toBuffer();
    return new Uint8Array(out);
  }

  /** Presign, then stand in for the phone's PUT by seeding the private fake. */
  async function upload(
    token: string,
    bytes: Uint8Array | null,
    contentType = 'image/jpeg',
  ): Promise<string> {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/uploads',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { purpose: 'avatar', contentType, contentLength: bytes?.byteLength ?? 1024 },
    });
    expect(res.statusCode).toBe(201);
    const key = res.json().key as string;
    if (bytes) privateStore().seed(key, bytes, contentType);
    return key;
  }

  function putAvatar(token: string, uploadKey: string) {
    return api().inject({
      method: 'PUT',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { uploadKey },
    });
  }

  async function openQueueRows(objectKey: string) {
    return db
      .select()
      .from(schema.mediaCleanupQueue)
      .where(eq(schema.mediaCleanupQueue.objectKey, objectKey));
  }

  it('turns an upload into a public 512×512 WebP with no metadata, and answers its URL', async () => {
    const { token, userId } = await register('avatar-ok@gogo.id.vn');
    const key = await upload(token, await photo());

    const res = await putAvatar(token, key);
    expect(res.statusCode).toBe(200);
    const url = res.json().avatarUrl as string;
    expect(url).toMatch(PUBLIC_URL);
    expect((await getMe(token)).json().avatarUrl).toBe(url);

    const publicKey = url.replace('https://assets-test.local/', '');
    const stored = publicStore().objects.get(publicKey);
    expect(stored?.contentType).toBe('image/webp');
    expect(stored?.cacheControl).toBe('public, max-age=86400');
    const meta = await sharp(stored!.body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 512]);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();

    // The original was ours once the key was attached, and it is gone now.
    expect(privateStore().deleted).toContain(key);
    expect(privateStore().objects.has(key)).toBe(false);
    expect(await openQueueRows(key)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, key));
    expect(row).toMatchObject({ status: 'attached', attachedToType: 'user', attachedToId: userId });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.avatarKey).toBe(publicKey);
  });

  it('replacing schedules the old object away and purges its URL; removing does the same', async () => {
    const { token, userId } = await register('avatar-replace@gogo.id.vn');
    const first = (await putAvatar(token, await upload(token, await photo()))).json()
      .avatarUrl as string;
    const second = (await putAvatar(token, await upload(token, await photo()))).json()
      .avatarUrl as string;
    expect(second).toMatch(PUBLIC_URL);
    expect(second).not.toBe(first);

    const firstKey = first.replace('https://assets-test.local/', '');
    expect(publicStore().deleted).toContain(firstKey);
    expect(purge().purged).toContain(first);
    expect(await openQueueRows(firstKey)).toHaveLength(0);

    const removed = await api().inject({
      method: 'DELETE',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().avatarUrl).toBeNull();
    const secondKey = second.replace('https://assets-test.local/', '');
    expect(publicStore().deleted).toContain(secondKey);
    expect(purge().purged).toContain(second);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.avatarKey).toBeNull();

    // Removing again is not an error and enqueues nothing.
    const again = await api().inject({
      method: 'DELETE',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().avatarUrl).toBeNull();
  });

  it('refuses bytes it cannot read and schedules the original away with a grace period', async () => {
    const { token } = await register('avatar-garbage@gogo.id.vn');
    const key = await upload(token, new Uint8Array(4096).fill(7), 'image/png');
    const res = await putAvatar(token, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('AVATAR_UNPROCESSABLE');
    expect((await getMe(token)).json().avatarUrl).toBeNull();

    // Not deleted yet — a retry with the same key must still find the bytes —
    // but scheduled, so an abandoned original does not wait for the lifecycle.
    const rows = await openQueueRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('avatar_failed_original');
    expect(rows[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
    expect(privateStore().objects.has(key)).toBe(true);
  });

  it('refuses a declared type the bytes do not decode as', async () => {
    const { token } = await register('avatar-mismatch@gogo.id.vn');
    const png = new Uint8Array(
      await sharp({ create: { width: 10, height: 10, channels: 3, background: '#0f0' } })
        .png()
        .toBuffer(),
    );
    const key = await upload(token, png, 'image/jpeg');
    const res = await putAvatar(token, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('AVATAR_UNPROCESSABLE');
  });

  it('refuses a key that is not yours, and one nothing was uploaded to', async () => {
    const { token: owner } = await register('avatar-owner@gogo.id.vn');
    const { token: thief } = await register('avatar-thief@gogo.id.vn');
    const key = await upload(owner, await photo());

    const stolen = await putAvatar(thief, key);
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().code).toBe('INVALID_UPLOAD_KEY');
    // Nothing of the owner's was touched by the attempt.
    expect(privateStore().objects.has(key)).toBe(true);
    expect(await openQueueRows(key)).toHaveLength(0);

    const empty = await upload(owner, null);
    const missing = await putAvatar(owner, empty);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('AVATAR_UPLOAD_MISSING');
    expect(await openQueueRows(empty)).toHaveLength(0);
  });

  it('a public write failure is retryable and leaves nothing dangling', async () => {
    const { token } = await register('avatar-outage@gogo.id.vn');
    const key = await upload(token, await photo());
    publicStore().failWrites = true;
    try {
      const res = await putAvatar(token, key);
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('AVATAR_STORAGE_UNAVAILABLE');
      expect(res.json().retryable).toBe(true);
    } finally {
      publicStore().failWrites = false;
    }
    expect((await getMe(token)).json().avatarUrl).toBeNull();
    expect((await openQueueRows(key)).map((r) => r.reason)).toEqual(['avatar_failed_original']);

    // The same key retried once storage is back: the grace period kept the bytes.
    const retry = await putAvatar(token, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().avatarUrl).toMatch(PUBLIC_URL);
  });

  it('a cleanup the edge refuses is retried by the worker path, not forgotten', async () => {
    const { token } = await register('avatar-purge@gogo.id.vn');
    const first = (await putAvatar(token, await upload(token, await photo()))).json()
      .avatarUrl as string;
    const firstKey = first.replace('https://assets-test.local/', '');

    purge().failPurges = true;
    try {
      await putAvatar(token, await upload(token, await photo()));
    } finally {
      purge().failPurges = false;
    }
    const [pending] = await openQueueRows(firstKey);
    expect(pending).toMatchObject({ bucket: 'public', attempts: 1 });
    expect(pending!.failedAt).toBeNull();
    expect(pending!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // The worker's tick, with the row made due.
    await db
      .update(schema.mediaCleanupQueue)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(schema.mediaCleanupQueue.id, pending!.id));
    const report = await cleanup().runDue();
    expect(report).toMatchObject({ attempted: 1, done: 1, retried: 0, deadLettered: 0 });
    expect(await openQueueRows(firstKey)).toHaveLength(0);
    expect(purge().purged).toContain(first);
  });

  it('a guest cannot set or remove an avatar', async () => {
    const join = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode, displayName: 'Khách Ảnh 2' },
    });
    const token = join.json().accessToken as string;
    expect((await putAvatar(token, 'tmp/avatars/x/y.jpg')).statusCode).toBe(403);
    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(del.statusCode).toBe(403);
  });
});
