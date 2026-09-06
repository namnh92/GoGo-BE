import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * BE-CMS-M1 (#191) — place media is writable at last.
 *
 * The acceptance the issue asks for: an editor can add, reorder, moderate and
 * remove a photo and every write lands in the audit log; a rejected photo stops
 * being served to consumers; `moderator` and `ops_admin` are refused the
 * writes; and the admin path cannot pick up a key somebody else uploaded for a
 * different purpose.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.70.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createAdmin(email: string, role: 'editor' | 'moderator' | 'ops_admin') {
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: email.split('@')[0]!, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  expect(res.statusCode).toBe(201);
  return { id: row!.id, token: res.json().accessToken as string };
}

let seq = 0;
async function makePlace() {
  const name = `Ảnh địa điểm ${++seq}`;
  const [row] = await db
    .insert(schema.places)
    .values({
      name,
      nameNormalized: name.toLowerCase(),
      status: 'published',
      geom: { x: 106.7009, y: 10.7769 },
    })
    .returning();
  return row!;
}

let editor: { id: string; token: string };

/** The real door: `POST /cms/uploads` presigns and records the key. */
async function authorizeUpload(token: string, purpose = 'place_image') {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/uploads',
    headers: auth(token),
    remoteAddress: ip(),
    payload: { purpose, contentType: 'image/jpeg', contentLength: 512_000 },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; key: string };
}

const attach = (placeId: string, payload: Record<string, unknown>, token = editor.token) =>
  api().inject({
    method: 'POST',
    url: `/v1/cms/places/${placeId}/media`,
    headers: auth(token),
    payload,
  });

const patchMedia = (
  placeId: string,
  mediaId: string,
  payload: Record<string, unknown>,
  token = editor.token,
) =>
  api().inject({
    method: 'PATCH',
    url: `/v1/cms/places/${placeId}/media/${mediaId}`,
    headers: auth(token),
    payload,
  });

const detachMedia = (placeId: string, mediaId: string, token = editor.token) =>
  api().inject({
    method: 'DELETE',
    url: `/v1/cms/places/${placeId}/media/${mediaId}`,
    headers: auth(token),
  });

const detail = (placeId: string, token = editor.token) =>
  api().inject({ method: 'GET', url: `/v1/cms/places/${placeId}`, headers: auth(token) });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_place_media_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  // Photos are only offered to consumers when they can actually be loaded
  // (`toPhotos`): with no public media base the list is empty by design, which
  // would make every visibility assertion below vacuously true.
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.test.gogo.local';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  editor = await createAdmin('media-editor@gogo.local', 'editor');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('#191 upload → attach → moderate → visible', () => {
  it('walks the whole path an editor actually takes', async () => {
    const place = await makePlace();
    const upload = await authorizeUpload(editor.token);

    const attached = await attach(place.id, { storageKey: upload.key, caption: 'Mặt tiền quán' });
    expect(attached.statusCode).toBe(201);
    const media = attached.json();
    // Pending, always: uploading is not deciding it may be published.
    expect(media).toMatchObject({
      moderation: 'pending',
      caption: 'Mặt tiền quán',
      sourceType: 'editorial',
      isCover: false,
    });

    // Not yet public — consumers filter on `approved`.
    const beforeApproval = await api().inject({ method: 'GET', url: `/v1/places/${place.id}` });
    expect(beforeApproval.json().photos).toHaveLength(0);

    const approved = await patchMedia(place.id, media.id, {
      moderation: 'approved',
      moderationReason: 'Ảnh rõ, đúng địa điểm',
      isCover: true,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ moderation: 'approved', isCover: true });

    const afterApproval = await api().inject({ method: 'GET', url: `/v1/places/${place.id}` });
    expect(afterApproval.json().photos).toHaveLength(1);
    expect(afterApproval.json().photos[0].url).toContain(upload.key);
  });

  it('stops serving a photo the moment it is rejected', async () => {
    const place = await makePlace();
    const upload = await authorizeUpload(editor.token);
    const media = (await attach(place.id, { storageKey: upload.key })).json();
    await patchMedia(place.id, media.id, {
      moderation: 'approved',
      moderationReason: 'ok để xuất bản',
    });
    expect(
      (await api().inject({ method: 'GET', url: `/v1/places/${place.id}` })).json().photos,
    ).toHaveLength(1);

    await patchMedia(place.id, media.id, {
      moderation: 'rejected',
      moderationReason: 'Có mặt người trong ảnh',
    });
    const after = await api().inject({ method: 'GET', url: `/v1/places/${place.id}` });
    expect(after.json().photos).toHaveLength(0);
  });

  it('refuses a moderation decision with no reason', async () => {
    const place = await makePlace();
    const upload = await authorizeUpload(editor.token);
    const media = (await attach(place.id, { storageKey: upload.key })).json();

    const res = await patchMedia(place.id, media.id, { moderation: 'approved' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0]).toMatchObject({
      field: 'moderationReason',
      code: 'required',
    });
  });

  it('clears the cover when a photo is rejected', async () => {
    const place = await makePlace();
    const upload = await authorizeUpload(editor.token);
    const media = (await attach(place.id, { storageKey: upload.key, isCover: true })).json();
    expect(media.isCover).toBe(true);

    const rejected = await patchMedia(place.id, media.id, {
      moderation: 'rejected',
      moderationReason: 'Ảnh quá mờ',
    });
    expect(rejected.statusCode).toBe(200);
    // A rejected cover would leave the place with no lead image and nothing on
    // screen saying why.
    expect(rejected.json().isCover).toBe(false);
  });
});

