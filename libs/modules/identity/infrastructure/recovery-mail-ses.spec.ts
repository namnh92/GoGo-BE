import { describe, expect, it, vi } from 'vitest';
import { SesRecoveryMailSender, type RecoverySesConfig } from './recovery-mail-ses';
import { UnconfiguredRecoveryMailSender, type RecoveryMail } from './recovery-mail';

const config: RecoverySesConfig = {
  sender: 'recovery@example.com',
  region: 'ap-southeast-1',
  configurationSet: 'recovery-test',
};
const message: RecoveryMail = {
  email: 'recipient@example.com',
  challengeId: 'private-challenge',
  code: '012345',
  expiresAt: new Date('2026-11-06T12:05:00.000Z'),
};

describe('SES recovery mail adapter (injected client)', () => {
  it.each([
    [undefined, 'GoGo: Khôi phục mật khẩu', 'Mã khôi phục mật khẩu GoGo của bạn: 012345'],
    ['vi', 'GoGo: Khôi phục mật khẩu', 'Mã khôi phục mật khẩu GoGo của bạn: 012345'],
    ['en', 'GoGo: Reset your password', 'Your GoGo password recovery code: 012345'],
  ] as const)(
    'renders locale %s with a six-digit code and UTC expiry',
    async (locale, subject, body) => {
      const sendEmail = vi.fn().mockResolvedValue({ MessageId: 'not-retained' });
      const adapter = new SesRecoveryMailSender({ sendEmail }, config);
      await adapter.send({ ...message, ...(locale ? { locale } : {}) });
      expect(sendEmail).toHaveBeenCalledExactlyOnceWith({
        FromEmailAddress: config.sender,
        ConfigurationSetName: config.configurationSet,
        Destination: { ToAddresses: [message.email] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: {
                Data: expect.stringContaining(body),
                Charset: 'UTF-8',
              },
            },
          },
        },
      });
      const text = sendEmail.mock.calls[0]?.[0].Content.Simple.Body.Text.Data;
      expect(text).toContain('2026-11-06T12:05:00.000Z (UTC)');
      expect(text).not.toContain(message.challengeId);
      expect(text).not.toContain(message.email);
      expect(text).not.toContain('https://');
    },
  );

  it('does not send decoy work to SES', async () => {
    const sendEmail = vi.fn();
    await new SesRecoveryMailSender({ sendEmail }, config).send(null);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(['sender', 'region', 'configurationSet'] as const)(
    'refuses missing %s before sending real or decoy work',
    async (field) => {
      const sendEmail = vi.fn();
      const adapter = new SesRecoveryMailSender({ sendEmail }, { ...config, [field]: ' ' });
      expect(() => adapter.assertConfigured()).toThrow(
        expect.objectContaining({ code: 'RECOVERY_MAIL_NOT_CONFIGURED', httpStatus: 503 }),
      );
      for (const input of [message, null]) {
        await expect(adapter.send(input)).rejects.toMatchObject({
          code: 'RECOVERY_MAIL_NOT_CONFIGURED',
          httpStatus: 503,
          options: { retryable: false },
        });
      }
      expect(sendEmail).not.toHaveBeenCalled();
    },
  );

  it('discards provider error details and does not retry a code delivery', async () => {
    const providerError = new Error(`${message.email} ${message.code} ${message.challengeId}`);
    const sendEmail = vi.fn().mockRejectedValue(providerError);
    const adapter = new SesRecoveryMailSender({ sendEmail }, config);
    const error = await adapter.send(message).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'RECOVERY_UNAVAILABLE',
      httpStatus: 503,
      options: { retryable: true },
      cause: undefined,
    });
    expect(error).not.toBe(providerError);
    for (const secret of [message.email, message.code, message.challengeId]) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    }
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps disabled recovery fail-closed', async () => {
    await expect(new UnconfiguredRecoveryMailSender().send(message)).rejects.toMatchObject({
      code: 'RECOVERY_MAIL_NOT_CONFIGURED',
      httpStatus: 503,
      options: { retryable: false },
    });
  });
});
