import { describe, expect, it } from 'vitest';
import { budgetPerPerson, budgetTotal, isOverBudget } from './budget';

describe('budget math (core rule #4, FR-ROOM-004)', () => {
  const vnd = { currency: 'VND' } as const;

  it('total mode passes through; per_person multiplies', () => {
    expect(budgetTotal({ mode: 'total', amount: 500_000, ...vnd }, 4)).toBe(500_000);
    expect(budgetTotal({ mode: 'per_person', amount: 125_000, ...vnd }, 4)).toBe(500_000);
  });

  it('per-person from total uses floor so the total is never exceeded', () => {
    expect(budgetPerPerson({ mode: 'total', amount: 500_000, ...vnd }, 3)).toBe(166_666);
    expect(budgetPerPerson({ mode: 'per_person', amount: 125_000, ...vnd }, 3)).toBe(125_000);
    // floor guarantee: perPerson * n <= total
    expect(166_666 * 3).toBeLessThanOrEqual(500_000);
  });

  it('over-budget uses the upper bound (FR-SUG-006)', () => {
    const budget = { mode: 'per_person' as const, amount: 100_000, ...vnd };
    expect(isOverBudget(400_000, budget, 4)).toBe(false); // == total
    expect(isOverBudget(400_001, budget, 4)).toBe(true);
  });

  it('rejects invalid amounts and counts', () => {
    expect(() => budgetTotal({ mode: 'total', amount: -1, ...vnd }, 2)).toThrow();
    expect(() => budgetTotal({ mode: 'total', amount: 1.5, ...vnd }, 2)).toThrow();
    expect(() => budgetPerPerson({ mode: 'total', amount: 100, ...vnd }, 0)).toThrow();
  });
});
