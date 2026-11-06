import { UploadsService } from '../../uploads/application/uploads.service';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { sanitiseSubmissionPhoto, SubmissionPhotosService } from './submission-photos.service';
import { toPhotos } from '../../search/domain/place-dto';

/** Actual GPS EXIF TIFF payload, embedded by sharp in a real JPEG. */
function gpsExif() {
  const exif = Buffer.alloc(86);
  exif.write('Exif\0\0', 0, 'binary');
  exif.write('II', 6);
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14);
  exif.writeUInt16LE(0x8825, 16); // GPSInfo pointer
  exif.writeUInt16LE(4, 18);
  exif.writeUInt32LE(1, 20);
  exif.writeUInt32LE(26, 24);
  exif.writeUInt16LE(2, 32);
  exif.writeUInt16LE(1, 34); // GPSLatitudeRef
  exif.writeUInt16LE(2, 36);
  exif.writeUInt32LE(2, 38);
  exif.write('N\0', 42, 'binary');
  exif.writeUInt16LE(2, 46); // GPSLatitude
  exif.writeUInt16LE(5, 48);
  exif.writeUInt32LE(3, 50);
  exif.writeUInt32LE(56, 54);
  for (let i = 0; i < 3; i++) {
    exif.writeUInt32LE([10, 46, 30][i]!, 62 + i * 8);
    exif.writeUInt32LE(1, 66 + i * 8);
  }
  return exif;
}

async function gpsJpeg() {
  const raw = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff0000' } })
    .jpeg()
    .toBuffer();
  const exif = gpsExif();
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([raw.subarray(0, 2), app1, exif, raw.subarray(2)]);
}

describe('submission photo sanitisation (#793 / #771)', () => {
  it('removes real GPS EXIF and other metadata, retaining dimensions', async () => {
    const jpeg = await gpsJpeg();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const processed = await sanitiseSubmissionPhoto(jpeg, 'image/jpeg');
    const meta = await sharp(processed.body).metadata();
    expect(processed).toMatchObject({ width: 64, height: 48 });
    expect(meta).toMatchObject({ format: 'webp', width: 64, height: 48 });
    for (const field of ['exif', 'icc', 'iptc', 'xmp'] as const)
      expect(meta[field]).toBeUndefined();
    expect(Buffer.from(processed.body).includes(Buffer.from('Exif'))).toBe(false);
  });

  it('applies EXIF orientation without retaining EXIF', async () => {
    const jpeg = await sharp({
      create: { width: 60, height: 30, channels: 3, background: '#00ff00' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const processed = await sanitiseSubmissionPhoto(jpeg, 'image/jpeg');
    expect(processed).toMatchObject({ width: 30, height: 60 });
    expect((await sharp(processed.body).metadata()).exif).toBeUndefined();
  });

  it('bounds output dimensions and preserves aspect ratio', async () => {
    const jpeg = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: '#00ff00' },
    })
      .jpeg()
      .toBuffer();
    expect(await sanitiseSubmissionPhoto(jpeg, 'image/jpeg')).toMatchObject({
      width: 2048,
      height: 1024,
    });
  });

  it('rejects mismatched content types and corrupt data', async () => {
    const jpeg = await gpsJpeg();
    await expect(sanitiseSubmissionPhoto(jpeg, 'image/png')).rejects.toMatchObject({
      code: 'PHOTO_UNPROCESSABLE',
    });
    await expect(
      sanitiseSubmissionPhoto(Buffer.from('not an image'), 'image/jpeg'),
    ).rejects.toMatchObject({ code: 'PHOTO_UNPROCESSABLE' });
    await expect(sanitiseSubmissionPhoto(jpeg, 'image/heic')).rejects.toMatchObject({
      code: 'PHOTO_UNPROCESSABLE',
    });
  });

  it('rejects over-limit decoded pixels', async () => {
    const png = await sharp({
      create: { width: 4001, height: 4001, channels: 3, background: '#00ff00' },
    })
      .png()
      .toBuffer();
    await expect(sanitiseSubmissionPhoto(png, 'image/png')).rejects.toMatchObject({
      code: 'PHOTO_UNPROCESSABLE',
    });
  });
});

