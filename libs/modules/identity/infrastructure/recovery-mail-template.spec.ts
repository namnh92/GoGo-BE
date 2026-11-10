import { describe, expect, it } from 'vitest';
import { recoveryMailColors as colors, renderRecoveryMail } from './recovery-mail-template';

const sample = { code: '482913', expiresAt: new Date('2026-11-10T08:01:00.000Z') };

describe('recovery mail template (#837)', () => {
  it.each([
    ['vi', 'Mã khôi phục mật khẩu GoGo', '15:01, 10/11/2026 (giờ Việt Nam)'],
    ['en', 'Your GoGo password reset code', '03:01 PM, November 10, 2026 (Vietnam time, UTC+7)'],
  ] as const)('renders %s with the same content in HTML and text', (locale, subject, expiry) => {
    const mail = renderRecoveryMail({ ...sample, locale });
    expect(mail.subject).toBe(subject);
    for (const content of [mail.html, mail.text]) {
      expect(content).toContain(sample.code);
      expect(content).toContain(expiry);
      expect(content).not.toMatch(/http|<img|<a\b/i);
    }
    // Every visible HTML phrase is also present in the plain-text fallback.
    const visible = mail.html.slice(mail.html.indexOf('<table'));
    for (const match of visible.matchAll(/>([^<>]+)</g)) {
      const phrase = match[1]!.trim();
      if (phrase) expect(mail.text).toContain(phrase);
    }
    expect(mail.html).toContain(`<html lang="${locale}">`);
    expect(mail.html).toMatch(/<meta name="color-scheme" content="light"\s*\/?>/);
    expect(mail.html).toContain('max-width:560px');
    expect(mail.html).toContain('letter-spacing:6px');
    const preheader = mail.html.match(/<div[^>]+>(.*?)<\/div>/s)?.[1]?.trim();
    expect(preheader).toBe(
      locale === 'vi'
        ? 'Sử dụng mã xác nhận để khôi phục mật khẩu GoGo.'
        : 'Use your verification code to reset your GoGo password.',
    );
    expect(preheader).not.toContain(sample.code);
    expect(mail.text).toContain(
      locale === 'vi'
        ? 'Không chia sẻ mã này với bất kỳ ai.'
        : 'Do not share this code with anyone.',
    );
    expect(mail.text).toContain(
      locale === 'vi'
        ? 'Nếu bạn không yêu cầu khôi phục mật khẩu, hãy bỏ qua email này.'
        : 'If you did not request a password reset, ignore this email.',
    );
    expect(mail.text).toContain(
      locale === 'vi'
        ? 'Đây là email tự động. Vui lòng không trả lời.'
        : 'This is an automated email. Please do not reply.',
    );
  });

  it('defaults to Vietnamese and does not mutate its input', () => {
    const input = Object.freeze({ ...sample });
    expect(renderRecoveryMail(input)).toEqual(renderRecoveryMail({ ...sample, locale: 'vi' }));
    expect(input.expiresAt.toISOString()).toBe('2026-11-10T08:01:00.000Z');
  });

  it.each([
    ['vi', '00:01, 01/01/2027 (giờ Việt Nam)'],
    ['en', '12:01 AM, January 1, 2027 (Vietnam time, UTC+7)'],
  ] as const)(
    'uses Vietnam calendar rollover for %s, independent of host timezone',
    (locale, expiry) => {
      const mail = renderRecoveryMail({
        ...sample,
        locale,
        expiresAt: new Date('2026-12-31T17:01:00Z'),
      });
      expect(mail.html).toContain(expiry);
      expect(mail.text).toContain(expiry);
    },
  );

  it('escapes all HTML metacharacters without changing plain text', () => {
    const code = `<script>"'&</script>`;
    const mail = renderRecoveryMail({ ...sample, code });
    expect(mail.html).toContain('&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;');
    expect(mail.html).not.toContain(code);
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain(code);
  });

  it('keeps every text/background pairing above WCAG AA 4.5:1', () => {
    function luminance(hex: string): number {
      const rgb = hex
        .slice(1)
        .match(/../g)!
        .map((part) => {
          const value = parseInt(part, 16) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    }
    for (const [foreground, background] of [
      [colors.canvas, colors.brand],
      [colors.text, colors.card],
      [colors.secondary, colors.card],
      [colors.secondary, colors.canvas],
      [colors.accent, colors.accentSoft],
    ]) {
      const pair = [luminance(foreground!), luminance(background!)].sort((a, b) => b - a);
      expect((pair[0]! + 0.05) / (pair[1]! + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
