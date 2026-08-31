import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ACTIONS,
  ALLOWED_TRIGGERS,
  CONDITION_SCHEMAS,
  SAFETY_RULE_TYPES,
  SEVERITY_RANK,
  SUSPENSION_MIN_SEVERITY,
} from './safety-rule-conditions';

describe('safety rule conditions (BE-CMS-G4d #225)', () => {
  it('every rule type has a condition schema, allowed actions and allowed triggers', () => {
    for (const type of SAFETY_RULE_TYPES) {
      expect(CONDITION_SCHEMAS[type], type).toBeDefined();
      expect(ALLOWED_ACTIONS[type].length, type).toBeGreaterThan(0);
      expect(ALLOWED_TRIGGERS[type].length, type).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown key instead of storing something nothing reads', () => {
    const parsed = CONDITION_SCHEMAS.blocked_words.safeParse({
      terms: ['spam'],
      // The shape of a condition set is closed; a field the evaluator has no
      // code for would be configuration that silently does nothing.
      regex: '.*',
    });
    expect(parsed.success).toBe(false);
  });

  it('has no expression, script or callable field anywhere in the union', () => {
    // A condition language is how a console write becomes code execution. The
    // check is structural: no schema may accept a key that reads like one.
    const forbidden = ['expression', 'script', 'code', 'eval', 'js', 'formula', 'query'];
    for (const type of SAFETY_RULE_TYPES) {
      for (const key of forbidden) {
        const parsed = CONDITION_SCHEMAS[type].safeParse({ [key]: 'anything' });
        expect(parsed.success, `${type}.${key}`).toBe(false);
      }
    }
  });

  it('fills defaults so a stored rule is fully specified', () => {
    const parsed = CONDITION_SCHEMAS.blocked_words.parse({ terms: ['abc'] });
    expect(parsed).toEqual({ terms: ['abc'], matchMode: 'substring', caseSensitive: false });
  });

  it('needs a spam rule to actually test for something', () => {
    expect(CONDITION_SCHEMAS.spam.safeParse({ windowHours: 24 }).success).toBe(false);
    expect(CONDITION_SCHEMAS.spam.safeParse({ maxLinks: 3 }).success).toBe(true);
  });

  it('bounds every window and threshold rather than accepting any integer', () => {
    expect(
      CONDITION_SCHEMAS.rate_limit.safeParse({
        action: 'review_create',
        limit: 5,
        windowSeconds: 60,
      }).success,
    ).toBe(true);
    // An action outside the enumerated set, and a window long enough to be a
    // denial of service on the evaluator, are both refused.
    expect(
      CONDITION_SCHEMAS.rate_limit.safeParse({
        action: 'delete_everything',
        limit: 5,
        windowSeconds: 60,
      }).success,
    ).toBe(false);
    expect(
      CONDITION_SCHEMAS.rate_limit.safeParse({
        action: 'review_create',
        limit: 5,
        windowSeconds: 10_000_000,
      }).success,
    ).toBe(false);
    expect(CONDITION_SCHEMAS.repeated_reports.safeParse({ minReports: 1 }).success).toBe(false);
  });

  it('keeps automatic suspension away from rule types that are not about a person', () => {
    for (const type of ['blocked_words', 'spam', 'abusive_content', 'rate_limit'] as const) {
      expect(ALLOWED_ACTIONS[type], type).not.toContain('suspend_user');
    }
    for (const type of ['user_abuse', 'repeated_reports', 'review_abuse'] as const) {
      expect(ALLOWED_ACTIONS[type], type).toContain('suspend_user');
    }
    expect(SEVERITY_RANK[SUSPENSION_MIN_SEVERITY]).toBeGreaterThan(SEVERITY_RANK.medium);
  });
});
