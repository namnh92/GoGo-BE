import { describe, expect, it } from 'vitest';
import type { IdentityConfig } from '../../shared/config';
import { recoveryMailSenderFor } from './identity.module';
import { RecoveryMailSink, UnconfiguredRecoveryMailSender } from '../infrastructure/recovery-mail';
import { SesRecoveryMailSender } from '../infrastructure/recovery-mail-ses';

describe('recovery mail selection (#777)', () => {
  const config = {
    NODE_ENV: 'development',
    APP_ENV: 'dev',
    AUTH_RECOVERY_MAIL_ADAPTER: 'ses',
    AUTH_RECOVERY_KEY: 'r'.repeat(48),
    AUTH_RECOVERY_MAIL_SENDER: 'recovery@example.com',
    AUTH_RECOVERY_MAIL_REGION: 'ap-southeast-1',
    AUTH_RECOVERY_MAIL_CONFIGURATION_SET: 'recovery-test',
  } as IdentityConfig;

  it.each(['dev', 'staging', 'prod', 'production'] as const)(
    'selects SES with the same SDK credential mechanism in %s',
    (APP_ENV) => {
      const sender = recoveryMailSenderFor({ ...config, APP_ENV, NODE_ENV: 'production' });
      expect(sender).toBeInstanceOf(SesRecoveryMailSender);
      expect(sender.adapter).toBe('ses');
      expect(() => sender.assertConfigured()).not.toThrow();
    },
  );

  it.each([
    'AUTH_RECOVERY_KEY',
    'AUTH_RECOVERY_MAIL_SENDER',
    'AUTH_RECOVERY_MAIL_REGION',
    'AUTH_RECOVERY_MAIL_CONFIGURATION_SET',
  ] as const)('never falls back to sink when SES lacks %s', (name) => {
    const sender = recoveryMailSenderFor({ ...config, [name]: '' });
    expect(sender).toBeInstanceOf(UnconfiguredRecoveryMailSender);
    expect(() => sender.assertConfigured()).toThrow(
      expect.objectContaining({ code: 'RECOVERY_MAIL_NOT_CONFIGURED' }),
    );
  });

  it('keeps disabled as default and sink restricted to dev', () => {
    expect(
      recoveryMailSenderFor({ ...config, AUTH_RECOVERY_MAIL_ADAPTER: 'disabled' }),
    ).toBeInstanceOf(UnconfiguredRecoveryMailSender);
    expect(recoveryMailSenderFor({ ...config, AUTH_RECOVERY_MAIL_ADAPTER: 'sink' })).toBeInstanceOf(
      RecoveryMailSink,
    );
    expect(
      recoveryMailSenderFor({ ...config, AUTH_RECOVERY_MAIL_ADAPTER: 'sink', APP_ENV: 'prod' }),
    ).toBeInstanceOf(UnconfiguredRecoveryMailSender);
  });
});
