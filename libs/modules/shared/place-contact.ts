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

/** The stored shape, checked after normalization rather than assumed from it. */
export const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * C0 and C1 control characters, DEL included. A newline in an address or a NUL
 * in a URL is never what a person meant, and some of them change how a client
 * renders the value next to it.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

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
  if (CONTROL_CHARS.test(trimmed)) {
    return {
      ok: false,
      issue: { field: 'phone', code: 'invalid', message: 'Số điện thoại không hợp lệ' },
    };
  }
  const invalid: ContactIssue = {
    field: 'phone',
    code: 'invalid',
    message: 'Số điện thoại không hợp lệ',
  };
  if (trimmed === '') return { ok: false, issue: invalid };
  // GoGo-BE#280 — the same 40-character ceiling on every door. Past that it is
  // not a phone number with separators, it is a sentence.
  if (trimmed.length > 40) {
    return {
      ok: false,
      issue: { field: 'phone', code: 'too_long', message: 'Số điện thoại quá dài' },
    };
  }

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

  // E.164: a country code never starts with 0, at most 15 digits, and below 8
  // is not a reachable number. GoGo-BE#280 — `+0912…` and `000 84…` used to
  // pass the length check alone and be stored as a "number" no country owns.
  const value = `+${e164}`;
  if (!E164.test(value)) return { ok: false, issue: invalid };
  return { ok: true, value };
}

/**
 * Only `http`/`https`, and only a URL with a host. A bare `example.com` is
 * upgraded to `https://` rather than rejected, because that is what an editor
 * pasting from a business card means and refusing it teaches nothing.
 */
export function normalizeWebsite(raw: string): NormalizedWebsite {
  const invalid: ContactIssue = {
    field: 'website',
    code: 'invalid',
    message: 'Website phải là địa chỉ http hoặc https hợp lệ',
  };
  // Checked on the raw value: the URL parser silently strips tabs and newlines,
  // so after parsing there is nothing left to see.
  if (CONTROL_CHARS.test(raw)) return { ok: false, issue: invalid };
  const trimmed = raw.trim();
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
  /**
   * GoGo-BE#280 — a business's public website, and nothing a link can be
   * abused into. Credentials in the authority (`https://bank.vn@evil.vn`) make
   * a link read as one host and open another; an IP literal or a private name
   * points a client at a network the business does not run. Nothing here
   * fetches the URL — the check is on its shape only.
   */
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      issue: {
        field: 'website',
        code: 'credentials',
        message: 'Website không được chứa tài khoản',
      },
    };
  }
  if (!isPublicHostname(url.hostname)) return { ok: false, issue: invalid };
  if (url.href.length > 500) {
    return { ok: false, issue: { field: 'website', code: 'too_long', message: 'Website quá dài' } };
  }
  return { ok: true, value: url.href };
}

/** Suffixes that never name a host on the public internet. */
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'onion',
];

/**
 * A DNS name with at least two labels and an alphabetic (or IDN) top-level
 * label. The URL parser has already lower-cased the host and turned an IPv4
 * written as `0x7f.1` into `127.0.0.1`, so a numeric last label is exactly an
 * IPv4 literal, and a bracket is exactly IPv6.
 */
function isPublicHostname(host: string): boolean {
  if (host === '' || host.startsWith('[') || host.length > 253) return false;
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  const tld = labels[labels.length - 1]!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;
  const name = labels.join('.');
  return !PRIVATE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

export type NormalizedAddress = { ok: true; value: string } | { ok: false; issue: ContactIssue };

/**
 * GoGo-BE#280 — the postal address as GoGo's own text.
 *
 * Trimmed, non-blank, at most 400 characters, plain text. Unicode is kept as
 * written: Vietnamese diacritics are the address, not decoration. Markup is
 * refused rather than escaped, because three clients render this and an
 * address never needs an angle bracket. Nothing here infers a coordinate or an
 * administrative code from the text — an address edit is not a move.
 */
export function normalizeAddress(raw: string): NormalizedAddress {
  const invalid: ContactIssue = {
    field: 'addressText',
    code: 'invalid',
    message: 'Địa chỉ phải là văn bản thuần, không chứa ký tự điều khiển',
  };
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, issue: { field: 'addressText', code: 'blank', message: 'Địa chỉ trống' } };
  }
  if (trimmed.length > 400) {
    return {
      ok: false,
      issue: { field: 'addressText', code: 'too_long', message: 'Địa chỉ quá dài' },
    };
  }
  if (CONTROL_CHARS.test(trimmed) || /[<>]/.test(trimmed)) return { ok: false, issue: invalid };
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------- evidence

/**
 * GoGo-BE#280 — the three GoGo-owned contact fields, by the column their
 * provenance is keyed on, and by the name the API uses for them.
 */
