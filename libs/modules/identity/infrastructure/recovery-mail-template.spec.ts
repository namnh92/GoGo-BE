import { describe, expect, it } from 'vitest';
import { recoveryMailColors as colors, renderRecoveryMail } from './recovery-mail-template';

const sample = { code: '482913', expiresAt: new Date('2026-11-10T08:01:00.000Z') };

describe('recovery mail template (#837, #839)', () => {
  it.each([
    ['vi', 'Mã khôi phục mật khẩu GoGo', '15:01, 10/11/2026 (giờ Việt Nam)'],
    ['en', 'Your GoGo password reset code', '03:01 PM, November 10, 2026 (Vietnam time, UTC+7)'],
  ] as const)('renders %s with the same content in HTML and text', (locale, subject, expiry) => {
    const mail = renderRecoveryMail({ ...sample, locale });
    expect(mail.subject).toBe(subject);
    for (const content of [mail.html, mail.text]) {
      expect(content).toContain(sample.code);
      expect(content).toContain(expiry);
    }
    // Store placeholders are HTML-only; other visible phrases also occur in text.
    const visible = mail.html.slice(mail.html.indexOf('<table'));
    for (const match of visible.matchAll(/>([^<>]+)</g)) {
      const phrase = match[1]!.trim();
      if (phrase && !/^(Sắp có trên|Coming soon on) /.test(phrase)) {
        expect(mail.text).toContain(phrase);
      }
    }
    expect(mail.html).toContain(`<html lang="${locale}">`);
    expect(mail.html).toMatch(/<meta name="color-scheme" content="light"\s*\/?>/);
    expect(mail.html).toContain('max-width:560px');
    expect(mail.html).toContain('white-space:nowrap');
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

  it.each(['vi', 'en'] as const)(
    'provides a mobile layout and an inline fallback in %s',
    (locale) => {
      const { html } = renderRecoveryMail(
        { ...sample, locale },
        {
          appStore: 'https://apps.apple.com/app/id123456',
          googlePlay: 'https://play.google.com/store/apps/details?id=vn.gogo',
        },
      );
      expect(html).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      );
      expect(html).toContain('<meta name="x-apple-disable-message-reformatting" />');
      expect(html).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?padding:\s*12px 8px !important/);
      expect(html).toMatch(/@media \(max-width:\s*479px\)[\s\S]*?\.store-column/);
      expect(html).toMatch(/font-size:\s*28px !important;\s*letter-spacing:\s*2px !important;/);

      // Gmail clients may remove head CSS: the base layout must still fit at 320px.
      const inline = html.replace(/<style>[\s\S]*?<\/style>/g, '');
      expect(inline).not.toContain('width="560"');
      expect(inline).toContain('width:100%;max-width:560px');
      expect(inline).toContain('width:120px;max-width:100%;height:auto;');
      const codeStyle = inline.match(/class="recovery-code"\s+dir="ltr"\s+style="([^"]+)"/)![1]!;
      const fontSize = Number(codeStyle.match(/font-size:(\d+)px/)![1]);
      const spacing = Number(codeStyle.match(/letter-spacing:(\d+)px/)![1]);
      // Conservative full-em digit widths, plus spacing, within all inline padding.
      expect(6 * (fontSize + spacing)).toBeLessThanOrEqual(320 - 2 * (12 + 24 + 8));
      const columns = [...inline.matchAll(/<div\s+class="store-column"\s+style="([^"]+)"/g)];
      expect(columns).toHaveLength(2);
      for (const column of columns) {
        expect(column[1]).toContain('display:inline-block');
        expect(column[1]).toContain('width:100%;max-width:240px');
      }
      const stores = inline.slice(
        inline.indexOf('class="store-column"'),
        inline.lastIndexOf('</div>'),
      );
      expect(stores).not.toContain('<td');
      expect([...inline.matchAll(/<a\s+[^>]+style="([^"]+)"/g)]).toHaveLength(2);
      for (const link of inline.matchAll(/<a\s+[^>]+style="([^"]+)"/g)) {
        expect(link[1]).toContain('display:block;min-height:44px');
        expect(link[1]).toContain('padding:12px 8px');
      }
      // Ignore the hidden preheader and zero-size whitespace suppression wrapper.
      for (const size of inline.slice(inline.indexOf('<table')).matchAll(/font-size:(\d+)px/g)) {
        expect(Number(size[1]) === 0 || Number(size[1]) >= 15).toBe(true);
      }
    },
  );

  it.each([
    [
      'vi',
      'Ứng dụng giúp cặp đôi và nhóm bạn cùng chọn địa điểm, bình chọn và nhận một lịch trình chung cho buổi đi chơi. Dự án startup Việt Nam, MVP đang kiểm thử.',
      'Sắp có trên',
    ],
    [
      'en',
      'An app that helps couples and friend groups pick a place together, vote, and get one shared itinerary for the outing. A Vietnamese startup project with its MVP in testing.',
      'Coming soon on',
    ],
  ] as const)(
    'includes the approved %s introduction and non-clickable stores',
    (locale, intro, comingSoon) => {
      const mail = renderRecoveryMail({ ...sample, locale });
      expect(mail.html).toContain(intro);
      expect(mail.text).toContain(intro);
      expect(mail.html.indexOf(intro)).toBeGreaterThan(mail.html.indexOf(sample.code));
      expect(mail.html).toMatch(
        /<img\s+class="mail-logo"\s+src="https:\/\/gogo.id.vn\/brand\/gogo-mail-logo.png"\s+alt="GoGo"\s+width="120"\s+height="111"/,
      );
      expect(mail.html.match(/<img\b/g)).toHaveLength(1);
      expect(mail.html).not.toMatch(/<a\b/i);
      for (const label of ['App Store', 'Google Play']) {
        expect(mail.html).toContain(`${comingSoon} ${label}`);
        expect(mail.text).not.toContain(label);
      }
    },
  );

  it.each(['vi', 'en'] as const)(
    'renders configured HTTPS stores in %s without mail data in URLs',
    (locale) => {
      const links = {
        appStore: 'https://apps.apple.com/app/id123456',
        googlePlay: 'https://play.google.com/store/apps/details?id=vn.gogo&hl=en',
      };
      const mail = renderRecoveryMail({ ...sample, locale }, links);
      expect(mail.html).toContain(`href="${links.appStore}"`);
      expect(mail.html).toContain(
        'href="https://play.google.com/store/apps/details?id=vn.gogo&amp;hl=en"',
      );
      expect(mail.html).toMatch(/>\s*App Store<\/a\s*>/);
      expect(mail.html).toMatch(/>\s*Google Play<\/a\s*>/);
      expect(mail.text).toContain(`App Store: ${links.appStore}`);
      expect(mail.text).toContain(`Google Play: ${links.googlePlay}`);
      for (const match of mail.html.matchAll(/(?:href|src)="([^"]*)"/g)) {
        expect(match[1]).not.toContain(sample.code);
        expect(match[1]).not.toMatch(/utm_/i);
      }
      expect(mail.html.match(/<img\b/g)).toHaveLength(1);
    },
  );

  it('handles store configuration independently', () => {
    const mail = renderRecoveryMail(sample, {
      appStore: 'https://apps.apple.com/app/id123456',
      googlePlay: null,
    });
    expect(mail.html.match(/<a\b/g)).toHaveLength(1);
    expect(mail.html).toContain('Sắp có trên Google Play');
    expect(mail.text).toContain('App Store: https://apps.apple.com/app/id123456');
    expect(mail.text).not.toContain('Google Play');
  });

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    '//example.com',
    '#',
    '',
    'https://',
    'https://user:password@example.com',
    'https://example.com?UTM_source=mail',
  ])('leaves unsafe or tracking store configuration inactive: %s', (url) => {
    const mail = renderRecoveryMail(sample, { appStore: url, googlePlay: url });
    expect(mail.html).not.toMatch(/<a\b/i);
    expect(mail.text).not.toContain('App Store');
    expect(mail.text).not.toContain('Google Play');
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
