import { describe, expect, it } from 'vitest';
import { validateFeedback, type FeedbackContext } from './feedback';

const context: FeedbackContext = {
  allowedPlaceIds: ['11111111-1111-4111-8111-111111111111'],
  knownCategoryKeys: ['cafe', 'bar'],
  knownDietaryKeys: ['vegetarian'],
  budgetAmount: 400_000,
  radiusM: 5000,
  currentStopCount: 4,
};

/**
 * SG-009 (#48) — the boundary an AI proposal has to get through. Everything
 * here is a way a model can be wrong, and what happens to it.
 */
describe('validateFeedback', () => {
  it('accepts a proposal that stays inside the constraints', () => {
    const result = validateFeedback(
      {
        excludePlaceIds: ['11111111-1111-4111-8111-111111111111'],
        avoidCategoryKeys: ['bar'],
        requireDietaryKeys: [],
        tightenBudgetPercent: 25,
      },
      context,
    );
    expect(result.understood).toBe(true);
    expect(result.applied.budgetMaxAmount).toBe(300_000);
    expect(result.rejected).toEqual([]);
  });

  it('drops a place id that was never a candidate', () => {
    const result = validateFeedback(
      { excludePlaceIds: ['99999999-9999-4999-8999-999999999999'] },
      context,
    );
    // The shape of a hallucination: nothing invents a place.
    expect(result.applied.excludePlaceIds).toEqual([]);
    expect(result.rejected).toContain('PLACE_NOT_A_CANDIDATE');
  });

  it('drops a category the room has no candidates for', () => {
    const result = validateFeedback({ avoidCategoryKeys: ['nightclub'] }, context);
    expect(result.applied.avoidCategoryKeys).toEqual([]);
    expect(result.rejected).toContain('CATEGORY_UNKNOWN');
  });

  it('never raises the budget the room agreed on', () => {
    // A percentage below 1 is already out of schema; the guard here is that
    // even a schema-valid figure must land strictly below the current budget.
    const result = validateFeedback({ tightenBudgetPercent: 50 }, context);
    expect(result.applied.budgetMaxAmount).toBe(200_000);
    expect(result.applied.budgetMaxAmount!).toBeLessThan(context.budgetAmount);
  });

  it('refuses to widen a radius or invent one where none is set', () => {
    expect(validateFeedback({ reduceRadiusPercent: 40 }, context).applied.radiusM).toBe(3000);
    const noRadius = validateFeedback({ reduceRadiusPercent: 40 }, { ...context, radiusM: null });
    expect(noRadius.applied.radiusM).toBeUndefined();
    expect(noRadius.rejected).toContain('RADIUS_NOT_REDUCED');
  });

  it('only ever removes stops, never adds them', () => {
    expect(validateFeedback({ maxStops: 2 }, context).applied.maxStops).toBe(2);
    // "Make it longer" is a plan edit, not feedback — it goes through the
    // host's own editing path where the constraints are re-checked.
    const longer = validateFeedback({ maxStops: 6 }, context);
    expect(longer.applied.maxStops).toBeUndefined();
    expect(longer.rejected).toContain('STOPS_NOT_REDUCED');
  });

  it('rejects output that is not the agreed shape', () => {
    for (const bad of [null, 'sure thing!', { excludePlaceIds: 'not-an-array' }, 42]) {
      const result = validateFeedback(bad, context);
      expect(result.rejected).toEqual(['SCHEMA_INVALID']);
      expect(result.understood).toBe(false);
    }
  });

  it('rejects extra keys rather than ignoring them', () => {
    // A model inventing a field it would like to control is exactly the case
    // a permissive schema would wave through.
    const result = validateFeedback({ excludePlaceIds: [], setBudgetTo: 9_000_000 }, context);
    expect(result.rejected).toEqual(['SCHEMA_INVALID']);
  });

  it('says nothing was understood rather than silently applying nothing', () => {
    const result = validateFeedback({}, context);
    expect(result.understood).toBe(false);
    expect(result.rejected).toContain('NOTHING_UNDERSTOOD');
  });
});
