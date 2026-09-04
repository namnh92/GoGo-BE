import { describe, expect, it } from 'vitest';
import { budgetLimitsFrom, operationEnvSuffix, unitsEnvKey } from './provider-budget.service';

/**
 * #335 — the pure half of the hard budget: how an environment becomes a set of
 * ceilings. The SQL half is exercised against a real Postgres in
 * `apps/api/test/provider-cost.int.spec.ts`, because the property under test
 * there — two concurrent callers cannot both take the last reservation — is
 * not a property a fake can have.
 */
describe('budgetLimitsFrom', () => {
  const env = {
    PLACE_REFRESH_DAILY_MAX_CALLS: '500',
    PLACE_REFRESH_DAILY_MAX_LIST_COST_USD: '2.50',
    PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_LIVENESS: '500',
    PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_CORE: '100',
  };

  it('reads the ceilings the plan names, and converts USD to micros once', () => {
    const limits = budgetLimitsFrom('google.places.refresh', env);
    expect(limits.maxCallsPerDay).toBe(500);
    // Dollars in the manifest because that is what an operator writes; micros
    // everywhere after, so nothing downstream has to remember the unit.
    expect(limits.maxListCostMicrosPerDay).toBe(2_500_000);
    expect(limits.maxUnitsByOperation).toEqual({
      'google.details.liveness': 500,
      'google.details.core': 100,
    });
  });

  it('treats an unset ceiling as null — which the guard reads as refuse', () => {
    const limits = budgetLimitsFrom('google.places.refresh', {});
    // Not "unlimited". An absent environment variable is the most likely way
    // this guard ever goes missing in production, and a guard that defaults
    // open is not a guard.
    expect(limits.maxCallsPerDay).toBeNull();
    expect(limits.maxListCostMicrosPerDay).toBeNull();
    expect(limits.maxUnitsByOperation).toEqual({});
  });

  it('refuses to read a negative or unparseable ceiling', () => {
    const limits = budgetLimitsFrom('google.places.refresh', {
      PLACE_REFRESH_DAILY_MAX_CALLS: '-1',
      PLACE_REFRESH_DAILY_MAX_LIST_COST_USD: 'plenty',
    });
    expect(limits.maxCallsPerDay).toBeNull();
    expect(limits.maxListCostMicrosPerDay).toBeNull();
  });

  it('ignores a unit ceiling naming an operation that does not exist', () => {
    const limits = budgetLimitsFrom('google.places.refresh', {
      PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALTY: '10',
    });
    // A typo must not silently create a ceiling for an operation nothing
    // emits, because the operation that *does* exist would then have none —
    // and no ceiling means refuse, so the typo would stop the job dead with a
    // reason nobody could read.
    expect(limits.maxUnitsByOperation).toEqual({});
  });

  it('keeps one scope’s ceilings out of another’s', () => {
    const limits = budgetLimitsFrom('google.places.import', env);
    expect(limits.maxCallsPerDay).toBeNull();
    expect(limits.maxUnitsByOperation).toEqual({});
  });

  it('maps an operation to its environment-variable name, both directions', () => {
    expect(operationEnvSuffix('google.details.liveness')).toBe('GOOGLE_DETAILS_LIVENESS');
    expect(unitsEnvKey('google.places.refresh', 'google.details.core')).toBe(
      'PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_CORE',
    );
  });
});