export const CONTACT_FIELDS = ['address_text', 'phone', 'website'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
export const CONTACT_API_FIELD: Record<ContactField, 'addressText' | 'phone' | 'website'> = {
  address_text: 'addressText',
  phone: 'phone',
  website: 'website',
};

/**
 * Who can be an independent origin. `google_derived` is not on the list, and
 * cannot be: copying, retyping or confirming Google content does not make it
 * GoGo's (GOGO_PRODUCT_DATA_ARCHITECTURE.md).
 *
 * `editorial` — a merchant statement, an official website or a field visit;
 * `community` — a contributor's own report; `provider` — a permitted,
 * non-Google dataset. `sourceReference` names which.
 */
export const INDEPENDENT_SOURCE_TYPES = ['editorial', 'community', 'provider'] as const;
export type IndependentSourceType = (typeof INDEPENDENT_SOURCE_TYPES)[number];

export type ContactEvidence = {
  sourceType: IndependentSourceType;
  sourceReference: string;
  /** ISO-8601 UTC — when the evidence was gathered, not when it was typed in. */
  collectedAt: string;
};

export type ContactEvidenceInput = {
  sourceType?: unknown;
  sourceReference?: unknown;
  collectedAt?: unknown;
};

/**
 * A reference that names Google is transport, not origin: a Maps link, a share
 * link or a Place ID says where the text was read, and that is the one origin
 * this field may not have.
 */
const GOOGLE_REFERENCE =
  /google\.|goo\.gl|g\.page|g\.co\/|\bChIJ[\w-]{8,}|\bGhIJ[\w-]{8,}|\bgoogle\b/i;

export function isGoogleReference(reference: string): boolean {
  return GOOGLE_REFERENCE.test(reference);
}

/**
 * GoGo-BE#280 — the transport guard: a **bounded lexical** check on
 * `sourceReference`, decided by SA (Astra, 2026-10-03, after F-05 → F-10).
 *
 * A reference must name where a fact came from (a merchant statement, the
 * official website, a visit, a dataset); a job, sheet or row id only names how
 * the cell travelled. This guard catches the common transport shapes and
 * nothing more. It is a finite grammar, not a classifier, and its limits are
 * accepted on purpose (ADR-0031 §Transport guard):
 *
 *   1. the whole trimmed reference parses as a website (`normalizeWebsite`,
 *      scheme optional, fragment allowed) → an origin, never transport;
 *   2. it **starts with** a frozen transport keyword (NFC, case-insensitive)
 *      and the next character is absent or not a Unicode letter → transport
 *      (`job 123`, `Sheet1`, `Tab Quận 1` — whatever follows);
 *   3. the whole reference is a standalone identifier → transport: an ASCII
 *      decimal number, a UUID `8-4-4-4-12`, an A1 cell/range with an optional
 *      `label!`, or `label#digits`.
 *
 * Anything else passes this guard — which is not the same as being adequate
 * evidence. No digit rule, no token scoring, no uppercase heuristic: each of
 * those was tried and produced either a gap or a false positive.
 *
 * Callers run the required / length / control-character / Google checks
 * first, so a Google URL is refused as `google_not_independent` before rule 1.
 */
export const TRANSPORT_KEYWORDS: readonly string[] = Object.freeze([
  'job',
  'jobs',
  'sheet',
  'sheets',
  'tab',
  'row',
  'rows',
  'dòng',
  'dong',
  'cột',
  'cot',
  'col',
  'column',
  'cell',
  'import',
  'batch',
  'file',
  'upload',
  'csv',
  'xlsx',
  'spreadsheet',
  'id',
  'r',
]);

const STANDALONE_IDENTIFIERS: readonly RegExp[] = [
  // ASCII decimal number
  /^[0-9]+$/,
  // UUID, hexadecimal 8-4-4-4-12
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // A1 cell or range: optional `$`, 1–3 column letters, positive row, optional `label!`
  /^(?:[^!]+!)?\$?[A-Za-z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Za-z]{1,3}\$?[1-9][0-9]*)?$/,
  // `label#digits` — the positional row id the importer itself mints
  /^[^#]+#[0-9]+$/,
];

export function isTransportReference(reference: string): boolean {
  const ref = reference.trim();
  if (ref === '') return false;
  // 1. A website is an origin, scheme-less host and fragment included. This
  //    only recognises the shape; it neither fetches nor proves ownership.
  if (normalizeWebsite(ref).ok) return false;
  // 2. A transport keyword at the start, not followed by a letter.
  const lower = ref.normalize('NFC').toLocaleLowerCase('vi');
  for (const keyword of TRANSPORT_KEYWORDS) {
    if (!lower.startsWith(keyword)) continue;
    const rest = lower.slice(keyword.length);
    const nextChar = rest === '' ? '' : String.fromCodePoint(rest.codePointAt(0)!);
    if (nextChar === '' || !/\p{L}/u.test(nextChar)) return true;
  }
  // 3. A standalone identifier.
  return STANDALONE_IDENTIFIERS.some((pattern) => pattern.test(ref));
}

/**
 * GoGo-BE#280 (Sol F-06) — ISO-8601 date-time with seconds optional, a zone
 * required (`Z` or `±hh:mm`), and a real calendar date. `Date` would accept a
 * bare date as midnight UTC and roll `02-30` into March; both are refused.
 */
function parseZonedDateTime(raw: string): Date | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      raw,
    );
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Clock skew tolerated on `collectedAt` — a console a minute fast is not lying. */
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Validates one field's evidence. `path` is how the caller names the evidence
 * properties in its own errors: `provenance.phone` for the console,
 * `phone_source` for a sheet column prefix.
 */
