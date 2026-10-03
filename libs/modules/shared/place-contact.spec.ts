import { describe, expect, it } from 'vitest';
import {
  contactOwnership,
  isGoogleReference,
  normalizeAddress,
  normalizePhone,
  normalizeWebsite,
  validateEvidence,
} from './place-contact';

/**
 * GoGo-BE#280 — the shared rules for the three GoGo-owned contact fields. The
 * console, the bulk import and submission approval all call these, so a value
 * one door accepts is a value every door accepts.
 */

const path = (p: string) => ({
  sourceType: `${p}.sourceType`,
  sourceReference: `${p}.sourceReference`,
  collectedAt: `${p}.collectedAt`,
});
const NOW = new Date('2026-10-02T10:00:00Z');

describe('normalizePhone (#280 regressions)', () => {
  it.each(['+0912 345 678', '+00 84 912 345 678', '000 84 912 345 678'])(
    'rejects %j — no country code starts with 0',
    (raw) => {
      expect(normalizePhone(raw).ok).toBe(false);
    },
  );

  it('rejects an input past 40 characters before looking at it', () => {
    expect(normalizePhone('0'.repeat(41))).toEqual({
      ok: false,
      issue: expect.objectContaining({ code: 'too_long' }),
    });
  });

  it.each(['028 3822 9999 ext 12', '028 3822 9999;12', '028 3822 9999 x12', '028\u00003822'])(
    'rejects an extension or control character: %j',
    (raw) => {
      expect(normalizePhone(raw).ok).toBe(false);
    },
  );

  it('still normalizes the trunk prefix and keeps a foreign number foreign', () => {
    expect(normalizePhone('0283 822 9999')).toEqual({ ok: true, value: '+842838229999' });
    expect(normalizePhone('+65 6221 1111')).toEqual({ ok: true, value: '+6562211111' });
  });
});

describe('normalizeWebsite (#280 regressions)', () => {
  it.each([
    'https://user:pass@chaoban.vn',
    'https://bank.vn@evil.vn/login',
    'https://user@chaoban.vn',
  ])('rejects credentials in %j — the link would read as one host and open another', (raw) => {
    expect(normalizeWebsite(raw).ok).toBe(false);
  });

  it.each([
    'http://127.0.0.1',
    'https://10.0.0.5/menu',
    'http://0x7f.1',
    'http://[::1]/',
    'https://localhost',
    'https://router.local',
    'https://api.internal',
    'https://foo.home.arpa',
  ])('rejects %j — not a public host', (raw) => {
    expect(normalizeWebsite(raw).ok).toBe(false);
  });

  it('rejects a control character the URL parser would silently strip', () => {
    expect(normalizeWebsite('https://chao\nban.vn').ok).toBe(false);
  });

  it('keeps path, query and fragment, and upgrades a bare host', () => {
    expect(normalizeWebsite('chaoban.vn/menu?lang=vi#top')).toEqual({
      ok: true,
      value: 'https://chaoban.vn/menu?lang=vi#top',
    });
    expect(normalizeWebsite('http://xn--qun-n-0qa.vn/').ok).toBe(true);
  });
});

describe('normalizeAddress', () => {
  it('trims and keeps Vietnamese text exactly', () => {
    expect(normalizeAddress('  12 Nguyễn Huệ, Phường Sài Gòn  ')).toEqual({
      ok: true,
      value: '12 Nguyễn Huệ, Phường Sài Gòn',
    });
  });

  it.each([
    ['', 'blank'],
    ['   ', 'blank'],
    ['a'.repeat(401), 'too_long'],
    ['12 Lê Lợi\n<script>', 'invalid'],
    ['<b>12 Lê Lợi</b>', 'invalid'],
    ['12 Lê Lợi\u0007', 'invalid'],
  ])('rejects %j (%s)', (raw, code) => {
    expect(normalizeAddress(raw)).toEqual({
      ok: false,
      issue: expect.objectContaining({ code }),
    });
  });
});

