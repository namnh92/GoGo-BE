import { describe, expect, it } from 'vitest';
import { decodeReviewCursor, encodeReviewCursor, shapeReviewPage } from './place-reviews.service';

const cursor = {
  order: 'helpful' as const,
  helpfulCount: 12,
  createdAt: '2026-11-05T08:00:00.000900Z',
  id: '00000000-0000-4000-8000-000000000012',
};

const encodeState = (state: unknown) => Buffer.from(JSON.stringify(state)).toString('base64url');

describe('place review cursor (#754)', () => {
  it('round-trips every helpful-order tie breaker', () => {
    expect(decodeReviewCursor(encodeReviewCursor(cursor), 'helpful')).toEqual(cursor);
  });

  it('cannot be reused under another order', () => {
    expect(() => decodeReviewCursor(encodeReviewCursor(cursor), 'latest')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });

  it.each(['not-base64', Buffer.from('{}').toString('base64url')])(
    'refuses malformed state (%s)',
    (value) => {
      expect(() => decodeReviewCursor(value, 'latest')).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURSOR' }),
      );
    },
  );

  it.each([
    ['a non-string timestamp', 0],
    ['an impossible calendar date', '2026-02-30T08:00:00.000900Z'],
  ])('refuses %s before it reaches PostgreSQL', (_label, createdAt) => {
    expect(() =>
      decodeReviewCursor(encodeState({ ...cursor, order: 'latest', createdAt }), 'latest'),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
});

describe('place review response compatibility (#754)', () => {
  const page = [1, 2, 3, 4, 5];

  it('keeps the legacy reviews property capped at three rows', () => {
    expect(shapeReviewPage(page, false)).toEqual({ reviews: [1, 2, 3] });
  });

  it('adds the complete page on the optional items property', () => {
    expect(shapeReviewPage(page, true)).toEqual({
      reviews: [1, 2, 3],
      items: page,
    });
  });
});
