import { describe, expect, it } from 'vitest';
import { isProductionAppEnv, seedAdminConfig } from './seed-admin-config';

/**
 * DB-012. The property under test is the one that used to be false: with no
 * credentials configured there is no account, and in particular no account with
 * a password this repository knows.
 */
describe('seed admin credentials', () => {
  it('creates no account when nothing is configured', () => {
    expect(seedAdminConfig({})).toBeNull();
  });

  it('never returns a value the environment did not supply', () => {
    // The defect this replaces was a `?? 'literal'` fallback: absent input,
    // present output. Stated as a property it cannot come back in a shape the
    // test does not recognise — anything returned must have been passed in.
    for (const email of ['a@example.invalid', 'b@example.invalid']) {
      for (const password of ['pw-one', 'pw-two']) {
        const result = seedAdminConfig({
          APP_ENV: 'dev',
          SEED_ADMIN_EMAIL: email,
          SEED_ADMIN_PASSWORD: password,
        });
        expect(result).toEqual({ email, password });
      }
    }
  });

  it.each([
    ['email only', { SEED_ADMIN_EMAIL: 'test@example.invalid' }],
    ['password only', { SEED_ADMIN_PASSWORD: 'test-only-value' }],
  ])('rejects partial configuration (%s) before any database work', (_label, env) => {
    expect(() => seedAdminConfig(env)).toThrow(
      'SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be configured',
    );
  });

  it('never puts a credential in the error it throws', () => {
    const secret = 'unmistakable-secret-value';
    expect(() => seedAdminConfig({ SEED_ADMIN_PASSWORD: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
    expect(() =>
      seedAdminConfig({
        APP_ENV: 'prod',
        SEED_ADMIN_EMAIL: 'test@example.invalid',
        SEED_ADMIN_PASSWORD: secret,
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) }));
  });

  it.each(['prod', 'production'])('refuses %s without an explicit confirmation', (APP_ENV) => {
    expect(() =>
      seedAdminConfig({
        APP_ENV,
        SEED_ADMIN_EMAIL: 'test@example.invalid',
        SEED_ADMIN_PASSWORD: 'test-only-value',
      }),
    ).toThrow(`refusing to bootstrap a ${APP_ENV} CMS admin without SEED_ADMIN_CONFIRM=${APP_ENV}`);
  });

  it('does not accept a confirmation naming a different environment', () => {
    // A command line copied from staging must not provision production.
    expect(() =>
      seedAdminConfig({
        APP_ENV: 'prod',
        SEED_ADMIN_CONFIRM: 'staging',
        SEED_ADMIN_EMAIL: 'test@example.invalid',
        SEED_ADMIN_PASSWORD: 'test-only-value',
      }),
    ).toThrow(/SEED_ADMIN_CONFIRM=prod/);
  });

  it('allows production when the confirmation names it', () => {
    expect(
      seedAdminConfig({
        APP_ENV: 'prod',
        SEED_ADMIN_CONFIRM: 'prod',
        SEED_ADMIN_EMAIL: 'test@example.invalid',
        SEED_ADMIN_PASSWORD: 'test-only-value',
      }),
    ).toEqual({ email: 'test@example.invalid', password: 'test-only-value' });
  });

  it.each(['dev', 'staging', undefined])(
    'needs no confirmation outside production (APP_ENV=%s)',
    (APP_ENV) => {
      expect(
        seedAdminConfig({
          ...(APP_ENV === undefined ? {} : { APP_ENV }),
          SEED_ADMIN_EMAIL: 'test@example.invalid',
          SEED_ADMIN_PASSWORD: 'test-only-value',
        }),
      ).toEqual({ email: 'test@example.invalid', password: 'test-only-value' });
    },
  );

  it('trims the email but never the password', () => {
    // A trimmed password silently changes the credential the operator stored,
    // and the account it then creates cannot be signed in to with the value in
    // SSM. Surrounding whitespace in an email is a copy-paste artefact.
    expect(
      seedAdminConfig({
        APP_ENV: 'dev',
        SEED_ADMIN_EMAIL: '  test@example.invalid  ',
        SEED_ADMIN_PASSWORD: ' test-only-value ',
      }),
    ).toEqual({ email: 'test@example.invalid', password: ' test-only-value ' });
  });

  it('does not accept a whitespace-only email as a configured value', () => {
    expect(() =>
      seedAdminConfig({ APP_ENV: 'dev', SEED_ADMIN_EMAIL: '   ', SEED_ADMIN_PASSWORD: 'pw' }),
    ).toThrow('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be configured');

    // Blank on its own is nothing configured at all, which is the no-account
    // path rather than the misconfiguration path.
    expect(seedAdminConfig({ SEED_ADMIN_EMAIL: '   ' })).toBeNull();
  });
});

describe('isProductionAppEnv', () => {
  it.each(['prod', 'production'])('%s is production', (env) => {
    expect(isProductionAppEnv(env)).toBe(true);
  });

  it.each(['dev', 'staging', 'Prod', 'preprod', '', undefined])('%s is not production', (env) => {
    expect(isProductionAppEnv(env)).toBe(false);
  });
});
