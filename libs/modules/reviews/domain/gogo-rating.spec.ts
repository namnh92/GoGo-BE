import { describe, expect, it } from 'vitest';
import { GOGO_RATING_MIN_SAMPLE, gogoRatingOutcome, toGogoRating } from './gogo-rating';

describe('GoGo community rating threshold (#217, ADR-0028)', () => {
  it('is five published reviews, inclusive', () => {
    expect(GOGO_RATING_MIN_SAMPLE).toBe(5);
  });

  it.each([0, 1, 4])('omits the score at %i reviews and keeps the count', (count) => {
    const facts = toGogoRating(count, count === 0 ? null : '4.5');
    expect(facts).toEqual({ gogoRatingCount: count });
    expect(facts).not.toHaveProperty('gogoRating');
    expect(gogoRatingOutcome(facts)).toBe('insufficient');
  });

  it.each([
    [5, '4.2', 4.2],
    [6, '3.0', 3],
    [8, '4.3', 4.3],
  ])('returns score and count at %i reviews, as numbers', (count, mean, score) => {
    const facts = toGogoRating(count, mean);
    expect(facts).toEqual({ gogoRating: score, gogoRatingCount: count });
    expect(typeof facts.gogoRating).toBe('number');
    expect(gogoRatingOutcome(facts)).toBe('available');
  });

  it('refuses a population above the threshold with no mean, rather than inventing one', () => {
    expect(() => toGogoRating(5, null)).toThrow();
    expect(() => toGogoRating(5, 'NaN')).toThrow();
  });

  it('refuses a count that is not a non-negative integer', () => {
    expect(() => toGogoRating(-1, null)).toThrow();
    expect(() => toGogoRating(2.5, null)).toThrow();
    expect(() => toGogoRating(undefined, null)).toThrow();
  });
});
