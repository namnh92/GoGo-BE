import { describe, expect, it } from 'vitest';
import { CmsPlaceMediaService } from './cms-place-media.service';

// This guard runs before any mutation: an editor can reorder a provider photo,
// but cannot turn a required provider credit into an empty or editorial label.
describe('provider media credits (#786)', () => {
  it.each(['google_derived', 'provider'])(
    'refuses removing attribution on %s media',
    async (sourceType) => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                { sourceType, attribution: 'Google Maps', providerPhoto: { provider: 'google' } },
              ],
            }),
          }),
        }),
      };
      const service = new CmsPlaceMediaService(db as never, {} as never);
      await expect(
        service.update({ id: 'editor' } as never, 'place', 'media', { attribution: null }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ATTRIBUTION_IMMUTABLE' });
    },
  );
});
