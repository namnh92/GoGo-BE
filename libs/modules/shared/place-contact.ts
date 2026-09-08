/**
 * BE-CMS-PE-001 (#425) — normalizing the contact fields the CMS may now write.
 *
 * `places.phone` and `places.website` have been readable since DB-005 and
 * writable by nobody: `cmsUpdatePlace` did not accept them, so the console
 * rendered them as facts with no edit affordance. Making them writable means
 * deciding what a written value looks like, because two editors typing the
 * same restaurant's number produced `0283 822 9999`, `+84 28 3822 9999` and
 * `02838229999` — three strings, one phone, and no way to dial or dedupe.
 *
 * Stored in E.164. Vietnam is the default country because the catalog is
 * Vietnamese, but an explicitly international number is kept as given rather
 * than forced into +84.
 */

const VN_COUNTRY_CODE = '84';

export type ContactIssue = { field: string; code: string; message: string };

export type NormalizedPhone = { ok: true; value: string } | { ok: false; issue: ContactIssue };
export type NormalizedWebsite = { ok: true; value: string } | { ok: false; issue: ContactIssue };

/**
 * `+84 28 3822 9999`, `028 3822 9999`, `(028) 3822-9999` → `+842838229999`.
 *
 * A leading `0` is the Vietnamese trunk prefix and is replaced by the country
 * code, which is the one transformation that actually changes the number's
 * meaning — so it happens only for a number with no country code of its own.
 */
export function normalizePhone(raw: string): NormalizedPhone {
  const trimmed = raw.trim();
  const invalid: ContactIssue = {
    field: 'phone',
    code: 'invalid',
    message: 'Số điện thoại không hợp lệ',
  };
  if (trimmed === '') return { ok: false, issue: invalid };

  // Everything a person might use as a separator, and nothing else. A letter
  // in a phone number is a typo or a vanity number GoGo cannot dial.
  const cleaned = trimmed.replace(/[\s().\-–—]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, issue: invalid };

  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  const international = cleaned.startsWith('+');

  let e164: string;
  if (international) {
    e164 = digits;
  } else if (digits.startsWith('00')) {
    // `0084…` — the other way of writing a country code.
    e164 = digits.slice(2);
  } else if (digits.startsWith('0')) {
    e164 = `${VN_COUNTRY_CODE}${digits.slice(1)}`;
  } else if (digits.startsWith(VN_COUNTRY_CODE)) {
    e164 = digits;
  } else {
    // No trunk prefix and no country code: a bare subscriber number could
    // belong to any country, so guessing one would invent a fact.
    return {
      ok: false,
      issue: {
        field: 'phone',
        code: 'no_country',
        message: 'Thiếu mã quốc gia hoặc số 0 đầu',
      },
    };
  }

  // E.164 allows at most 15 digits; below 8 is not a reachable number.
  if (e164.length < 8 || e164.length > 15) return { ok: false, issue: invalid };
  return { ok: true, value: `+${e164}` };
}

/**
 * Only `http`/`https`, and only a URL with a host. A bare `example.com` is
 * upgraded to `https://` rather than rejected, because that is what an editor
 * pasting from a business card means and refusing it teaches nothing.
 */
export function normalizeWebsite(raw: string): NormalizedWebsite {
  const trimmed = raw.trim();
  const invalid: ContactIssue = {
    field: 'website',
    code: 'invalid',
    message: 'Website phải là địa chỉ http hoặc https hợp lệ',
  };
  if (trimmed === '') return { ok: false, issue: invalid };

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, issue: invalid };
  }
  // `javascript:`, `data:` and `file:` are the reason this is an allowlist and
  // not a "not one of these" list — the value is rendered as a link in three
  // clients (SEC: stored XSS via href).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, issue: invalid };
  }
  if (url.hostname === '' || !url.hostname.includes('.')) {
    return { ok: false, issue: invalid };
  }
  if (url.href.length > 500) {
    return { ok: false, issue: { field: 'website', code: 'too_long', message: 'Website quá dài' } };
  }
  return { ok: true, value: url.href };
}
