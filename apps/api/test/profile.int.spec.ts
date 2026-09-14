import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  MediaCleanupService,
  PrivacyJobs,
} from '@gogo/modules';
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
      homeAdministrativeArea: null,
      interests: { mood: [] },
      usualBudget: null,
      dateOfBirth: null,
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

describe('what co-members see, and the curated areas (PROF-BE-005)', () => {
  it('a co-member sees the avatar URL and nothing else from the profile', async () => {
    const { token: hostToken, userId: hostId } = await register('members-host@gogo.id.vn');
    const { token: memberToken, userId: memberId } = await register(
      'members-with-avatar@gogo.id.vn',
    );
    await api().inject({
      method: 'PATCH',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { homeAreaKey: 'hcm_q1', usualBudget: { perPerson: 1, currency: 'VND' } },
    });
    const privateStore = app.get<FakeStorage>(STORAGE_PROVIDER);
    const presign = await api().inject({
      method: 'POST',
      url: '/v1/uploads',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { purpose: 'avatar', contentType: 'image/png', contentLength: 100 },
    });
    const key = presign.json().key as string;
    privateStore.seed(
      key,
      new Uint8Array(
        await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00f' } })
          .png()
          .toBuffer(),
      ),
      'image/png',
    );
    const set = await api().inject({
      method: 'PUT',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { uploadKey: key },
    });
    expect(set.statusCode).toBe(200);
    const avatarUrl = set.json().avatarUrl as string;

    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: 'MEMBERSROOM1',
        type: 'group',
        status: 'collecting',
        decisionMode: 'vote',
        hostUserId: hostId,
        participantCount: 3,
      })
      .returning();
    await db.insert(schema.roomMembers).values([
      { roomId: room!.id, userId: hostId, role: 'host', displayName: 'members-host' },
      { roomId: room!.id, userId: memberId, role: 'member', displayName: 'members-with-avatar' },
    ]);
    const guest = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: room!.code, displayName: 'Khách Thành Viên' },
    });
    expect(guest.statusCode).toBe(201);

    const res = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room!.id}/members`,
      remoteAddress: ip(),
      headers: auth(hostToken),
    });
    expect(res.statusCode).toBe(200);
    const members = res.json() as Record<string, unknown>[];
    const byName = Object.fromEntries(members.map((m) => [m.displayName as string, m]));
    expect(byName['members-with-avatar']).toMatchObject({ avatarUrl, isGuest: false });
    expect(byName['members-host']).toMatchObject({ avatarUrl: null });
    expect(byName['Khách Thành Viên']).toMatchObject({ avatarUrl: null, isGuest: true });
    for (const m of members) {
      expect(Object.keys(m).sort()).toEqual(
        ['avatarUrl', 'displayName', 'id', 'isGuest', 'joinedAt', 'role', 'selectionStatus'].sort(),
      );
    }
  });

  /**
   * GoGo-BE#552 — found by a real device, not by a test. The room screen reads
   * `members` from `GET /rooms/{id}`, never from `/members`, so an avatar the
   * members endpoint returned correctly still rendered as initials.
   */
  it('carries the same avatar on the room summary the screen actually reads', async () => {
    const { token: hostToken, userId: hostId } = await register('summary-host@gogo.id.vn');
    const { token: memberToken, userId: memberId } = await register('summary-member@gogo.id.vn');
    const privateStore = app.get<FakeStorage>(STORAGE_PROVIDER);
    const presign = await api().inject({
      method: 'POST',
      url: '/v1/uploads',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { purpose: 'avatar', contentType: 'image/png', contentLength: 100 },
    });
    const key = presign.json().key as string;
    privateStore.seed(
      key,
      new Uint8Array(
        await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0f0' } })
          .png()
          .toBuffer(),
      ),
      'image/png',
    );
    const set = await api().inject({
      method: 'PUT',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(memberToken),
      payload: { uploadKey: key },
    });
    expect(set.statusCode).toBe(200);
    const avatarUrl = set.json().avatarUrl as string;

    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: 'SUMMARYROOM1',
        type: 'group',
        status: 'collecting',
        decisionMode: 'vote',
        hostUserId: hostId,
        participantCount: 3,
      })
      .returning();
    await db.insert(schema.roomMembers).values([
      { roomId: room!.id, userId: hostId, role: 'host', displayName: 'summary-host' },
      { roomId: room!.id, userId: memberId, role: 'member', displayName: 'summary-with-avatar' },
    ]);

    const res = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room!.id}`,
      remoteAddress: ip(),
      headers: auth(hostToken),
    });
    expect(res.statusCode).toBe(200);
    const members = res.json().members as Record<string, unknown>[];
    const byName = Object.fromEntries(members.map((m) => [m.displayName as string, m]));
    expect(byName['summary-with-avatar']).toMatchObject({ avatarUrl });
    expect(byName['summary-host']).toMatchObject({ avatarUrl: null });

    // The two endpoints agree; the screen may read either.
    const list = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room!.id}/members`,
      remoteAddress: ip(),
      headers: auth(hostToken),
    });
    const listed = Object.fromEntries(
      (list.json() as Record<string, unknown>[]).map((m) => [m.displayName as string, m.avatarUrl]),
    );
    expect(listed['summary-with-avatar']).toBe(avatarUrl);
  });

  it('lists the active service areas, in order, publicly and cacheably', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/service-areas',
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const keys = (res.json().areas as { key: string; name: string; city: string | null }[]).map(
      (a) => a.key,
    );
    expect(keys).toContain('hcm_q1');
    expect(keys).not.toContain('hcm_retired');
    expect(res.json().areas.find((a: { key: string }) => a.key === 'hcm_q1')).toEqual({
      key: 'hcm_q1',
      name: 'Quận 1',
      city: 'TP.HCM',
      lat: 10.7769,
      lng: 106.7009,
    });
  });
});

describe('the picture leaves with the person; stale presigns leave on schedule (PROF-BE-006)', () => {
  it('deleting the account schedules and removes the avatar in the same breath', async () => {
    const { token, userId } = await register('avatar-delete@gogo.id.vn');
    const privateStore = app.get<FakeStorage>(STORAGE_PROVIDER);
    const publicStore = app.get<FakeStorage>(PUBLIC_STORAGE_PROVIDER);
    const presign = await api().inject({
      method: 'POST',
      url: '/v1/uploads',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { purpose: 'avatar', contentType: 'image/png', contentLength: 100 },
    });
    const key = presign.json().key as string;
    privateStore.seed(
      key,
      new Uint8Array(
        await sharp({ create: { width: 32, height: 32, channels: 3, background: '#0ff' } })
          .png()
          .toBuffer(),
      ),
      'image/png',
    );
    const set = await api().inject({
      method: 'PUT',
      url: '/v1/me/avatar',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { uploadKey: key },
    });
    const publicKey = (set.json().avatarUrl as string).replace('https://assets-test.local/', '');
    expect(publicStore.objects.has(publicKey)).toBe(true);

    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    expect(del.statusCode).toBe(200);

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.status).toBe('deleted');
    expect(user!.avatarKey).toBeNull();
    expect(publicStore.deleted).toContain(publicKey);
    expect(app.get<FakeCachePurge>(CACHE_PURGE).purged).toContain(
      `https://assets-test.local/${publicKey}`,
    );
    const rows = await db
      .select()
      .from(schema.mediaCleanupQueue)
      .where(eq(schema.mediaCleanupQueue.objectKey, publicKey));
    expect(rows).toHaveLength(0);
  });

  it('the privacy job purges presign rows a day past expiry, and only those', async () => {
    const { userId } = await register('stale-presign@gogo.id.vn');
    const [stale] = await db
      .insert(schema.mediaUploads)
      .values({
        storageKey: `tmp/avatars/${userId}/stale.jpg`,
        actorType: 'user',
        actorId: userId,
        purpose: 'avatar',
        contentType: 'image/jpeg',
        contentLength: 10,
        expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.mediaUploads.id });
    const [fresh] = await db
      .insert(schema.mediaUploads)
      .values({
        storageKey: `tmp/avatars/${userId}/fresh.jpg`,
        actorType: 'user',
        actorId: userId,
        purpose: 'avatar',
        contentType: 'image/jpeg',
        contentLength: 10,
        expiresAt: new Date(Date.now() - 60 * 1000),
      })
      .returning({ id: schema.mediaUploads.id });

    const dry = await new PrivacyJobs(db).run(true);
    expect(dry.mediaUploadsPurged).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, stale!.id)),
    ).toHaveLength(1);

    const report = await new PrivacyJobs(db).run(false);
    expect(report.mediaUploadsPurged).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, stale!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, fresh!.id)),
    ).toHaveLength(1);
  });
});