export function validateEvidence(
  input: ContactEvidenceInput | null | undefined,
  path: { sourceType: string; sourceReference: string; collectedAt: string },
  now: Date = new Date(),
): { ok: true; value: ContactEvidence } | { ok: false; issues: ContactIssue[] } {
  const issues: ContactIssue[] = [];
  const sourceType = typeof input?.sourceType === 'string' ? input.sourceType.trim() : '';
  const sourceReference =
    typeof input?.sourceReference === 'string' ? input.sourceReference.trim() : '';
  const collectedRaw = typeof input?.collectedAt === 'string' ? input.collectedAt.trim() : '';

  if (sourceType === '') {
    issues.push({ field: path.sourceType, code: 'required', message: 'Thiếu nguồn dữ liệu' });
  } else if (sourceType === 'google_derived' || sourceType === 'google') {
    issues.push({
      field: path.sourceType,
      code: 'google_not_independent',
      message: 'Dữ liệu từ Google không phải nguồn độc lập',
    });
  } else if (!(INDEPENDENT_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    issues.push({ field: path.sourceType, code: 'invalid', message: 'Nguồn dữ liệu không hợp lệ' });
  }

  if (sourceReference === '') {
    issues.push({
      field: path.sourceReference,
      code: 'required',
      message: 'Thiếu tham chiếu nguồn',
    });
  } else if (sourceReference.length > 500) {
    issues.push({
      field: path.sourceReference,
      code: 'too_long',
      message: 'Tham chiếu nguồn quá dài',
    });
  } else if (CONTROL_CHARS.test(sourceReference)) {
    issues.push({
      field: path.sourceReference,
      code: 'invalid',
      message: 'Tham chiếu nguồn không hợp lệ',
    });
  } else if (isGoogleReference(sourceReference)) {
    issues.push({
      field: path.sourceReference,
      code: 'google_not_independent',
      message: 'Tham chiếu Google không phải nguồn độc lập',
    });
  } else if (isTransportReference(sourceReference)) {
    issues.push({
      field: path.sourceReference,
      code: 'transport_only',
      message: 'Mã job / sheet / dòng chỉ là đường truyền, không phải nguồn — ghi rõ nguồn gốc',
    });
  }

  let collectedAt: Date | null = null;
  if (collectedRaw === '') {
    issues.push({ field: path.collectedAt, code: 'required', message: 'Thiếu thời điểm thu thập' });
  } else {
    const parsed = parseZonedDateTime(collectedRaw);
    if (!parsed || Number.isNaN(parsed.getTime())) {
      issues.push({
        field: path.collectedAt,
        code: 'invalid_datetime',
        message: 'Không phải thời điểm ISO',
      });
    } else if (parsed.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      issues.push({
        field: path.collectedAt,
        code: 'in_future',
        message: 'Thời điểm thu thập ở tương lai',
      });
    } else {
      collectedAt = parsed;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      sourceType: sourceType as IndependentSourceType,
      sourceReference,
      collectedAt: collectedAt!.toISOString(),
    },
  };
}

/**
 * The stored provenance row, as far as ownership is concerned. Whether a value
 * is GoGo's is decided here and only here, so the console, the public detail
 * and the import cannot disagree about it.
 *
 * A timestamp alone proves nothing: a legacy `editorial` row with no reference
 * and no collection time is a person having typed something, which is exactly
 * what does not confer ownership.
 */
export type StoredContactProvenance = {
  source_type: string;
  source_reference: string | null;
  collected_at: Date | string | null;
};

export function contactOwnership(
  row: StoredContactProvenance | null | undefined,
): 'gogo' | 'google' | 'unknown' {
  if (!row) return 'unknown';
  if (row.source_type === 'google_derived') return 'google';
  const independent = (INDEPENDENT_SOURCE_TYPES as readonly string[]).includes(row.source_type);
  if (
    independent &&
    row.source_reference !== null &&
    row.source_reference.trim() !== '' &&
    !isGoogleReference(row.source_reference) &&
    // GoGo-BE#280 (Astra) — the same reference predicate `validateEvidence`
    // uses, so evidence the write path would refuse never reads as GoGo's.
    !isTransportReference(row.source_reference) &&
    row.collected_at !== null
  ) {
    return 'gogo';
  }
  return 'unknown';
}