describe('public photo DTO', () => {
  const placeId = randomUUID();
  const photo = {
    id: randomUUID(),
    storageKey: 'submission-photos/random.webp',
    width: 64,
    height: 48,
    source: 'community' as const,
    moderation: 'approved',
    contributor: { displayName: 'Mai' },
  };
  it('exposes only processed approved bytes with the actual contributor, without Google credit', () => {
    expect(toPhotos([photo], '', 'Google', placeId)).toEqual([
      {
        id: photo.id,
        url: `/v1/places/${placeId}/photos/${photo.id}/content`,
        width: 64,
        height: 48,
        source: 'community',
        contributor: photo.contributor,
      },
    ]);
  });
  it('omits pending, rejected, and original private keys even when a CDN exists', () => {
    expect(
      toPhotos(
        [
          { ...photo, moderation: 'pending' },
          { ...photo, moderation: 'rejected' },
          { ...photo, storageKey: 'u/user/actor/original.jpg' },
        ],
        'https://assets.test',
        'Google',
        placeId,
      ),
    ).toEqual([]);
  });
});

/** Unit boundaries: rejected ownership never causes storage I/O. */
describe('submission photo upload validation', () => {
  const actor = { type: 'user' as const, id: randomUUID(), sessionId: randomUUID() };
  const upload = {
    id: randomUUID(),
    storageKey: 'u/user/actor/a.jpg',
    actorType: 'user',
    actorId: actor.id,
    purpose: 'place_photo',
    contentType: 'image/jpeg',
    contentLength: 100,
    status: 'pending',
  };
  function service(row: Record<string, unknown> | null) {
    const db = { select: () => ({ from: () => ({ where: async () => (row ? [row] : []) }) }) };
    const storage = { getObject: vi.fn() };
    const uploads = { verifyUploaded: vi.fn() };
    return {
      subject: new SubmissionPhotosService(
        db as never,
        uploads as never,
        {} as never,
        storage as never,
      ),
      storage,
      uploads,
    };
  }
  it.each([
    ['missing', null],
    ['foreign', { ...upload, actorId: randomUUID() }],
    ['wrong actor type', { ...upload, actorType: 'guest' }],
    ['wrong purpose', { ...upload, purpose: 'checkin_photo' }],
    ['oversized', { ...upload, contentLength: 10485761 }],
    ['zero bytes', { ...upload, contentLength: 0 }],
    ['unsupported type', { ...upload, contentType: 'image/heic' }],
    ['claimed', { ...upload, status: 'attached', attachedToId: randomUUID() }],
  ])('rejects %s before any storage call', async (_label, row) => {
    const h = service(row);
    await expect(h.subject.prepare(actor, [upload.id], null)).rejects.toMatchObject({
      code: 'INVALID_SUBMISSION_PHOTOS',
    });
    expect(h.storage.getObject).not.toHaveBeenCalled();
    expect(h.uploads.verifyUploaded).not.toHaveBeenCalled();
  });
  it('rejects duplicate ids and more than five ids', async () => {
    const h = service(null);
    for (const ids of [[upload.id, upload.id], Array.from({ length: 6 }, () => randomUUID())]) {
      await expect(h.subject.prepare(actor, ids, null)).rejects.toMatchObject({
        code: 'INVALID_SUBMISSION_PHOTOS',
      });
    }
  });
});