describe('export and delete cover the profile (PROF-BE-007)', () => {
  it('the export carries every profile field from an allowlist and no credential of any kind', async () => {
    const { token } = await register('export-profile@gogo.id.vn', 'Người Xuất');
    await api().inject({
      method: 'PATCH',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        homeAreaKey: 'hcm_q1',
        interests: { mood: ['lively'] },
        usualBudget: { perPerson: 250_000, currency: 'VND' },
      },
    });
    const res = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile).toEqual({
      displayName: 'Người Xuất',
      email: 'export-profile@gogo.id.vn',
      locale: 'vi',
      createdAt: expect.any(String),
      avatarUrl: null,
      homeArea: { key: 'hcm_q1', name: 'Quận 1', city: 'TP.HCM' },
      homeAdministrativeArea: null,
      interests: { mood: ['lively'] },
      usualBudget: { perPerson: 250_000, currency: 'VND' },
      dateOfBirth: null,
    });

    // No key anywhere in the document may name a secret, and no value may
    // look like one: the row holds an argon2 hash and this is the document a
    // person forwards to whoever asked for it.
    const walk = (node: unknown, path: string[]): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => [
            ...(/hash|secret|token|cipher|hmac|password/i.test(k) ? [[...path, k].join('.')] : []),
            ...walk(v, [...path, k]),
          ])
        : [];
    expect(walk(res.json(), [])).toEqual([]);
    expect(JSON.stringify(res.json())).not.toMatch(/\$argon2/);
  });

  it('deletion nulls every profile column and removes the interests row', async () => {
    const { token, userId } = await register('delete-profile@gogo.id.vn');
    await api().inject({
      method: 'PATCH',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {
        homeAreaKey: 'hcm_q1',
        interests: { mood: ['chill'] },
        usualBudget: { perPerson: 99_000, currency: 'VND' },
      },
    });
    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    expect(del.statusCode).toBe(200);

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user).toMatchObject({
      status: 'deleted',
      email: null,
      passwordHash: null,
      avatarKey: null,
      homeAreaKey: null,
      usualBudgetPerPerson: null,
    });
    const prefs = await db
      .select()
      .from(schema.userProfilePreferences)
      .where(eq(schema.userProfilePreferences.userId, userId));
    expect(prefs).toHaveLength(0);
  });

  /**
   * ADR-0023 — the retention list is the decision, so it is what the test
   * states: personal records go, contributions stay. A device smoke found the
   * first half missing while the copy promised everything would be deleted.
   */
  it('takes the personal records with it and leaves the contributions', async () => {
    const { token, userId } = await register('delete-scope@gogo.id.vn');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Quán kiểm thử xoá',
        nameNormalized: 'quan kiem thu xoa',
        geom: { x: 106.7009, y: 10.7769 },
        addressText: '1 Nguyễn Huệ',
      })
      .returning();
    await db.insert(schema.savedItems).values({ userId, targetType: 'place', targetId: place!.id });
    await db
      .insert(schema.notifications)
      .values({ userId, kind: 'invite', payload: { roomId: place!.id } });
    await db
      .insert(schema.notificationPreferences)
      .values({ userId, channel: 'push', kind: 'invite', enabled: true });
    const [review] = await db
      .insert(schema.reviews)
      .values({ userId, placeId: place!.id, rating: 5, text: 'Đóng góp giữ lại' })
      .returning();

    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });
    expect(del.statusCode).toBe(200);

    // Personal records leave with the person.
    expect(
      await db.select().from(schema.savedItems).where(eq(schema.savedItems.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId)),
    ).toHaveLength(0);

    // Contributions and the technical record stay, by decision.
    const [keptReview] = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, review!.id));
    expect(keptReview).toMatchObject({ userId, text: 'Đóng góp giữ lại' });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row).toMatchObject({ id: userId, status: 'deleted' });

    // Login is unusable rather than merely hidden.
    const relogin = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip(),
      payload: { email: 'delete-scope@gogo.id.vn', password: 'Str0ng-Passw0rd!' },
    });
    expect(relogin.statusCode).toBe(401);
  });
});

