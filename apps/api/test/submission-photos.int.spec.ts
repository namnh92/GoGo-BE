import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import sharp from 'sharp';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  PLACE_PROVIDER,
  STORAGE_PROVIDER,
  PUBLIC_STORAGE_PROVIDER,
  type FakePlaceProvider,
  type FakeStorage,
} from '@gogo/providers';
import { MediaCleanupService } from '@gogo/modules';
import { cmsAccessHeaders } from './support/cms-access';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let moderator: string;
let editor: string;
let user: string;
let other: string;
let original: Buffer;
let seq = 0;
let ipc = 0;
const ip = () => `10.89.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const api = () => app.getHttpAdapter().getInstance();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const storage = () => app.get<FakeStorage>(STORAGE_PROVIDER);

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: {
      email,
      password: 'Sufficiently-long-pw1!',
      displayName: email.startsWith('other') ? 'An' : 'Mai',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().accessToken as string;
}
async function upload(token = user, purpose = 'place_photo', received = true) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/uploads',
    remoteAddress: ip(),
    headers: auth(token),
    payload: { purpose, contentType: 'image/jpeg', contentLength: original.byteLength },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; key: string };
  if (received) storage().seed(body.key, original, 'image/jpeg');
  return body;
}
function identity() {
  const id = `submission-photo-${++seq}`;
  app
    .get<FakePlaceProvider>(PLACE_PROVIDER)
    .seed({ providerPlaceId: id, name: `Quán ${seq}`, lat: 10.77, lng: 106.7 });
  return id;
}
const submit = (id: string, ids: string[], token = user) =>
  api().inject({
    method: 'POST',
    url: '/v1/place-submissions',
    remoteAddress: ip(),
    headers: auth(token),
    payload: { googlePlaceId: id, mediaIds: ids },
  });
const detail = (id: string, token = moderator) =>
  api().inject({
    method: 'GET',
    url: `/v1/cms/place-submissions/${id}`,
    headers: auth(token),
    remoteAddress: ip(),
  });
const decide = (
  id: string,
  decision: string,
  approvedPhotoIds?: string[],
  mergeIntoPlaceId?: string,
) =>
  api().inject({
    method: 'POST',
    url: `/v1/cms/place-submissions/${id}/decide`,
    headers: auth(moderator),
    remoteAddress: ip(),
    payload: {
      decision,
      ...(decision === 'rejected' ? { rejectionReason: 'inappropriate_content' } : {}),
      reason: 'Đã xem và kiểm duyệt',
      ...(approvedPhotoIds === undefined ? {} : { approvedPhotoIds }),
      ...(mergeIntoPlaceId ? { mergeIntoPlaceId } : {}),
    },
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_submission_photos_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  for (const role of ['moderator', 'editor'] as const) {
    const email = `photo-${role}@gogo.local`;
    await db.insert(schema.adminUsers).values({
      email,
      displayName: role,
      role,
      passwordHash: await argon2.hash('admin-password-123'),
    });
    const logged = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders(email),
      payload: { email, password: 'admin-password-123' },
    });
    expect(logged.statusCode, logged.body).toBe(201);
    if (role === 'moderator') moderator = logged.json().accessToken;
    else editor = logged.json().accessToken;
  }
  user = await register('photo-user@gogo.local');
  other = await register('other-photo-user@gogo.local');
  original = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ff0000' } })
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'must be removed' } } })
    .jpeg()
    .toBuffer();
}, 180000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('approved submission derivative detach (#793 F-02)', () => {
  const queued = (key: string) =>
    db.select().from(schema.mediaCleanupQueue).where(eq(schema.mediaCleanupQueue.objectKey, key));
  const detach = (placeId: string, mediaId: string) =>
    api().inject({
      method: 'DELETE',
      url: `/v1/cms/places/${placeId}/media/${mediaId}`,
      headers: auth(editor),
    });

  async function approvedPhoto() {
    const item = await upload();
    const sent = await submit(identity(), [item.id]);
    expect(sent.statusCode, sent.body).toBe(201);
    const submissionId = sent.json().submissionId;
    const photos = (await detail(submissionId)).json().photos;
    const approved = await decide(submissionId, 'approved', [photos[0].id]);
    expect(approved.statusCode, approved.body).toBe(201);
    const [media] = await db
      .select()
      .from(schema.placeMedia)
      .where(eq(schema.placeMedia.placeId, approved.json().placeId));
    expect(media!.storageKey).toMatch(/^submission-photos\//);
    const [uploadRow] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.id, item.id));
    expect(uploadRow!.storageKey).toBe(item.key);
    expect(media!.storageKey).not.toBe(item.key);
    expect(await queued(media!.storageKey)).toHaveLength(0);
    expect(storage().objects.has(media!.storageKey)).toBe(true);
    return media!;
  }

  async function sharedPhoto() {
    const first = await approvedPhoto();
    const sent = await submit(identity(), []);
    const approved = await decide(sent.json().submissionId, 'approved');
    expect(approved.statusCode, approved.body).toBe(201);
    const [second] = await db
      .insert(schema.placeMedia)
      .values({
        placeId: approved.json().placeId,
        storageKey: first.storageKey,
        sourceType: 'community',
        moderation: 'approved',
        mediaUploadId: first.mediaUploadId,
        uploadedByUserId: first.uploadedByUserId,
      })
      .returning();
    return [first, second!] as const;
  }

  it('approves, detaches, and cleans private bytes while revoking the public read immediately', async () => {
    const media = await approvedPhoto();
    const url = `/v1/places/${media.placeId}/photos/${media.id}/content`;
    expect((await api().inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await detach(media.placeId, media.id)).statusCode).toBe(200);
    expect((await api().inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(await queued(media.storageKey)).toEqual([
      expect.objectContaining({ bucket: 'private', reason: 'submission_photo_detached' }),
    ]);
    expect(storage().objects.has(media.storageKey)).toBe(true);
    await app.get(MediaCleanupService).runDue(1000);
    expect(storage().objects.has(media.storageKey)).toBe(false);
    expect(await queued(media.storageKey)).toHaveLength(0);
  });

  it('keeps shared private bytes until the final place-media reference is detached', async () => {
    const [first, second] = await sharedPhoto();
    expect((await detach(first.placeId, first.id)).statusCode).toBe(200);
    expect(await queued(first.storageKey)).toHaveLength(0);
    await app.get(MediaCleanupService).runDue(1000);
    expect(storage().objects.has(first.storageKey)).toBe(true);
    expect((await detach(second.placeId, second.id)).statusCode).toBe(200);
    expect(await queued(first.storageKey)).toHaveLength(1);
    await app.get(MediaCleanupService).runDue(1000);
    expect(storage().objects.has(first.storageKey)).toBe(false);
  });

  it('queues one private cleanup when shared references are detached concurrently', async () => {
    const media = await sharedPhoto();
    const results = await Promise.all(media.map((m) => detach(m.placeId, m.id)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await queued(media[0].storageKey)).toHaveLength(1);
    await app.get(MediaCleanupService).runDue(1000);
    expect(storage().objects.has(media[0].storageKey)).toBe(false);
  });

  it('rolls back detach if the private cleanup job cannot be recorded', async () => {
    const media = await approvedPhoto();
    await db.execute(sql`create function fail_submission_cleanup_793() returns trigger language plpgsql as $$
      begin raise exception 'cleanup unavailable'; end; $$`);
    await db.execute(sql`create trigger fail_submission_cleanup_793 before insert on media_cleanup_queue
      for each row execute function fail_submission_cleanup_793()`);
    try {
      expect((await detach(media.placeId, media.id)).statusCode).toBe(500);
      expect(
        await db.select().from(schema.placeMedia).where(eq(schema.placeMedia.id, media.id)),
      ).toHaveLength(1);
      expect(await queued(media.storageKey)).toHaveLength(0);
      expect(storage().objects.has(media.storageKey)).toBe(true);
    } finally {
      await db.execute(sql`drop trigger fail_submission_cleanup_793 on media_cleanup_queue`);
      await db.execute(sql`drop function fail_submission_cleanup_793()`);
    }
  });
});

describe('submission photo lifecycle (#793)', () => {
  it('accepts zero photos without changing the old approval flow', async () => {
    const sent = await submit(identity(), []);
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await detail(sent.json().submissionId)).json().photos).toEqual([]);
    expect((await decide(sent.json().submissionId, 'approved')).statusCode).toBe(201);
  });

  it('keeps five photos private, shows only sanitised previews to staff, and credits each uploader after explicit approval', async () => {
    const id = identity();
    const uploads = [];
    for (let i = 0; i < 4; i++) uploads.push(await upload());
    const sent = await submit(
      id,
      uploads.map((u) => u.id),
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const submissionId = sent.json().submissionId;
    const otherUpload = await upload(other);
    expect((await submit(id, [otherUpload.id], other)).statusCode).toBe(201);
    const pending = (await detail(submissionId)).json().photos as {
      id: string;
      url: string;
      status: string;
    }[];
    expect(pending).toHaveLength(5);
    expect(app.get<FakeStorage>(PUBLIC_STORAGE_PROVIDER).objects.size).toBe(0);
    expect((await detail(submissionId, user)).statusCode).toBe(403);
    expect((await api().inject({ method: 'GET', url: pending[0]!.url })).statusCode).toBe(401);
    expect(
      (await api().inject({ method: 'GET', url: pending[0]!.url, headers: auth(user) })).statusCode,
    ).toBe(403);
    const preview = await api().inject({
      method: 'GET',
      url: pending[0]!.url,
      headers: auth(moderator),
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers['content-type']).toContain('image/webp');
    expect((await sharp(preview.rawPayload).metadata()).exif).toBeUndefined();
    const [attached] = await db
      .select()
      .from(schema.placeSubmissionPhotos)
      .where(eq(schema.placeSubmissionPhotos.submissionId, submissionId));
    const privatePhoto = await api().inject({
      method: 'GET',
      url: `/v1/places/${submissionId}/photos/${attached!.id}/content`,
    });
    expect(privatePhoto.statusCode, privatePhoto.body).toBe(404);
    expect(privatePhoto.headers['content-type']).toContain('application/json');
    expect(privatePhoto.json().code).toBe('PLACE_PHOTO_NOT_FOUND');
    const oldCms = await decide(submissionId, 'approved');
    expect(oldCms.statusCode, oldCms.body).toBe(409);
    expect(oldCms.json().code).toBe('PHOTO_REVIEW_REQUIRED');
    const approved = await decide(
      submissionId,
      'approved',
      pending.map((p) => p.id),
    );
    expect(approved.statusCode, approved.body).toBe(201);
    const placeId = approved.json().placeId;
    const place = await api().inject({ method: 'GET', url: `/v1/places/${placeId}` });
    expect(place.statusCode, place.body).toBe(200);
    expect(place.json().photos).toHaveLength(5);
    expect(
      place
        .json()
        .photos.map((p: { contributor: { displayName: string } }) => p.contributor.displayName)
        .sort(),
    ).toEqual(['An', 'Mai', 'Mai', 'Mai', 'Mai']);
    for (const photo of place.json().photos) {
      expect(photo.source).toBe('community');
      expect(photo.attribution).toBeUndefined();
      const content = await api().inject({ method: 'GET', url: photo.url });
      expect(content.statusCode, content.body).toBe(200);
      expect((await sharp(content.rawPayload).metadata()).exif).toBeUndefined();
    }
    expect(
      (await api().inject({ method: 'GET', url: pending[0]!.url, headers: auth(moderator) }))
        .statusCode,
    ).toBe(404);
    const firstPhoto = place.json().photos[0];
    await db
      .update(schema.placeMedia)
      .set({ moderation: 'pending' })
      .where(eq(schema.placeMedia.id, firstPhoto.id));
    expect((await api().inject({ method: 'GET', url: firstPhoto.url })).statusCode).toBe(404);
    expect(
      (await api().inject({ method: 'GET', url: `/v1/places/${placeId}` })).json().photos,
    ).toHaveLength(4);
    await db
      .update(schema.placeMedia)
      .set({ moderation: 'approved' })
      .where(eq(schema.placeMedia.id, firstPhoto.id));
    await db
      .update(schema.places)
      .set({ status: 'suspended' })
      .where(eq(schema.places.id, placeId));
    expect(
      (await api().inject({ method: 'GET', url: place.json().photos[0].url })).statusCode,
    ).toBe(404);
  });

  it('rejects foreign, wrong purpose, expired, missing, corrupt, size-mismatched and duplicate uploads', async () => {
    const foreign = await upload(other);
    const wrong = await upload(user, 'checkin_photo');
    const missing = await upload(user, 'place_photo', false);
    const expired = await upload();
    await db
      .update(schema.mediaUploads)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.mediaUploads.id, expired.id));
    const corrupt = await upload();
    storage().seed(corrupt.key, Buffer.alloc(original.byteLength), 'image/jpeg');
    const mismatch = await upload();
    storage().seed(mismatch.key, original.subarray(0, -1), 'image/jpeg');
    for (const [ids, status, code] of [
      [[foreign.id], 400, 'INVALID_SUBMISSION_PHOTOS'],
      [[wrong.id], 400, 'INVALID_SUBMISSION_PHOTOS'],
      [[expired.id], 400, 'INVALID_UPLOAD_KEY'],
      [[missing.id], 409, 'UPLOAD_NOT_RECEIVED'],
      [[corrupt.id], 422, 'PHOTO_UNPROCESSABLE'],
      [[mismatch.id], 400, 'INVALID_SUBMISSION_PHOTOS'],
      [[wrong.id, wrong.id], 400, 'VALIDATION_FAILED'],
      [Array(6).fill(wrong.id), 400, 'VALIDATION_FAILED'],
    ] as const) {
      const sent = await submit(identity(), [...ids]);
      expect(sent.statusCode, sent.body).toBe(status);
      expect(sent.json().code).toBe(code);
    }
  });

  it('removes individual photos immediately; rejects the rest with the submission; retention deletes processed objects', async () => {
    const uploads = [await upload(), await upload()];
    const sent = await submit(
      identity(),
      uploads.map((p) => p.id),
    );
    const id = sent.json().submissionId;
    const photos = (await detail(id)).json().photos;
    const removed = await api().inject({
      method: 'DELETE',
      url: `/v1/cms/place-submissions/${id}/photos/${photos[0].id}`,
      headers: auth(moderator),
      payload: { reason: 'Không phù hợp' },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const removedPhoto = await api().inject({
      method: 'GET',
      url: photos[0].url,
      headers: auth(moderator),
    });
    expect(removedPhoto.statusCode, removedPhoto.body).toBe(404);
    expect(removedPhoto.headers['content-type']).toContain('application/json');
    expect(removedPhoto.json().code).toBe('SUBMISSION_PHOTO_NOT_FOUND');
    expect((await decide(id, 'rejected')).statusCode).toBe(201);
    const rows = await db
      .select()
      .from(schema.placeSubmissionPhotos)
      .where(eq(schema.placeSubmissionPhotos.submissionId, id));
    expect(rows.every((p) => p.status === 'rejected')).toBe(true);
    const queue = await db.select().from(schema.mediaCleanupQueue);
    for (const row of rows) {
      expect(
        queue.find((q) => q.objectKey === row.storageKey)!.nextAttemptAt.getTime(),
      ).toBeGreaterThan(Date.now() + 6 * 86400000);
    }
    await db.update(schema.mediaCleanupQueue).set({ nextAttemptAt: new Date(0) });
    await app.get(MediaCleanupService).runDue(1000);
    for (const row of rows) expect(storage().objects.has(row.storageKey)).toBe(false);
    for (const item of uploads) expect(storage().objects.has(item.key)).toBe(false);
  });

  it('rejects a selection from another submission and never publishes it; [] explicitly discards photos', async () => {
    const first = await submit(identity(), [(await upload()).id]);
    const second = await submit(identity(), [(await upload()).id]);
    const photo = (await detail(first.json().submissionId)).json().photos[0];
    const bad = await decide(second.json().submissionId, 'approved', [photo.id]);
    expect(bad.statusCode, bad.body).toBe(400);
    expect((await detail(second.json().submissionId)).json().status).toBe('pending');
    const approved = await decide(second.json().submissionId, 'approved', []);
    expect(approved.statusCode, approved.body).toBe(201);
    expect(
      (await api().inject({ method: 'GET', url: `/v1/places/${approved.json().placeId}` })).json()
        .photos,
    ).toEqual([]);
  });

  it('enforces the per-submission cap under concurrent deduplication', async () => {
    const id = identity();
    const uploads = [];
    for (let i = 0; i < 6; i++) uploads.push(await upload());
    const initial = await submit(
      id,
      uploads.slice(0, 4).map((u) => u.id),
    );
    const results = await Promise.all(uploads.slice(4).map((u) => submit(id, [u.id])));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await detail(initial.json().submissionId)).json().photos).toHaveLength(5);
  });

  it('does not reuse a claimed upload for another submission; retry uses the derivative after original cleanup', async () => {
    const item = await upload();
    const id = identity();
    const initial = await submit(id, [item.id]);
    expect(initial.statusCode, initial.body).toBe(201);
    storage().objects.delete(item.key);
    expect((await submit(id, [item.id])).statusCode).toBe(201);
    expect((await detail(initial.json().submissionId)).json().photos).toHaveLength(1);
    const invalid = await submit(identity(), [item.id]);
    expect(invalid.statusCode, invalid.body).toBe(400);
  });

  it('concurrent retries of the same upload keep one committed derivative', async () => {
    const item = await upload();
    const id = identity();
    const responses = await Promise.all([submit(id, [item.id]), submit(id, [item.id])]);
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201]);
    expect((await detail(responses[0]!.json().submissionId)).json().photos).toHaveLength(1);
  });

  it('merges explicitly reviewed photos into the selected place', async () => {
    const target = await submit(identity(), []);
    const accepted = await decide(target.json().submissionId, 'approved');
    const sent = await submit(identity(), [(await upload()).id]);
    const id = sent.json().submissionId;
    const photos = (await detail(id)).json().photos;
    const merged = await decide(id, 'merged', [photos[0].id], accepted.json().placeId);
    expect(merged.statusCode, merged.body).toBe(201);
    const place = await api().inject({
      method: 'GET',
      url: `/v1/places/${accepted.json().placeId}`,
    });
    expect(place.json().photos[0].contributor.displayName).toBe('Mai');
  });
});
