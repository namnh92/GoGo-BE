import { describe, expect, it } from 'vitest';
import { reactionRefusal } from './review-reaction';

const author = '00000000-0000-4000-8000-00000000000a';
const reader = '00000000-0000-4000-8000-00000000000b';

describe('who may mark a review helpful (ADR-0026 proposal)', () => {
  it('lets another account react to a published review', () => {
    expect(reactionRefusal({ userId: author, status: 'published' }, reader)).toBeNull();
  });

  it.each(['pending', 'rejected', 'removed', 'hidden'])(
    'answers a %s review exactly like a missing one',
    (status) => {
      expect(reactionRefusal({ userId: author, status }, reader)).toBe('REVIEW_NOT_FOUND');
    },
  );

  it('answers a review that is not there (or not on a readable place) as not found', () => {
    expect(reactionRefusal(undefined, reader)).toBe('REVIEW_NOT_FOUND');
  });

  it('refuses a reaction to your own review', () => {
    expect(reactionRefusal({ userId: author, status: 'published' }, author)).toBe('OWN_REVIEW');
  });

  it('does not reveal authorship of an unpublished review either', () => {
    expect(reactionRefusal({ userId: author, status: 'hidden' }, author)).toBe('REVIEW_NOT_FOUND');
  });
});