describe('delayed cleanup can never take a live avatar (PROF-BE-004 regression)', () => {
  const privateStore = () => app.get<FakeStorage>(STORAGE_PROVIDER);
  const publicStore = () => app.get<FakeStorage>(PUBLIC_STORAGE_PROVIDER);
  const purge = () => app.get<FakeCachePurge>(CACHE_PURGE);
  const cleanup = () => app.get(MediaCleanupService);

  async function seededUpload(token: string): Promise<string> {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/uploads',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { purpose: 'avatar', contentType: 'image/png', contentLength: 100 },
    });
    const key = res.json().key as string;
    privateStore().seed(
      key,
      new Uint8Array(
        await sharp({ create: { width: 48, height: 48, channels: 3, background: '#f0f' } })
          .png()
          .toBuffer(),
      ),
      'image/png',
    );
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

  async function runEverythingDue() {
    await db.update(schema.mediaCleanupQueue).set({ nextAttemptAt: sql`now()` });
    return cleanup().runDue(100);
  }

  it('a failed attempt, then a successful retry with the same key: the graced row removes the original only', async () => {
    const { token, userId } = await register('avatar-retry@gogo.id.vn');
    const key = await seededUpload(token);

    publicStore().failWrites = true;
    try {
      expect((await putAvatar(token, key)).statusCode).toBe(503);
    } finally {
      publicStore().failWrites = false;
    }
    const graced = await db
      .select()
      .from(schema.mediaCleanupQueue)
      .where(eq(schema.mediaCleanupQueue.objectKey, key));
    expect(graced).toHaveLength(1);
    expect(graced[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    const retry = await putAvatar(token, key);
    expect(retry.statusCode).toBe(200);
    const url = retry.json().avatarUrl as string;
    const publicKey = url.replace('https://assets-test.local/', '');
    expect(publicStore().objects.has(publicKey)).toBe(true);

    // The delayed cleanup fires. It may only take the original.
    const report = await runEverythingDue();
    expect(report.attempted).toBeGreaterThanOrEqual(1);
    expect(privateStore().objects.has(key)).toBe(false);
    expect(publicStore().objects.has(publicKey)).toBe(true);
    expect(publicStore().deleted).not.toContain(publicKey);
    expect(purge().purged).not.toContain(url);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.avatarKey).toBe(publicKey);
    expect((await getMe(token)).json().avatarUrl).toBe(url);
    expect(await db.select().from(schema.mediaCleanupQueue)).toHaveLength(0);
  });

  it('a queue row that names a live avatar is dropped, never deleted, even when due', async () => {
    const { token } = await register('avatar-live@gogo.id.vn');
    const url = (await putAvatar(token, await seededUpload(token))).json().avatarUrl as string;
    const publicKey = url.replace('https://assets-test.local/', '');

    // No code path writes this row; it stands in for the bug that would.
    await db
      .insert(schema.mediaCleanupQueue)
      .values({ bucket: 'public', objectKey: publicKey, reason: 'regression_stale_row' });

    const report = await runEverythingDue();
    expect(report.skipped).toBe(1);
    expect(publicStore().objects.has(publicKey)).toBe(true);
    expect(publicStore().deleted).not.toContain(publicKey);
    expect(purge().purged).not.toContain(url);
    expect(
      await db
        .select()
        .from(schema.mediaCleanupQueue)
        .where(eq(schema.mediaCleanupQueue.objectKey, publicKey)),
    ).toHaveLength(0);
    expect((await getMe(token)).json().avatarUrl).toBe(url);

    // The same key, once the profile has moved on, is removable again.
    const next = (await putAvatar(token, await seededUpload(token))).json().avatarUrl as string;
    expect(next).not.toBe(url);
    expect(publicStore().deleted).toContain(publicKey);
  });
});