describe('validateEvidence', () => {
  const good = {
    sourceType: 'editorial',
    sourceReference: 'Gọi điện chủ quán 2026-09-30',
    collectedAt: '2026-09-30T08:00:00+07:00',
  };

  it('accepts independent evidence and normalizes the time to UTC', () => {
    expect(validateEvidence(good, path('provenance.phone'), NOW)).toEqual({
      ok: true,
      value: { ...good, collectedAt: '2026-09-30T01:00:00.000Z' },
    });
  });

  it('names every missing property against its own path', () => {
    const res = validateEvidence({}, path('provenance.phone'), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((i) => [i.field, i.code])).toEqual([
        ['provenance.phone.sourceType', 'required'],
        ['provenance.phone.sourceReference', 'required'],
        ['provenance.phone.collectedAt', 'required'],
      ]);
    }
  });

  it.each([
    [{ ...good, sourceType: 'google_derived' }, 'sourceType', 'google_not_independent'],
    [{ ...good, sourceType: 'merchant' }, 'sourceType', 'invalid'],
    [
      { ...good, sourceReference: 'https://maps.app.goo.gl/abc' },
      'sourceReference',
      'google_not_independent',
    ],
    [
      { ...good, sourceReference: 'ChIJN1t_tDeuEmsRUsoyG83frY4' },
      'sourceReference',
      'google_not_independent',
    ],
    [{ ...good, sourceReference: 'x'.repeat(501) }, 'sourceReference', 'too_long'],
    [{ ...good, collectedAt: '2026-09-30 08:00' }, 'collectedAt', 'invalid_datetime'],
    [{ ...good, collectedAt: '2026-10-03T00:00:00Z' }, 'collectedAt', 'in_future'],
  ])('refuses %j', (input, prop, code) => {
    const res = validateEvidence(input, path('p'), NOW);
    expect(res).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: `p.${prop}`, code })],
    });
  });
});

describe('contactOwnership', () => {
  it('is gogo only with an independent source, a reference and a collection time', () => {
    expect(
      contactOwnership({
        source_type: 'editorial',
        source_reference: 'merchant statement',
        collected_at: '2026-09-30T01:00:00Z',
      }),
    ).toBe('gogo');
  });

  it('treats a legacy editorial row with no evidence as unknown — typing is not ownership', () => {
    expect(
      contactOwnership({ source_type: 'editorial', source_reference: null, collected_at: null }),
    ).toBe('unknown');
    expect(
      contactOwnership({
        source_type: 'editorial',
        source_reference: 'menu',
        collected_at: null,
      }),
    ).toBe('unknown');
  });

  it('keeps a Google seed Google, and a Google reference never becomes gogo', () => {
    expect(
      contactOwnership({
        source_type: 'google_derived',
        source_reference: 'ChIJx',
        collected_at: null,
      }),
    ).toBe('google');
    expect(
      contactOwnership({
        source_type: 'editorial',
        source_reference: 'https://www.google.com/maps/place/x',
        collected_at: '2026-09-30T01:00:00Z',
      }),
    ).toBe('unknown');
    expect(contactOwnership(undefined)).toBe('unknown');
  });

  it('recognises Google references', () => {
    expect(isGoogleReference('Data © Google')).toBe(true);
    expect(isGoogleReference('https://chaoban.vn/lien-he')).toBe(false);
  });
});

describe('validateEvidence — transport is not origin (Sol F-05)', () => {
  const at = '2026-09-30T02:00:00Z';
  it.each([
    'job 123',
    'Job #4521',
    'import job 77',
    'sheet 3',
    'Sheet1!B7',
    "'HCM'!A2:C9",
    'row 42',
    'R12',
    'HCM#12',
    '7f3c2a10-1b2c-4d5e-8f90-123456789abc',
    '12345',
    // Sol F-07 — combinations of transport parts.
    'job 123, row 4',
    'Import job 77 / Sheet HCM',
    'sheet HCM row 12',
    'Job #4521 - Sheet1!B7',
  ])('refuses %j', (ref) => {
    expect(
      validateEvidence(
        { sourceType: 'editorial', sourceReference: ref, collectedAt: at },
        path('p'),
        NOW,
      ),
    ).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'p.sourceReference', code: 'transport_only' })],
    });
  });

  it.each([
    'Gọi điện chủ quán 2026-09-30',
    'https://chaoban.vn/lien-he',
    'Danh thiếp của quán, 2026-09-30',
    'Khảo sát thực địa tổ 3, 2026-09-28',
    // Sol F-08 — an official URL with a fragment is an origin, not `Tab#12`.
    'https://chaoban.vn/lien-he#2',
    'http://chaoban.vn/menu?page=2#12',
    // A dataset named by a short code, without any transport word.
    'OSM',
    'Thực đơn in tại quán (row of photos on the wall)',
  ])('still accepts a named origin: %j', (ref) => {
    expect(
      validateEvidence(
        { sourceType: 'editorial', sourceReference: ref, collectedAt: at },
        path('p'),
        NOW,
      ).ok,
    ).toBe(true);
  });
});

describe('validateEvidence — collectedAt is a zoned date-time (Sol F-06)', () => {
  const ev = (collectedAt: string) =>
    validateEvidence(
      { sourceType: 'editorial', sourceReference: 'Gọi điện chủ quán', collectedAt },
      path('p'),
      NOW,
    );
  it.each([
    '2026-09-30',
    '2026-09-30T02:00:00',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-09-30T24:00:00Z',
    '2026-09-30T02:60:00Z',
    '2026-09-30T02:00:00+25:00',
  ])('refuses %j', (raw) => {
    expect(ev(raw)).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'p.collectedAt', code: 'invalid_datetime' })],
    });
  });

  it.each([
    ['2026-09-30T02:00Z', '2026-09-30T02:00:00.000Z'],
    ['2026-09-30T09:00:00.5+07:00', '2026-09-30T02:00:00.500Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
  ])('accepts %j', (raw, iso) => {
    const res = ev(raw);
    expect(res.ok && res.value.collectedAt).toBe(iso);
  });
});

