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
    [undefined, 'Mã khôi phục mật khẩu GoGo', 'Mã khôi phục của bạn: 012345'],
    ['vi', 'Mã khôi phục mật khẩu GoGo', 'Mã khôi phục của bạn: 012345'],
    ['en', 'Your GoGo password reset code', 'Your password reset code: 012345'],
  ] as const)(
    'renders locale %s with multipart content, a six-digit code and Vietnam expiry',
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
              Html: { Data: expect.stringContaining(message.code), Charset: 'UTF-8' },
              Text: {
                Data: expect.stringContaining(body),
                Charset: 'UTF-8',
              },
            },
          },
        },
      });
      const { Html, Text } = sendEmail.mock.calls[0]![0].Content.Simple.Body;
      const expiry =
        locale === 'en'
          ? '07:05 PM, November 6, 2026 (Vietnam time, UTC+7)'
          : '19:05, 06/11/2026 (giờ Việt Nam)';
      for (const content of [Html.Data, Text.Data]) {
        expect(content).toContain(message.code);
        expect(content).toContain(expiry);
        expect(content).not.toContain(message.challengeId);
        expect(content).not.toContain(message.email);
        expect(content).not.toMatch(/<a\b/i);
        for (const match of content.matchAll(/(?:href|src)="([^"]*)"/g)) {
          for (const secret of [message.code, message.email, message.challengeId]) {
            expect(match[1]).not.toContain(secret);
          }
        }
        expect(content).not.toContain('2026-11-06T12:05:00.000Z');
      }
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