describe('ADM-019 canonical profile area', () => {
  let datasetVersion: string;
  let provinceCode: string;
  let communeCode: string;
  let otherProvince: string;
  beforeAll(async () => {
    await new AdministrativeBoundaryImportService(db).load({
      role: 'boundaries-fixture',
      boundaryVersion: 'fixture-v1',
      archivePath: path.resolve(
        __dirname,
        '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
      ),
    });
    const report = await new AdministrativeImportService(db).importPinnedSnapshot();
    datasetVersion = report.combinedDatasetVersion;
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'PUBLISHED', publishedAt: new Date() })
      .where(eq(schema.administrativeDatasetVersions.id, report.datasetVersionId));
    const [commune] = await db
      .select()
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, report.datasetVersionId),
          eq(schema.administrativeUnits.level, 'COMMUNE'),
          eq(schema.administrativeUnits.status, 'ACTIVE'),
          isNull(schema.administrativeUnits.effectiveTo),
        ),
      )
      .limit(1);
    communeCode = commune!.code;
    provinceCode = commune!.parentCode!;
    const [other] = await db
      .select()
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, report.datasetVersionId),
          eq(schema.administrativeUnits.level, 'PROVINCE'),
          eq(schema.administrativeUnits.status, 'ACTIVE'),
          ne(schema.administrativeUnits.code, provinceCode),
          isNull(schema.administrativeUnits.effectiveTo),
        ),
      )
      .limit(1);
    otherProvince = other!.code;
  });
  it('sets/reads/clears a canonical area, supports whole province, and keeps omitted fields', async () => {
    const user = await register('canonical-profile@gogo.test');
    expect((await getMe(user.token)).json().homeAdministrativeArea).toBeNull();
    await patchMe(user.token, { homeAreaKey: 'hcm_q1' });
    const saved = await patchMe(user.token, {
      homeAdministrativeArea: { datasetVersion, provinceCode, communeCode },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().homeArea).toBeNull();
    expect(saved.json().homeAdministrativeArea).toMatchObject({
      datasetVersion,
      provinceCode,
      communeCode,
      status: 'current',
    });
    expect(saved.json().homeAdministrativeArea.provinceName.length).toBeGreaterThan(0);
    const renamed = await patchMe(user.token, { displayName: 'Changed' });
    expect(renamed.json().homeAdministrativeArea).toEqual(saved.json().homeAdministrativeArea);
    const province = await patchMe(user.token, {
      homeAdministrativeArea: { datasetVersion, provinceCode, communeCode: null },
    });
    expect(province.json().homeAdministrativeArea.communeCode).toBeNull();
    const cleared = await patchMe(user.token, { homeAdministrativeArea: null });
    expect(cleared.json().homeAdministrativeArea).toBeNull();
  });
  it('rejects wrong hierarchy, stale datasets, fake codes and conflicting legacy input', async () => {
    const user = await register('invalid-canonical@gogo.test');
    for (const homeAdministrativeArea of [
      { datasetVersion, provinceCode: otherProvince, communeCode },
      { datasetVersion, provinceCode: '99999', communeCode: null },
    ])
      expect((await patchMe(user.token, { homeAdministrativeArea })).statusCode).toBe(400);
    const stale = await patchMe(user.token, {
      homeAdministrativeArea: { datasetVersion: 'old-version', provinceCode, communeCode },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await patchMe(user.token, { homeAdministrativeArea: null, homeAreaKey: null })).statusCode,
    ).toBe(400);
  });
  it('preserves saved labels and requests reselection after a dataset change', async () => {
    const user = await register('stale-canonical@gogo.test');
    const saved = await patchMe(user.token, {
      homeAdministrativeArea: { datasetVersion, provinceCode, communeCode },
    });
    expect(saved.statusCode).toBe(200);
    await db
      .update(schema.users)
      .set({
        homeAdministrativeArea: {
          ...saved.json().homeAdministrativeArea,
          datasetVersion: 'previous-dataset',
        },
      })
      .where(eq(schema.users.id, user.userId));
    const read = await getMe(user.token);
    expect(read.statusCode).toBe(200);
    expect(read.json().homeAdministrativeArea).toEqual({
      ...saved.json().homeAdministrativeArea,
      datasetVersion: 'previous-dataset',
      status: 'needs_reselection',
    });
  });
  it('exports the area and erases it on account deletion', async () => {
    const user = await register('private-canonical@gogo.test');
    await patchMe(user.token, {
      homeAdministrativeArea: { datasetVersion, provinceCode, communeCode },
    });
    const exported = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().profile.homeAdministrativeArea).toMatchObject({
      datasetVersion,
      provinceCode,
      communeCode,
    });
    const deleted = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(user.token),
    });
    expect(deleted.statusCode).toBeLessThan(300);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.userId));
    expect(row!.homeAdministrativeArea).toBeNull();
  });
});

