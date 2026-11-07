import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { FakeStorage } from '@gogo/providers';
import {
  BILL_PHOTO_PREFIX,
  WIZARD_MENU_PHOTO_PREFIX,
  SubmissionPhotosService,
} from './submission-photos.service';
import type { Actor } from '../../identity/domain/actor';

const actor: Actor = { type: 'user', id: randomUUID(), sessionId: randomUUID() };
const bitmap = (color: string) =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: color } })
    .png()
    .toBuffer();
async function fixture(retained = false) {
  const raw = await bitmap('red');
  const storage = new FakeStorage();
  const upload = {
    id: randomUUID(),
    actorId: actor.id,
    actorType: actor.type,
    purpose: 'place_photo',
    contentType: 'image/png',
    contentLength: raw.length,
    storageKey: retained ? 'submission-photos/draft.webp' : 'tmp/place-photos/original.png',
    status: retained ? 'attached' : 'pending',
    attachedToType: retained ? 'contribution_draft' : null,
    attachedToId: retained ? randomUUID() : null,
    expiresAt: new Date(Date.now() + (retained ? 30 * 86400000 : 900000)),
  };
  await storage.putObject(upload.storageKey, raw, 'image/png');
  const draft = {
    id: upload.attachedToId,
    userId: actor.id,
    expiresAt: upload.expiresAt,
    enrichment: { photos: [{ mediaId: upload.id, kind: 'bill' as 'menu' | 'bill' }] },
  };
  const updates: { table: unknown; values: Record<string, unknown> }[] = [];
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const pending: Record<string, unknown>[] = [];
  const query = (table: unknown) => {
    const rows =
      table === schema.mediaUploads
        ? [upload]
        : table === schema.placeContributionDrafts
          ? [draft]
          : table === schema.placeSubmissionPhotos
            ? pending
            : table === schema.placeSubmissions
              ? [{ enrichment: draft.enrichment }]
              : [];
    return Object.assign(Promise.resolve(rows), {
      orderBy: () => ({ for: async () => rows }),
      for: async () => rows,
    });
  };
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => query(table) }) }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, values });
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: upload.id }] });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push({ table, values });
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };
  const uploads = { verifyUploaded: vi.fn().mockResolvedValue({}), attach: vi.fn() };
  const cleanup = {
    attemptNow: vi.fn().mockResolvedValue(undefined),
    enqueueNow: vi.fn().mockResolvedValue([randomUUID()]),
    enqueue: vi.fn().mockResolvedValue([]),
  };
  const service = new SubmissionPhotosService(
    db as never,
    uploads as never,
    cleanup as never,
    storage,
  );
  return {
    service,
    pending,
    db,
    upload,
    storage,
    raw,
    cleanup,
    uploads,
    updates,
    inserted,
    draft,
  };
}

it('stores consented bills as private metadata-free WebP without an external service', async () => {
  const h = await fixture();
  const prepared = await h.service.prepare(actor, [h.upload.id], null, {
    evidence: [{ mediaId: h.upload.id, kind: 'bill' }],
    billPhotoPublicConsent: true,
  });
  const photo = prepared.photos[0]!;
  expect(photo.key.startsWith(BILL_PHOTO_PREFIX)).toBe(true);
  const metadata = await sharp((await h.storage.getObject(photo.key)).body).metadata();
  expect(metadata.format).toBe('webp');
  expect(metadata.exif).toBeUndefined();
  await h.service.attach(h.db as never, actor, randomUUID(), prepared);
  expect(h.inserted.find((i) => i.table === schema.placeSubmissionPhotos)?.values.storageKey).toBe(
    photo.key,
  );
});