/**
 * GoGo-BE#280 — SA (Astra) transport-guard corpus, 2026-10-03. Every row of
 * the decision's TESTS table is its own case, including the documented
 * conservative false positives and the accepted detection gaps.
 */
describe('Astra transport-guard corpus (F-09/F-10)', () => {
  const run = (over: Record<string, string>) =>
    validateEvidence(
      {
        sourceType: 'editorial',
        sourceReference: 'Gọi điện chủ quán 2026-09-30',
        collectedAt: '2026-09-30T02:00:00Z',
        ...over,
      },
      path('p'),
      NOW,
    );

  it.each([
    'pho24.vn',
    'pho24.vn/lien-he#2',
    'https://chaoban.vn/lien-he#2',
    'http://chaoban.vn/menu?page=2#12',
    'job.vn',
    'Gọi điện chủ quán 2026-09-30',
    'OSM',
    'Thực đơn in tại quán (row of photos on the wall)',
  ])('accepts %j', (ref) => {
    expect(run({ sourceReference: ref }).ok).toBe(true);
  });

  it.each([
    'job 123',
    'Sheet1!B7',
    "'HCM'!A2:C9",
    'row 42',
    'R12',
    'HCM#12',
    'job 123, row 4',
    'Import job 77 / Sheet HCM',
    'sheet HCM row 12',
    'Job #4521 - Sheet1!B7',
    'Tab Quận 1',
    'TAB QUẬN 1',
    '12345',
    '7f3c2a10-1b2c-4d5e-8f90-123456789abc',
  ])('refuses %j as transport_only', (ref) => {
    expect(run({ sourceReference: ref })).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'p.sourceReference', code: 'transport_only' })],
    });
  });

  it.each(['job 123; gọi chủ quán', 'Job Café merchant statement'])(
    'refuses %j — accepted conservative false positive: put the origin first',
    (ref) => {
      expect(run({ sourceReference: ref })).toEqual({
        ok: false,
        issues: [expect.objectContaining({ code: 'transport_only' })],
      });
    },
  );

  it.each(['Bảng Quận 1', '123, row 4'])(
    'passes %j syntactically — documented detection gap, not adequate evidence',
    (ref) => {
      expect(run({ sourceReference: ref }).ok).toBe(true);
    },
  );

  it.each(['https://maps.app.goo.gl/abc', 'ChIJN1t_tDeuEmsRUsoyG83frY4'])(
    'refuses %j as google_not_independent before the URL exemption',
    (ref) => {
      expect(run({ sourceReference: ref })).toEqual({
        ok: false,
        issues: [expect.objectContaining({ code: 'google_not_independent' })],
      });
    },
  );

  it('refuses sourceType=google_derived as google_not_independent', () => {
    expect(run({ sourceType: 'google_derived' })).toEqual({
      ok: false,
      issues: [expect.objectContaining({ field: 'p.sourceType', code: 'google_not_independent' })],
    });
  });

  it('accepts an offset collectedAt and normalizes it to UTC', () => {
    const res = run({ collectedAt: '2026-09-30T09:00:00+07:00' });
    expect(res.ok && res.value.collectedAt).toBe('2026-09-30T02:00:00.000Z');
  });

  it.each(['2026-09-30', '2026-02-30T00:00:00Z', '2026-09-30T02:00:00'])(
    'refuses collectedAt %j as invalid_datetime',
    (collectedAt) => {
      expect(run({ collectedAt })).toEqual({
        ok: false,
        issues: [expect.objectContaining({ code: 'invalid_datetime' })],
      });
    },
  );

  it('accepts collectedAt exactly five minutes ahead', () => {
    expect(run({ collectedAt: '2026-10-02T10:05:00Z' }).ok).toBe(true);
  });

  it('refuses collectedAt one millisecond past the tolerance as in_future', () => {
    expect(run({ collectedAt: '2026-10-02T10:05:00.001Z' })).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'in_future' })],
    });
  });

  it('applies the same predicate to stored evidence when reading ownership', () => {
    const stored = (source_reference: string) =>
      contactOwnership({
        source_type: 'editorial',
        source_reference,
        collected_at: '2026-09-30T02:00:00Z',
      });
    expect(stored('Tab Quận 1')).toBe('unknown');
    expect(stored('job 123')).toBe('unknown');
    expect(stored('pho24.vn')).toBe('gogo');
  });
});
