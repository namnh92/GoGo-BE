/** Fixed Stitch palette from Mobile src/shared/ui/tokens.ts (2026-11-10).
 * Kept local so the mail template has no runtime dependency on the mobile app.
 */
export const recoveryMailColors = {
  brand: '#20124A', // brandLogo.background
  accent: '#A71E07', // accents.orange.text
  accentSoft: '#FFE3DA', // accents.orange.soft
  canvas: '#FFF8F3', // surface.canvas
  card: '#FFFFFF', // surface.card
  text: '#1D1B18', // text.primary
  secondary: '#5A413B', // text.secondary
  onBrand: '#FFFFFF',
  onBrandSecondary: '#E4DEF2',
  store: '#171717',
} as const;

export const recoveryMailStoreLinks: Readonly<{
  appStore: string | null;
  googlePlay: string | null;
}> = {
  appStore: null,
  googlePlay: null,
};

/** Invalid configuration stays a non-clickable label. Never derive URLs from mail data. */
function storeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => /^utm_/i.test(key))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

const copy = {
  vi: {
    subject: 'Mã khôi phục mật khẩu GoGo',
    preheader: 'Sử dụng mã xác nhận để khôi phục mật khẩu GoGo.',
    tagline: 'Gợi ý điểm đến cho bạn',
    heading: 'Khôi phục mật khẩu',
    purpose: 'Nhập mã gồm 6 chữ số dưới đây trong ứng dụng GoGo để khôi phục mật khẩu của bạn.',
    codeLabel: 'Mã khôi phục của bạn',
    expiry: 'Mã hết hạn lúc',
    safety: 'Không chia sẻ mã này với bất kỳ ai.',
    ignore: 'Nếu bạn không yêu cầu khôi phục mật khẩu, hãy bỏ qua email này.',
    // Verbatim GoGo-FE/src/strings/landing.mjs a.desc, owner-approved 2026-11-10.
    intro:
      'Ứng dụng giúp cặp đôi và nhóm bạn cùng chọn địa điểm, bình chọn và nhận một lịch trình chung cho buổi đi chơi. Dự án startup Việt Nam, MVP đang kiểm thử.',
    comingSoon: 'Sắp có trên',
    footer: 'Đây là email tự động. Vui lòng không trả lời.',
  },
  en: {
    subject: 'Your GoGo password reset code',
    preheader: 'Use your verification code to reset your GoGo password.',
    tagline: 'Destination ideas for you',
    heading: 'Reset your password',
    purpose: 'Enter the 6-digit code below in the GoGo app to reset your password.',
    codeLabel: 'Your password reset code',
    expiry: 'This code expires at',
    safety: 'Do not share this code with anyone.',
    ignore: 'If you did not request a password reset, ignore this email.',
    // Verbatim GoGo-FE/src/strings/landing.mjs a.desc, owner-approved 2026-11-10.
    intro:
      'An app that helps couples and friend groups pick a place together, vote, and get one shared itinerary for the outing. A Vietnamese startup project with its MVP in testing.',
    comingSoon: 'Coming soon on',
    footer: 'This is an automated email. Please do not reply.',
  },
} as const;

/** Escape scalar values; markup fragments must come from this HTML renderer. */
function html(strings: TemplateStringsArray, ...values: (string | { markup: string })[]): string {
  return strings.reduce((result, part, index) => {
    const value = values[index] ?? '';
    if (typeof value !== 'string') return result + part + value.markup;
    const escaped = value.replace(/[&<>"']/g, (character) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
    });
    return result + part + escaped;
  }, '');
}

