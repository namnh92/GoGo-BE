import { describe, expect, it, vi } from 'vitest';
import { SubmissionPhotoService } from './submission-photo.service';

const photo = {
  contentType: 'image/jpeg',
  dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
  widthPx: 100,
  heightPx: 100,
  authorAttributions: [{ displayName: 'Lan', uri: null, photoUri: null }],
  googleMapsUri: 'https://www.google.com/maps/photo/one',
};
function setup() {
  const events: string[] = [];
  const deleted = vi.fn();
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => {
        events.push('intent');
        return { returning: async () => [{ id: 'cleanup' }] };
      }),
    })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    delete: vi.fn(() => ({
      where: async () => {
        deleted();
      },
    })),
  };
  const photos = { firstForProvider: vi.fn(async () => ({ status: 'ok', photos: [photo] })) };
  const storage = {
    putObject: vi.fn(async () => {
      events.push('upload');
    }),
    deleteObject: vi.fn(async () => undefined),
  };
  return {
    events,
    db,
    photos,
    storage,
    service: new SubmissionPhotoService(db as never, photos as never, storage as never, true),
  };
}

describe('approved provider photo storage (#786)', () => {
  it('writes durable compensation before upload and retains provider identity and structured credits', async () => {
    const { service, events, storage } = setup();
    const prepared = await service.prepare('ChIJ-test');
    expect(events).toEqual(['intent', 'upload']);
    expect(prepared?.metadata).toMatchObject({
      provider: 'google',
      sourceReference: 'ChIJ-test',
      authorAttributions: photo.authorAttributions,
    });
    expect(storage.putObject).toHaveBeenCalledWith(
      expect.stringMatching(/^places\/provider\/.*\.jpg$/),
      Buffer.from([1, 2, 3]),
      'image/jpeg',
      expect.objectContaining({ cacheControl: 'public, max-age=31536000, immutable' }),
    );
  });

  it('empty/disabled provider result makes no storage or database write', async () => {
    const { service, db, photos, storage } = setup();
    photos.firstForProvider.mockResolvedValue({ status: 'disabled', photos: [] });
    expect(await service.prepare('ChIJ-test')).toBeUndefined();
    expect(db.insert).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('upload failure refuses approval and cleanup failure leaves durable intent for the worker', async () => {
    const { service, db, storage } = setup();
    storage.putObject.mockRejectedValue(new Error('partial upload'));
    storage.deleteObject.mockRejectedValue(new Error('storage down'));
    await expect(service.prepare('ChIJ-test')).rejects.toMatchObject({
      code: 'SUBMISSION_PHOTO_UNAVAILABLE',
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('compensation preserves any media that actually committed', async () => {
    const { service, db, storage } = setup();
    const prepared = await service.prepare('ChIJ-test');
    db.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'live' }] }) }),
    } as never);
    await service.discard(prepared!);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('transaction rollback compensation deletes unreferenced bytes and its intent', async () => {
    const { service, db, storage } = setup();
    const prepared = await service.prepare('ChIJ-test');
    await service.discard(prepared!);
    expect(storage.deleteObject).toHaveBeenCalledWith(prepared!.key, expect.any(Object));
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

describe('approval photo availability (#786)', () => {
  it.each(['budget_exhausted', 'unavailable'])(
    'refuses approval retryably on %s',
    async (status) => {
      const { service, photos, db, storage } = setup();
      photos.firstForProvider.mockResolvedValue({ status, photos: [] });
      await expect(service.prepare('ChIJ-test')).rejects.toMatchObject({
        code: 'SUBMISSION_PHOTO_UNAVAILABLE',
        options: { retryable: true },
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
    },
  );

  it('confirmed no photo permits approval without storage', async () => {
    const { service, photos, db } = setup();
    photos.firstForProvider.mockResolvedValue({ status: 'ok', photos: [] });
    expect(await service.prepare('ChIJ-test')).toBeUndefined();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('missing catalogue storage refuses approval when a provider photo exists', async () => {
    const { db, photos, storage } = setup();
    const service = new SubmissionPhotoService(
      db as never,
      photos as never,
      storage as never,
      false,
    );
    await expect(service.prepare('ChIJ-test')).rejects.toMatchObject({
      code: 'SUBMISSION_PHOTO_UNAVAILABLE',
      options: { retryable: true },
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