describe('#191 ordering and cover', () => {
  it('keeps one cover per place and puts it first on read', async () => {
    const place = await makePlace();
    const first = (
      await attach(place.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();
    const second = (
      await attach(place.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();

    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);

    await patchMedia(place.id, second.id, { isCover: true });
    const rows = await db
      .select()
      .from(schema.placeMedia)
      .where(eq(schema.placeMedia.placeId, place.id));
    expect(rows.filter((r) => r.isCover)).toHaveLength(1);
    expect(rows.find((r) => r.isCover)!.id).toBe(second.id);

    // The detail read leads with the cover even though it sorts second.
    expect((await detail(place.id)).json().media[0].id).toBe(second.id);
  });

  it('reorders without touching moderation', async () => {
    const place = await makePlace();
    const media = (
      await attach(place.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();
    const res = await patchMedia(place.id, media.id, { sortOrder: 7 });
    expect(res.json()).toMatchObject({ sortOrder: 7, moderation: 'pending' });
  });

  it('refuses an empty patch rather than writing an audit row for nothing', async () => {
    const place = await makePlace();
    const media = (
      await attach(place.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();
    expect((await patchMedia(place.id, media.id, {})).statusCode).toBe(400);
  });
});

describe('#191 the key an editor may attach', () => {
  it('refuses a key authorized for another actor', async () => {
    const other = await createAdmin('media-editor-2@gogo.local', 'editor');
    const theirKey = await authorizeUpload(other.token);
    const place = await makePlace();

    const res = await attach(place.id, { storageKey: theirKey.key });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it('refuses a key authorized for another purpose', async () => {
    const bannerKey = await authorizeUpload(editor.token, 'banner_image');
    const place = await makePlace();
    const res = await attach(place.id, { storageKey: bannerKey.key });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it("refuses a consumer's own place_photo key — same picture, different claim", async () => {
    const place = await makePlace();
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'member@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'M' },
    });
    const consumerUpload = await api().inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: auth(reg.json().accessToken),
      remoteAddress: ip(),
      payload: { purpose: 'place_photo', contentType: 'image/jpeg', contentLength: 100_000 },
    });
    expect(consumerUpload.statusCode).toBe(201);

    const res = await attach(place.id, { storageKey: consumerUpload.json().key });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it('refuses an unknown key without revealing whether it exists', async () => {
    const place = await makePlace();
    const res = await attach(place.id, { storageKey: 'u/admin/nobody/none.jpg' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it('refuses attaching the same key to the same place twice', async () => {
    const place = await makePlace();
    const upload = await authorizeUpload(editor.token);
    expect((await attach(place.id, { storageKey: upload.key })).statusCode).toBe(201);
    const again = await attach(place.id, { storageKey: upload.key });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('PLACE_MEDIA_EXISTS');
  });

  it('lists only the caller’s own place_image uploads as attachable', async () => {
    const place = await makePlace();
    const mine = await authorizeUpload(editor.token);
    const banner = await authorizeUpload(editor.token, 'banner_image');
    const other = await createAdmin('media-editor-3@gogo.local', 'editor');
    const theirs = await authorizeUpload(other.token);

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${place.id}/media/attachable`,
      headers: auth(editor.token),
    });
    expect(res.statusCode).toBe(200);
    const keys = (res.json().items as { storageKey: string }[]).map((i) => i.storageKey);
    expect(keys).toContain(mine.key);
    expect(keys).not.toContain(banner.key);
    expect(keys).not.toContain(theirs.key);
  });
});

describe('#191 detach', () => {
  it('removes the photo from the place and releases the upload for the sweeper', async () => {
    const place = await makePlace();
    const upload = await authorizeUpload(editor.token);
    const media = (await attach(place.id, { storageKey: upload.key })).json();

    expect((await detachMedia(place.id, media.id)).statusCode).toBe(200);
    expect((await detail(place.id)).json().media).toHaveLength(0);

    // The file itself is not destroyed: the upload row returns to `pending` so
    // the existing sweeper reclaims it on its own schedule.
    const [row] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, upload.key));
    expect(row!.status).toBe('pending');
    expect(row!.attachedToId).toBeNull();
  });

  it('leaves an upload attached while another place still references the key', async () => {
    // A merge can leave the same key on two places; detaching one must not
    // orphan the other's picture.
    const placeA = await makePlace();
    const placeB = await makePlace();
    const upload = await authorizeUpload(editor.token);
    const mediaA = (await attach(placeA.id, { storageKey: upload.key })).json();
    await db.insert(schema.placeMedia).values({ placeId: placeB.id, storageKey: upload.key });

    await detachMedia(placeA.id, mediaA.id);
    const [row] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, upload.key));
    expect(row!.status).toBe('attached');
  });

  it('a media id from another place is a not-found, not a 403', async () => {
    const placeA = await makePlace();
    const placeB = await makePlace();
    const media = (
      await attach(placeA.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();

    const res = await detachMedia(placeB.id, media.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('PLACE_MEDIA_NOT_FOUND');
  });
});

describe('#191 RBAC and audit', () => {
  it('refuses the writes to moderator and ops_admin, and keeps the read rank-based', async () => {
    const place = await makePlace();
    const media = (
      await attach(place.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();
    const moderator = await createAdmin('media-mod@gogo.local', 'moderator');
    const ops = await createAdmin('media-ops@gogo.local', 'ops_admin');

    for (const actor of [moderator, ops]) {
      const write = await patchMedia(place.id, media.id, { sortOrder: 3 }, actor.token);
      expect(write.statusCode).toBe(403);
      expect(write.json().code).toBe('ROLE_DENIED');

      const remove = await detachMedia(place.id, media.id, actor.token);
      expect(remove.statusCode).toBe(403);
    }

    // The catalog read stays rank-based like the rest of the catalog.
    const read = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${place.id}`,
      headers: auth(ops.token),
    });
    expect(read.statusCode).toBe(200);
  });

  it('audits attach, update and detach with a before/after diff', async () => {
    const place = await makePlace();
    const media = (
      await attach(place.id, { storageKey: (await authorizeUpload(editor.token)).key })
    ).json();
    await patchMedia(place.id, media.id, {
      moderation: 'approved',
      moderationReason: 'Ảnh dùng được',
    });
    await detachMedia(place.id, media.id);

    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${place.id}/audit`,
      headers: auth(editor.token),
    });
    const actions = (audit.json().items as { action: string }[]).map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'place.media_attached',
        'place.media_updated',
        'place.media_detached',
      ]),
    );

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, 'place.media_updated'));
    const entry = rows.find((r) => r.resourceId === place.id)!;
    const diff = entry.diff as {
      before: { moderation: string };
      after: { moderation: string };
      reason: string;
    };
    expect(diff.before.moderation).toBe('pending');
    expect(diff.after.moderation).toBe('approved');
    // The decision and its reason, not just that a row changed (FR-CMS-008).
    expect(diff.reason).toBe('Ảnh dùng được');
  });
});

describe('#191 attribution', () => {
  it('keeps provider attribution through a reorder', async () => {
    const place = await makePlace();
    const [row] = await db
      .insert(schema.placeMedia)
      .values({
        placeId: place.id,
        storageKey: 'imported/provider-photo.jpg',
        attribution: 'Ảnh: Google · người đóng góp',
        sourceType: 'provider',
        moderation: 'approved',
      })
      .returning();

    await patchMedia(place.id, row!.id, { sortOrder: 2 });
    const media = (await detail(place.id)).json().media[0];
    expect(media).toMatchObject({
      attribution: 'Ảnh: Google · người đóng góp',
      sourceType: 'provider',
      sortOrder: 2,
    });
  });
});
