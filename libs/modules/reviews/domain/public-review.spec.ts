import { describe, expect, it } from 'vitest';
import { PLACE_REVIEW_PREVIEW_LIMIT, toPublicReview, type PublicReviewRow } from './public-review';

const row: PublicReviewRow = {
  id: '00000000-0000-4000-8000-000000000001',
  rating: 4,
  text: 'Ngon, phục vụ nhanh',
  createdAt: new Date('2026-09-14T05:00:00.000Z'),
  authorDisplayName: 'Lan',
  authorStatus: 'active',
  helpfulCount: 2,
};

describe('a public review carries facts a stranger may read, and nothing else', () => {
  it('keeps id, rating, text, date and the display name', () => {
    expect(toPublicReview(row)).toEqual({
      id: row.id,
      rating: 4,
      text: 'Ngon, phục vụ nhanh',
      createdAt: '2026-09-14T05:00:00.000Z',
      author: { displayName: 'Lan' },
      helpfulCount: 2,
    });
  });

  it('never grows an author field beyond the display name', () => {
    expect(Object.keys(toPublicReview(row).author)).toEqual(['displayName']);
  });

  it.each([null, '', '   '])('omits text that says nothing (%j)', (text) => {
    expect(toPublicReview({ ...row, text })).not.toHaveProperty('text');
  });

  it('drops the name of a deleted account but keeps the review (ADR-0023)', () => {
    const review = toPublicReview({
      ...row,
      authorDisplayName: 'Người dùng đã xóa',
      authorStatus: 'deleted',
    });
    expect(review.author.displayName).toBeNull();
    expect(review.rating).toBe(4);
  });

  it.each(['suspended', 'banned'] as const)(
    'does not invent a rule for a %s author — moderation acts per review',
    (authorStatus) => {
      expect(toPublicReview({ ...row, authorStatus }).author.displayName).toBe('Lan');
    },
  );

  it('previews three', () => {
    expect(PLACE_REVIEW_PREVIEW_LIMIT).toBe(3);
  });
});