/**
 * PROF-BE-013 (#573) — an optional date of birth: a calendar date that exists,
 * not after today in Asia/Ho_Chi_Minh, private to its owner, exported, erased.
 */
describe('date of birth (PROF-BE-013)', () => {
  // An oracle independent of the server's helper: Hanoi's calendar date now.
  const hanoiToday = () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  const addDays = (iso: string, days: number) => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };

  it('an account that never set one reads null; the column is nullable with no default', async () => {
    const { token, userId } = await register('dob-unset@gogo.id.vn');
    expect((await getMe(token)).json().dateOfBirth).toBeNull();
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row!.dateOfBirth).toBeNull();
    // Additive with no default and no backfill, so a pre-migration row reads null too.
    const { rows } = await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_name = 'users' and column_name = 'date_of_birth'`,
    );
    expect(rows).toEqual([{ data_type: 'date', is_nullable: 'YES', column_default: null }]);
  });

  it('sets, reads back unshifted, keeps when omitted, and clears with null', async () => {
    const { token, userId } = await register('dob-set@gogo.id.vn');
    const set = await patchMe(token, { dateOfBirth: '1990-05-17' });
    expect(set.statusCode).toBe(200);
    expect(set.json().dateOfBirth).toBe('1990-05-17');
    expect((await getMe(token)).json().dateOfBirth).toBe('1990-05-17');
    const stored = await pool.query(`select date_of_birth::text as dob from users where id = $1`, [
      userId,
    ]);
    expect(stored.rows[0].dob).toBe('1990-05-17');

    const renamed = await patchMe(token, { displayName: 'Vẫn Giữ Ngày Sinh' });
    expect(renamed.json().dateOfBirth).toBe('1990-05-17');

    const cleared = await patchMe(token, { dateOfBirth: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().dateOfBirth).toBeNull();
    expect((await getMe(token)).json().dateOfBirth).toBeNull();
  });

  it('accepts a real leap day and refuses a date that does not exist or is malformed', async () => {
    const { token } = await register('dob-leap@gogo.id.vn');
    const leap = await patchMe(token, { dateOfBirth: '2024-02-29' });
    expect(leap.statusCode).toBe(200);
    expect(leap.json().dateOfBirth).toBe('2024-02-29');

    const invalid: unknown[] = [
      '2027-02-29',
      '2026-13-01',
      '1990-04-31',
      '0000-01-01',
      '1990-5-17',
      '17/05/1990',
      '1990-05-17T00:00:00Z',
      '',
      19900517,
      true,
    ];
    for (const dateOfBirth of invalid) {
      const res = await patchMe(token, { dateOfBirth });
      expect(res.statusCode, JSON.stringify(dateOfBirth)).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(res.json().field_errors[0].field).toBe('dateOfBirth');
      if (typeof dateOfBirth === 'string') {
        expect(res.json().field_errors[0].code).toBe('invalid_date');
        // The error names the rule, never echoes the value.
        if (dateOfBirth) expect(JSON.stringify(res.json())).not.toContain(dateOfBirth);
      }
    }
    // Nothing refused above touched the stored value.
    expect((await getMe(token)).json().dateOfBirth).toBe('2024-02-29');
  });

  it('refuses a date after today in Asia/Ho_Chi_Minh and accepts today there', async () => {
    const { token } = await register('dob-future@gogo.id.vn');
    const today = hanoiToday();
    for (const dateOfBirth of [addDays(today, 1), '2999-01-01']) {
      const res = await patchMe(token, { dateOfBirth });
      expect(res.statusCode, dateOfBirth).toBe(400);
      expect(res.json().field_errors[0]).toMatchObject({ field: 'dateOfBirth', code: 'too_big' });
    }
    expect((await getMe(token)).json().dateOfBirth).toBeNull();
    const ok = await patchMe(token, { dateOfBirth: today });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().dateOfBirth).toBe(today);
  });

  it('is the owner’s alone: guests cannot set it, co-members never see it, audit names the field only', async () => {
    const join = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode, displayName: 'Khách Ngày Sinh' },
    });
    expect(join.statusCode).toBe(201);
    const guestToken = join.json().accessToken as string;
    const guestPatch = await patchMe(guestToken, { dateOfBirth: '1990-05-17' });
    expect(guestPatch.statusCode).toBe(403);
    expect(guestPatch.json().code).toBe('USER_ONLY');
    expect((await getMe(guestToken)).json()).not.toHaveProperty('dateOfBirth');

    const { token: hostToken, userId: hostId } = await register('dob-host@gogo.id.vn');
    const { token: memberToken, userId: memberId } = await register('dob-member@gogo.id.vn');
    expect((await patchMe(memberToken, { dateOfBirth: '1985-11-03' })).statusCode).toBe(200);
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: 'DOBROOM00001',
        type: 'group',
        status: 'collecting',
        decisionMode: 'vote',
        hostUserId: hostId,
        participantCount: 3,
      })
      .returning();
    await db.insert(schema.roomMembers).values([
      { roomId: room!.id, userId: hostId, role: 'host', displayName: 'dob-host' },
      { roomId: room!.id, userId: memberId, role: 'member', displayName: 'dob-member' },
    ]);
    for (const url of [`/v1/rooms/${room!.id}/members`, `/v1/rooms/${room!.id}`]) {
      const res = await api().inject({
        method: 'GET',
        url,
        remoteAddress: ip(),
        headers: auth(hostToken),
      });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('1985-11-03');
      expect(res.body, url).not.toContain('dateOfBirth');
    }

    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, memberId),
          eq(schema.auditLogs.action, 'user.profile_updated'),
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(1);
    const diff = JSON.stringify(audit?.diff);
    expect(diff).toContain('dateOfBirth');
    expect(diff).not.toContain('1985');
  });

  it('is in the authenticated export and erased on account deletion', async () => {
    const { token, userId } = await register('dob-private@gogo.id.vn');
    await patchMe(token, { dateOfBirth: '1979-01-31' });
    const exported = await api().inject({
      method: 'GET',
      url: '/v1/me/export',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().profile.dateOfBirth).toBe('1979-01-31');

    const deleted = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(deleted.statusCode).toBeLessThan(300);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row).toMatchObject({ status: 'deleted', dateOfBirth: null });
  });
});
