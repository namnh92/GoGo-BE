import { describe, expect, it, vi } from 'vitest';
import { MediaCleanupService } from './media-cleanup.service';

describe('media cleanup live provider image guard (#786)', () => {
  it('skips deleting an object referenced by place_media even without a live avatar', async () => {
    const row = { id: 'cleanup', bucket: 'public', objectKey: 'places/provider/photo.jpg' };
    const results = [[row], [], [{ id: 'photo' }]];
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => results.shift() }) }) }),
      delete: vi.fn(() => ({ where: async () => undefined })),
    };
    const storage = { deleteObject: vi.fn() };
    const cleanup = new MediaCleanupService(
      db as never,
      { private: storage, public: storage } as never,
      {} as never,
      'https://assets.test',
    );
    await cleanup.attemptNow(['cleanup']);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});