it.each([undefined, false])(
  'refuses bill without true consent (%s) before storage or claims',
  async (billPhotoPublicConsent) => {
    const h = await fixture();
    await expect(
      h.service.prepare(actor, [h.upload.id], null, {
        evidence: [{ mediaId: h.upload.id, kind: 'bill' }],
        billPhotoPublicConsent,
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      options: { fieldErrors: [{ field: 'enrichment.billPhotoPublicConsent' }] },
    });
    expect(h.cleanup.enqueueNow).not.toHaveBeenCalled();
    expect(h.uploads.attach).not.toHaveBeenCalled();
  },
);

it('retained bills keep their consent requirement when relabelled as menu and still require consent', async () => {
  const h = await fixture(true);
  h.upload.storageKey = `${BILL_PHOTO_PREFIX}retained.webp`;
  await h.storage.putObject(h.upload.storageKey, h.raw, 'image/png');
  const options = { evidence: [{ mediaId: h.upload.id, kind: 'menu' as const }] };
  await expect(h.service.prepare(actor, [h.upload.id], null, options)).rejects.toMatchObject({
    httpStatus: 400,
  });
  const prepared = await h.service.prepare(actor, [h.upload.id], null, {
    ...options,
    billPhotoPublicConsent: true,
  });
  expect(prepared.photos[0]!.key.startsWith(BILL_PHOTO_PREFIX)).toBe(true);
});

it('selected wizard menus join user photos without creating official gallery rows', async () => {
  const h = await fixture();
  const id = randomUUID(),
    submissionId = randomUUID();
  h.pending.push({
    id,
    submissionId,
    storageKey: 'submission-photos/menu.webp',
    mediaUploadId: h.upload.id,
    status: 'pending',
  });
  h.draft.enrichment.photos = [{ mediaId: h.upload.id, kind: 'menu' }];
  const placeId = randomUUID();
  await h.service.decide(h.db as never, submissionId, placeId, randomUUID(), undefined, [id]);
  expect(h.inserted.filter((i) => i.table === schema.placeMedia)).toHaveLength(0);
  expect(h.updates).toContainEqual({
    table: schema.placeSubmissionPhotos,
    values: { status: 'approved', placeId },
  });
  expect(h.cleanup.enqueue).not.toHaveBeenCalled();
});

it('F-04 resumes a retained photo after the presigned upload has expired, and transfers its claim', async () => {
  const h = await fixture(true);
  const prepared = await h.service.prepare(actor, [h.upload.id], null);
  expect(h.uploads.verifyUploaded.mock.calls[0]?.[1]).toEqual([]);
  const submissionId = randomUUID();
  await h.service.attach(h.db as never, actor, submissionId, prepared);
  expect(h.updates).toContainEqual({
    table: schema.mediaUploads,
    values: expect.objectContaining({
      attachedToType: 'place_submission',
      attachedToId: submissionId,
    }),
  });
  expect(h.cleanup.enqueue).toHaveBeenCalledWith(h.db, expect.any(Array), { delaySeconds: 0 });
});

it('F-04 refuses expired drafts and cross-draft reuse before reading bytes', async () => {
  const h = await fixture(true);
  await expect(
    h.service.prepare(actor, [h.upload.id], null, { draftId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'INVALID_SUBMISSION_PHOTOS' });
  h.draft.expiresAt = new Date(0);
  await expect(h.service.prepare(actor, [h.upload.id], null)).rejects.toMatchObject({
    code: 'INVALID_SUBMISSION_PHOTOS',
  });
});

it('F-04 retains copied bytes to draft expiry and queues originals for deletion', async () => {
  const h = await fixture();
  const prepared = await h.service.prepare(actor, [h.upload.id], null);
  const expiresAt = new Date(Date.now() + 30 * 86400000);
  const draftId = randomUUID();
  await h.service.retainDraft(h.db as never, actor, draftId, prepared, expiresAt);
  expect(h.updates).toContainEqual({
    table: schema.mediaUploads,
    values: expect.objectContaining({
      storageKey: prepared.photos[0]!.key,
      attachedToType: 'contribution_draft',
      attachedToId: draftId,
      expiresAt,
    }),
  });
  expect(h.updates).toContainEqual({
    table: schema.mediaCleanupQueue,
    values: { nextAttemptAt: expiresAt },
  });
  expect(h.cleanup.enqueue).toHaveBeenCalledWith(
    h.db,
    [{ bucket: 'private', objectKey: h.upload.storageKey, reason: 'draft_photo_replaced' }],
    { delaySeconds: 900 },
  );
});

it('attempts bill deletion only after commit while preserving the delayed original cleanup', async () => {
  const h = await fixture();
  await h.service.cleanupDecidedBills({
    cleanupIds: ['durable-job'],
    originalKeys: [h.upload.storageKey],
  });
  expect(h.cleanup.attemptNow).toHaveBeenCalledWith(['durable-job']);
  expect(await h.storage.exists(h.upload.storageKey)).toBe(false);
});

it.each([true, false])(
  'all bills follow explicit moderator selection (selected=%s)',
  async (selected) => {
    const h = await fixture();
    const id = randomUUID(),
      submissionId = randomUUID(),
      placeId = randomUUID();
    const key = `${BILL_PHOTO_PREFIX}${id}.webp`;
    h.pending.push({
      id,
      submissionId,
      storageKey: key,
      mediaUploadId: h.upload.id,
      uploadedByUserId: actor.id,
      status: 'pending',
    });
    await h.service.decide(
      h.db as never,
      submissionId,
      placeId,
      randomUUID(),
      undefined,
      selected ? [id] : [],
    );
    const media = h.inserted.filter((i) => i.table === schema.placeMedia);
    expect(media).toHaveLength(0);
    expect(h.updates).toContainEqual({
      table: schema.placeSubmissionPhotos,
      values: { status: selected ? 'approved' : 'rejected', placeId: selected ? placeId : null },
    });
    if (selected) {
      expect(h.cleanup.enqueue).not.toHaveBeenCalled();
    } else {
      expect(h.cleanup.enqueue).toHaveBeenCalledWith(
        h.db,
        [
          { bucket: 'private', objectKey: key, reason: 'bill_photo_decided' },
          {
            bucket: 'private',
            objectKey: h.upload.storageKey,
            reason: 'bill_photo_original_decided',
          },
        ],
        { delaySeconds: 0 },
      );
    }
  },
);

it('serves bill bytes through the approved user-photo read query', async () => {
  const storage = new FakeStorage();
  const key = `${BILL_PHOTO_PREFIX}approved.webp`;
  const bytes = await bitmap('blue');
  await storage.putObject(key, bytes, 'image/png');
  const db = {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ key }] }) }) }),
  };
  const service = new SubmissionPhotosService(db as never, {} as never, {} as never, storage);
  expect(await service.readPublic(randomUUID(), randomUUID())).toEqual(bytes);
});

it('retained wizard menus keep their user-photo classification through draft relabelling and dedupe', async () => {
  const h = await fixture(true);
  h.upload.storageKey = `${WIZARD_MENU_PHOTO_PREFIX}retained.webp`;
  await h.storage.putObject(h.upload.storageKey, h.raw, 'image/png');
  const prepared = await h.service.prepare(actor, [h.upload.id], null);
  expect(prepared.photos[0]!.key.startsWith(WIZARD_MENU_PHOTO_PREFIX)).toBe(true);
  const id = randomUUID(),
    placeId = randomUUID(),
    submissionId = randomUUID();
  h.pending.push({
    id,
    storageKey: prepared.photos[0]!.key,
    mediaUploadId: h.upload.id,
    status: 'pending',
  });
  h.draft.enrichment.photos = []; // deduped submission retains somebody else's proposal
  await h.service.decide(h.db as never, submissionId, placeId, randomUUID(), undefined, [id]);
  expect(h.inserted.filter((i) => i.table === schema.placeMedia)).toEqual([]);
  expect(h.updates).toContainEqual({
    table: schema.placeSubmissionPhotos,
    values: { status: 'approved', placeId },
  });
});