describe('explicit photo moderation', () => {
  const submissionId = randomUUID();
  const placeId = randomUUID();
  const adminId = randomUUID();
  const photo = {
    id: randomUUID(),
    storageKey: 'submission-photos/one.webp',
    mediaUploadId: randomUUID(),
    uploadedByUserId: randomUUID(),
    width: 60,
    height: 30,
  };
  function harness() {
    const insert = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
    const tx = { select: () => ({ from: () => ({ where: async () => [photo] }) }), insert, update };
    const cleanup = { enqueue: vi.fn().mockResolvedValue([]) };
    return {
      tx,
      cleanup,
      service: new SubmissionPhotosService({} as never, {} as never, cleanup as never, {} as never),
    };
  }
  it('refuses an old CMS approval before it writes any public photo', async () => {
    const h = harness();
    await expect(
      h.service.decide(h.tx as never, submissionId, placeId, adminId, 'checked'),
    ).rejects.toMatchObject({ code: 'PHOTO_REVIEW_REQUIRED' });
    expect(h.tx.insert).not.toHaveBeenCalled();
    expect(h.tx.update).not.toHaveBeenCalled();
  });
  it('refuses a photo from another submission', async () => {
    const h = harness();
    await expect(
      h.service.decide(h.tx as never, submissionId, placeId, adminId, 'checked', [randomUUID()]),
    ).rejects.toMatchObject({ code: 'INVALID_SUBMISSION_PHOTOS' });
    expect(h.tx.insert).not.toHaveBeenCalled();
  });
  it('an explicit empty selection retires every photo instead of publishing', async () => {
    const h = harness();
    await h.service.decide(h.tx as never, submissionId, placeId, adminId, 'checked', []);
    expect(h.tx.insert).not.toHaveBeenCalled();
    expect(h.cleanup.enqueue).toHaveBeenCalledWith(
      h.tx,
      [{ bucket: 'private', objectKey: photo.storageKey, reason: 'submission_photo_rejected' }],
      { delaySeconds: 604800 },
    );
  });
  it('approval retains the actual uploader id, never the submission owner', async () => {
    const h = harness();
    await h.service.decide(h.tx as never, submissionId, placeId, adminId, 'checked', [photo.id]);
    const values = h.tx.insert.mock.results[0]!.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId,
        storageKey: photo.storageKey,
        uploadedByUserId: photo.uploadedByUserId,
        moderation: 'approved',
        sourceType: 'community',
      }),
    );
    expect(h.cleanup.enqueue).not.toHaveBeenCalled();
  });
});

describe('concurrent retry attachment', () => {
  it('keeps the derivative already claimed by the first request and leaves the redundant one queued', async () => {
    const uploadId = randomUUID();
    const existing = [{ id: randomUUID(), mediaUploadId: uploadId, status: 'pending' }];
    const tx = {
      select: () => ({ from: () => ({ where: async () => existing }) }),
      insert: vi.fn(),
      delete: vi.fn(),
    };
    const uploads = { attach: vi.fn() };
    const subject = new SubmissionPhotosService(
      {} as never,
      uploads as never,
      {} as never,
      {} as never,
    );
    await subject.attach(
      tx as never,
      { type: 'user', id: randomUUID(), sessionId: randomUUID() },
      randomUUID(),
      {
        reusedIds: [],
        verified: {} as never,
        photos: [
          {
            upload: { id: uploadId } as never,
            key: 'submission-photos/redundant.webp',
            width: 60,
            height: 30,
            cleanupIds: [randomUUID()],
          },
        ],
      },
    );
    expect(uploads.attach).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });
});

describe('place-photo original storage', () => {
  it('presigns into the private tmp lifecycle and returns the media id', async () => {
    const id = randomUUID();
    const db = { insert: () => ({ values: () => ({ returning: async () => [{ id }] }) }) };
    const privateStorage = {
      presignUpload: vi.fn().mockResolvedValue({ url: 'https://private.test/put' }),
    };
    const publicStorage = { presignUpload: vi.fn() };
    const uploads = new UploadsService(
      db as never,
      privateStorage as never,
      publicStorage as never,
      true,
      true,
      true,
    );
    const actor = { type: 'user' as const, id: randomUUID(), sessionId: randomUUID() };
    const result = await uploads.createUpload(actor, {
      purpose: 'place_photo',
      contentType: 'image/jpeg',
      contentLength: 1000,
    });
    expect(result.id).toBe(id);
    expect(result.key).toMatch(new RegExp(`^tmp/place-photos/user/${actor.id}/[0-9a-f-]+\\.jpg$`));
    expect(privateStorage.presignUpload).toHaveBeenCalledWith(result.key, 'image/jpeg');
    expect(publicStorage.presignUpload).not.toHaveBeenCalled();
  });
});
