import { describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { UserContentService } from './user-content.service';

const user = {
  type: 'user',
  id: 'a3f1c2d4-0000-4000-8000-000000000001',
  sessionId: 'session-1',
} as const;
const reviewId = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';

function serviceFor(row: { id: string; userId: string; rating: number; status: 'pending' }) {
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) =>
        table === schema.reviews
          ? { returning: async () => [{ ...row, ...values }] }
          : Promise.resolve(),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [row] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...row, ...values }] }),
      }),
    }),
  };
  return new UserContentService(db as never, {} as never, {} as never, null);
}

describe('UserContentService review mutation responses (#751)', () => {
  it('returns the stored rating when a review is created', async () => {
    const service = serviceFor({ id: reviewId, userId: user.id, rating: 5, status: 'pending' });

    await expect(service.createReview(user, { planId: reviewId, rating: 5 })).resolves.toEqual({
      id: reviewId,
      rating: 5,
      status: 'pending',
    });
  });

  it('returns the current rating when an edit does not change it', async () => {
    const service = serviceFor({ id: reviewId, userId: user.id, rating: 4, status: 'pending' });

    await expect(service.updateReview(user, reviewId, { text: 'Vẫn rất ổn' })).resolves.toEqual({
      id: reviewId,
      rating: 4,
      status: 'pending',
    });
  });
});
