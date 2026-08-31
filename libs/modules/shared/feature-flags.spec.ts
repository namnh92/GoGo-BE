import { describe, expect, it } from 'vitest';
import type { AppError } from './app-error';
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  flagDefinition,
  flagEnvironmentOf,
  overrideSpecificity,
  validateFlagValue,
} from './feature-flags';

describe('feature flag registry (BE-CMS-G3 #221)', () => {
  it('refuses a key nothing reads instead of storing it', () => {
    expect(() => flagDefinition('made.up.key')).toThrowError(/No such application flag/);
    expect(() => validateFlagValue('made.up.key', true)).toThrowError(/No such application flag/);
  });

  it('every registered key ships a default of its own declared type', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      const { valueType, defaultValue } = FEATURE_FLAGS[key];
      expect(defaultValue, key).not.toBeNull();
      if (valueType === 'boolean') expect(typeof defaultValue, key).toBe('boolean');
      if (valueType === 'number') expect(typeof defaultValue, key).toBe('number');
      if (valueType === 'version') expect(typeof defaultValue, key).toBe('string');
      if (valueType === 'json') expect(typeof defaultValue, key).toBe('object');
    }
  });

  describe('value validation', () => {
    it('accepts a well-formed version and rejects the near misses', () => {
      expect(validateFlagValue('minimum_app_version', '1.2.3')).toBe('1.2.3');
      expect(validateFlagValue('minimum_app_version', '1.2.3-beta.1')).toBe('1.2.3-beta.1');
      for (const bad of ['v1.2.3', '1.2', '1.2.3.4', '', 'latest', 3, null]) {
        expect(() => validateFlagValue('minimum_app_version', bad), String(bad)).toThrowError(
          /does not match its type/,
        );
      }
    });

    it('rejects a number that is not one, including NaN and a numeric string', () => {
      expect(validateFlagValue('recommendation_limit', 25)).toBe(25);
      expect(validateFlagValue('recommendation_limit', 0)).toBe(0);
      for (const bad of ['25', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
        expect(() => validateFlagValue('recommendation_limit', bad)).toThrowError(
          /does not match its type/,
        );
      }
    });

    it('takes a JSON object or array, not a scalar', () => {
      expect(validateFlagValue('place_import.rules', { minReviews: 3 })).toEqual({ minReviews: 3 });
      expect(() => validateFlagValue('place_import.rules', 'nope')).toThrowError();
      expect(() => validateFlagValue('place_import.rules', null)).toThrowError();
    });

    it('a boolean flag carries no separate value — `enabled` is the value', () => {
      expect(validateFlagValue('maintenance_mode', undefined)).toBeNull();
      // The reason lands on the field, which is what the console can point at.
      expect(() => validateFlagValue('maintenance_mode', true)).toThrowError(
        /does not match its type/,
      );
      try {
        validateFlagValue('maintenance_mode', true);
        expect.unreachable();
      } catch (err) {
        const error = err as AppError;
        expect(error.code).toBe('INVALID_FLAG_VALUE');
        expect(error.options.fieldErrors?.[0]?.message).toMatch(/set through `enabled`/);
      }
    });
  });

  describe('override precedence', () => {
    const target = { environment: 'production', platform: 'ios' } as const;

    it('prefers the most specific row that applies', () => {
      const exact = overrideSpecificity({ environment: 'production', platform: 'ios' }, target)!;
      const envOnly = overrideSpecificity({ environment: 'production', platform: 'all' }, target)!;
      const platformOnly = overrideSpecificity({ environment: 'all', platform: 'ios' }, target)!;
      const unscoped = overrideSpecificity({ environment: 'all', platform: 'all' }, target)!;
      expect(exact).toBeGreaterThan(envOnly);
      // Environment dominates: a production row is not overruled by an iOS row
      // belonging to some other environment.
      expect(envOnly).toBeGreaterThan(platformOnly);
      expect(platformOnly).toBeGreaterThan(unscoped);
    });

    it('does not apply a row scoped to something else', () => {
      expect(overrideSpecificity({ environment: 'staging', platform: 'all' }, target)).toBeNull();
      expect(overrideSpecificity({ environment: 'all', platform: 'android' }, target)).toBeNull();
    });
  });

  it('maps the deployment name onto the environment it configures', () => {
    expect(flagEnvironmentOf('prod')).toBe('production');
    expect(flagEnvironmentOf('production')).toBe('production');
    expect(flagEnvironmentOf('staging')).toBe('staging');
    expect(flagEnvironmentOf('dev')).toBe('dev');
    expect(flagEnvironmentOf('anything-else')).toBe('dev');
  });
});