function formatExpiry(expiresAt: Date, locale: 'vi' | 'en'): string {
  const options = { timeZone: 'Asia/Ho_Chi_Minh' } as const;
  if (locale === 'vi') {
    const time = new Intl.DateTimeFormat('vi-VN', {
      ...options,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(expiresAt);
    const date = new Intl.DateTimeFormat('vi-VN', {
      ...options,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(expiresAt);
    return `${time}, ${date} (giờ Việt Nam)`;
  }
  const time = new Intl.DateTimeFormat('en-US', {
    ...options,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(expiresAt);
  const date = new Intl.DateTimeFormat('en-US', {
    ...options,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(expiresAt);
  return `${time}, ${date} (Vietnam time, UTC+7)`;
}

/** Pure presentation only: no recipient, challenge, provider or telemetry data. */
export function renderRecoveryMail(
  input: { code: string; expiresAt: Date; locale?: 'vi' | 'en' },
  storeLinks = recoveryMailStoreLinks,
): { subject: string; html: string; text: string } {
  const locale = input.locale === 'en' ? 'en' : 'vi';
  const c = copy[locale];
  const colors = recoveryMailColors;
  const expiry = `${c.expiry} ${formatExpiry(input.expiresAt, locale)}.`;
  const stores = [
    { label: 'App Store', url: storeUrl(storeLinks.appStore) },
    { label: 'Google Play', url: storeUrl(storeLinks.googlePlay) },
  ];
  const storeColumns = stores
    .map(({ label, url }) => {
      const badge = {
        markup: html`<span
            class="store-caption"
            style="display:block;font-size:11px;line-height:16px;white-space:nowrap;"
            >${c.comingSoon}</span
          >
          <strong
            class="store-name"
            style="display:block;font-size:16px;line-height:22px;white-space:nowrap;"
            >${label}</strong
          >`,
      };
      const badgeStyle = `display:block;min-height:44px;box-sizing:border-box;padding:10px 6px;background-color:${colors.store};border-radius:10px;color:${colors.onBrand};text-align:center;text-decoration:none;`;
      const content = {
        markup: url
          ? html`<a class="store-badge" href="${url}" style="${badgeStyle}">${badge}</a>`
          : html`<span class="store-badge" style="${badgeStyle}">${badge}</span>`,
      };
      return html`<td
        class="store-column"
        width="50%"
        valign="middle"
        style="width:50%;padding:0 4px;"
      >
        ${content}
      </td>`;
    })
    .join('');
  return {
    subject: c.subject,
    text: [
      'GoGo',
      c.tagline,
      c.heading,
      c.purpose,
      `${c.codeLabel}: ${input.code}`,
      expiry,
      c.safety,
      c.ignore,
      c.intro,
      ...stores.flatMap(({ label, url }) => (url ? [`${label}: ${url}`] : [])),
      c.footer,
    ].join('\n\n'),
    html: html`<!doctype html>
      <html lang="${locale}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="x-apple-disable-message-reformatting" />
          <meta name="color-scheme" content="light" />
          <meta name="supported-color-schemes" content="light" />
          <title>${c.subject}</title>
          <style>
            @media (max-width: 600px) {
              .mail-outer {
                padding: 12px 8px !important;
              }
              .mail-header {
                padding: 20px 16px !important;
              }
              .mail-content {
                padding: 24px 16px !important;
              }
              .mail-footer {
                padding: 20px 16px !important;
              }
              .recovery-code {
                font-size: 28px !important;
                letter-spacing: 2px !important;
              }
              .store-badge {
                padding: 8px 4px !important;
              }
              .store-caption {
                font-size: 10px !important;
              }
              .store-name {
                font-size: 14px !important;
              }
            }
          </style>
        </head>
        <body
          bgcolor="${colors.canvas}"
          style="margin:0;padding:0;background-color:${colors.canvas};color:${colors.text};font-family:Arial,Helvetica,sans-serif;color-scheme:light;"
        >
          <div
            style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;"
          >
            ${c.preheader}
          </div>
          <table
            role="presentation"
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            bgcolor="${colors.canvas}"
            style="background-color:${colors.canvas};"
          >
            <tr>
              <td class="mail-outer" align="center" style="padding:24px 12px;">
                <table
                  role="presentation"
                  width="100%"
                  cellpadding="0"
                  cellspacing="0"
                  border="0"
                  bgcolor="${colors.card}"
                  style="width:100%;max-width:560px;background-color:${colors.card};border-radius:20px;"
                >
                  <tr>
                    <td
                      class="mail-header"
                      bgcolor="${colors.brand}"
                      style="padding:24px;background-color:${colors.brand};color:${colors.canvas};border-radius:20px 20px 0 0;font-size:30px;line-height:36px;font-weight:bold;"
                    >
                      <table
                        role="presentation"
                        width="100%"
                        cellpadding="0"
                        cellspacing="0"
                        border="0"
                      >
                        <tr>
                          <td width="64" valign="middle" style="width:64px;">
                            <img
                              class="mail-logo"
                              src="https://gogo.id.vn/brand/gogo-mail-mark.png"
                              alt="GoGo"
                              width="64"
                              height="45"
                              style="display:block;width:64px;height:45px;border:0;"
                            />
                          </td>
                          <td valign="middle" style="padding-left:12px;">
                            <p
                              style="margin:0;font-size:26px;line-height:32px;font-weight:bold;color:${colors.onBrand};"
                            >
                              GoGo
                            </p>
                            <p
                              style="margin:0;font-size:13px;line-height:20px;font-weight:normal;color:${colors.onBrandSecondary};"
                            >
                              ${c.tagline}
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td class="mail-content" style="padding:28px 24px;color:${colors.text};">
                      <h1
                        style="margin:0 0 16px;font-size:24px;line-height:32px;color:${colors.text};"
                      >
                        ${c.heading}
                      </h1>
                      <p
                        style="margin:0 0 24px;font-size:16px;line-height:26px;color:${colors.secondary};"
                      >
                        ${c.purpose}
                      </p>
                      <table
                        role="presentation"
                        width="100%"
                        cellpadding="0"
                        cellspacing="0"
                        border="0"
                        bgcolor="${colors.accentSoft}"
                        style="background-color:${colors.accentSoft};border-radius:12px;"
                      >
                        <tr>
                          <td align="center" style="padding:20px 8px;color:${colors.accent};">
                            <p style="margin:0 0 8px;font-size:15px;line-height:22px;">
                              ${c.codeLabel}
                            </p>
                            <p
                              class="recovery-code"
                              dir="ltr"
                              style="margin:0;font-family:Consolas,'Courier New',monospace;font-size:32px;line-height:48px;font-weight:bold;letter-spacing:3px;white-space:nowrap;color:${colors.accent};"
                            >
                              ${input.code}
                            </p>
                          </td>
                        </tr>
                      </table>
                      <p
                        style="margin:20px 0 24px;font-size:15px;line-height:24px;color:${colors.secondary};"
                      >
                        ${expiry}
                      </p>
                      <p
                        style="margin:0 0 8px;font-size:15px;line-height:24px;color:${colors.text};font-weight:bold;"
                      >
                        ${c.safety}
                      </p>
                      <p
                        style="margin:0;font-size:15px;line-height:24px;color:${colors.secondary};"
                      >
                        ${c.ignore}
                      </p>
                      <p
                        style="margin:24px 0 16px;font-size:15px;line-height:24px;color:${colors.secondary};"
                      >
                        ${c.intro}
                      </p>
                      <table
                        class="store-row"
                        role="presentation"
                        width="100%"
                        cellpadding="0"
                        cellspacing="0"
                        border="0"
                        style="width:100%;table-layout:fixed;"
                      >
                        <tr>
                          ${{ markup: storeColumns }}
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td
                      class="mail-footer"
                      bgcolor="${colors.canvas}"
                      style="padding:20px 24px;background-color:${colors.canvas};color:${colors.secondary};border-radius:0 0 20px 20px;font-size:15px;line-height:22px;"
                    >
                      ${c.footer}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>`,
  };
}
