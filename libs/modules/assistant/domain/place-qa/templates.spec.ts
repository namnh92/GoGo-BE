import { describe, expect, it } from 'vitest';
import { renderPlaceAnswer } from './templates';
import { fictionalPlace, FIXTURE_A, verified } from './fixtures';
import type { AnswerQuery } from './tokens';
import type { PlaceFacts, PriceFact, VerifiedFact } from './place-facts';
function render(
  topic: AnswerQuery['topic'],
  place: PlaceFacts = fictionalPlace(),
  args: Partial<AnswerQuery> = {},
) {
  return renderPlaceAnswer(
    { placeId: FIXTURE_A, locale: 'vi', topic, ...args },
    { places: new Map([[FIXTURE_A, place]]) },
  );
}
describe('read-time templates over eligible facts', () => {
  it('renders each amount with currency/unit, retains free zero and suppresses malformed scope', () => {
    const rows: PriceFact[] = [
      { min: 0, max: 0, currency: 'VND', unit: 'per_item' },
      { min: 10, max: 20, currency: 'USD', unit: 'per_hour' },
      { min: 99, max: 99, currency: 'EUR', unit: 'per_night' },
    ];
    const p = { ...fictionalPlace(), facts: { price: [verified(rows)] } };
    for (const value of ['Miễn phí', '0,10–0,20 USD/giờ', '0,99 EUR/đêm'])
      expect(render('price', p).text).toContain(value);
    for (const invalid of [
      { min: null, max: null },
      { unit: null },
      { min: -1 },
      { min: NaN },
      { min: 1.5 },
      { max: Number.MAX_SAFE_INTEGER + 1 },
      { currency: '$' },
      { max: 0 },
    ]) {
      const fact = verified([
        { min: 10, max: 20, currency: 'VND', unit: 'per_person', ...invalid },
      ] as PriceFact[]);
      expect(render('price', { ...p, facts: { price: [fact] } }).text).toContain(
        'chưa có giá đã xác minh',
      );
    }
  });
  it('never promotes unverified, unknown-source, missing-date or provider facts', () => {
    const p = fictionalPlace();
    for (const fact of [
      { ...p.facts.price![0]!, tier: 'unconfirmed' },
      { ...p.facts.price![0]!, verifiedAt: '' },
      { ...p.facts.price![0]!, source: { kind: 'google', collectedAt: '2026-11-10T00:00:00Z' } },
    ]) {
      const a = render('price', {
        ...p,
        facts: { price: [fact as VerifiedFact<readonly PriceFact[]>] },
      });
      expect(a.text).not.toContain('12000');
      expect(a.sources).toEqual([]);
    }
    expect(render('overview', { ...p, facts: {} }).text).not.toContain('giá');
  });
  // Sol confirm F-04, rev3 §3.5 / owner Q-2: a direct price question with no
  // eligible price gets the permitted wording plus the generic card pointer.
  it.each([
    [
      'vi',
      'GoGo chưa có giá đã xác minh của địa điểm này. Bạn xem thông tin trong thẻ địa điểm nhé.',
    ],
    ['en', 'GoGo has no verified price for this place. Please see the place card for details.'],
  ] as const)(
    'direct price question without an eligible price points to the card (%s)',
    (locale, wording) => {
      const p = fictionalPlace();
      const { price: _price, ...withoutPrice } = p.facts;
      expect(render('price', { ...p, facts: withoutPrice }, { locale }).text).toBe(
        `Fictional Lantern: ${wording}`,
      );
      for (const price of [
        [],
        [{ ...p.facts.price![0]!, tier: 'unconfirmed' }],
        [
          {
            ...p.facts.price![0]!,
            source: { kind: 'google', collectedAt: '2026-11-10T00:00:00Z' },
          },
        ],
      ]) {
        const a = render(
          'price',
          { ...p, facts: { ...p.facts, price: price as VerifiedFact<readonly PriceFact[]>[] } },
          { locale },
        );
        expect(a.text).toBe(`Fictional Lantern: ${wording}`);
        expect(a.text).not.toMatch(/12000|24000|\d{4}-\d{2}-\d{2}/);
        expect(a.sources).toEqual([]);
        expect(a.eligible).toBe(false);
      }
    },
  );
  it('reference facts carry their own verification date and never assert current availability', () => {
    const p = fictionalPlace();
    const a = render('price', {
      ...p,
      facts: { price: [{ ...p.facts.price![0]!, tier: 'verified_reference' }] },
    });
    expect(a.text).toContain('2026-11-10');
    expect(a.text).toContain('có thể đã thay đổi');
    expect(a.sources[0]?.verifiedAt).toBe('2026-11-10T00:00:00Z');
  });
  it('preserves intervals/overnight and concrete date semantics on replay', () => {
    const a = render('hours', fictionalPlace(), {
      day: 'date',
      date: '2026-11-11',
      d: 3,
      tz: 'Asia/Ho_Chi_Minh',
    });
    expect(a.text).toContain('09:00–12:00');
    expect(a.text).toContain('18:00–02:00 hôm sau');
    expect(a.text).toContain('thường lệ Thứ tư');
    expect(a.text).toContain('2026-11-11');
    expect(a.text).toContain('ngày lễ');
    expect(render('hours', fictionalPlace(), { day: 'weekday', d: 4 }).text).not.toContain(
      'đóng cửa',
    );
  });
  it.each(['vi', 'en'] as const)(
    'keeps verification and asked dates ISO with HH:mm reference hours (%s)',
    (locale) => {
      const p = fictionalPlace();
      const place = {
        ...p,
        facts: {
          hours: p.facts.hours!.map((day) => ({
            ...day,
            intervals: day.intervals.map((fact) => ({
              ...fact,
              tier: 'verified_reference' as const,
              verifiedAt: '2025-02-03T00:00:00Z',
            })),
          })),
        },
      };
      const answer = render('hours', place, {
        locale,
        day: 'date',
        date: '2026-12-25',
        d: 3,
        tz: 'Asia/Ho_Chi_Minh',
      });
      expect(answer.text).toContain('2025-02-03');
      expect(answer.text).toContain('2026-12-25');
      expect(answer.text).toContain('09:00–12:00.');
      expect(answer.text).toContain('18:00–02:00');
      expect(answer.text).toContain(
        locale === 'vi' ? '. Thông tin tham khảo' : '. Reference information',
      );
      expect(answer.tier).toBe('verified_reference');
      expect(answer.sources.every((source) => source.verifiedAt === '2025-02-03T00:00:00Z')).toBe(
        true,
      );
    },
  );
  it.each(['closed', 'open_24h'] as const)(
    'renders explicitly verified schedule kind %s',
    (kind) => {
      const a = render(
        'hours',
        { ...fictionalPlace(), facts: { hours: [{ day: 3, intervals: [verified({ kind })] }] } },
        { day: 'weekday', d: 3 },
      );
      expect(a.eligible).toBe(true);
      expect(a.text).toContain(kind === 'closed' ? 'đóng cửa' : '24 giờ');
    },
  );
  it('uses open-world amenities and never infers capacity from suitability', () => {
    expect(render('amenity', fictionalPlace(), { k: 'wifi' }).text).toContain('GoGo ghi nhận');
    expect(render('amenity', fictionalPlace(), { k: 'pool' }).text).not.toContain('không có');
    expect(render('suitability', fictionalPlace(), { s: 'group', n: 6 }).text).toContain(
      'chưa có dữ liệu',
    );
  });
  it('shows community scores only at the threshold with source/count, never Google prose laundering', () => {
    const p = fictionalPlace();
    const rating = (count: number, score: number | null) => ({
      ...verified({ source: 'community' as const, count, score }),
      source: { kind: 'community' as const, collectedAt: '2026-11-10T00:00:00Z' },
    });
    expect(render('rating', { ...p, facts: { rating: rating(4, 4.7) } }).text).not.toContain('4.7');
    expect(render('rating', { ...p, facts: { rating: rating(5, 4.7) } }).text).toContain(
      'GoGo: 4.7/5 (5',
    );
  });
  it('gone/closed/unpublished projection produces only an unavailable response', () => {
    const a = render('price', { ...fictionalPlace(), available: false });
    expect(a.unavailable).toBe(true);
    expect(a.text).not.toContain('12000');
    expect(a.text).not.toContain('Lantern');
    expect(a.sources).toEqual([]);
  });
});

describe('independently dated fact bundles', () => {
  it('keeps mixed price tiers and dates adjacent to their own amounts', () => {
    const current = verified([
      { min: 12000, max: 12000, currency: 'VND', unit: 'per_person' as const },
    ]);
    const old = {
      ...verified(
        [{ min: 100, max: 100, currency: 'USD', unit: 'per_item' as const }],
        'verified_reference',
      ),
      verifiedAt: '2020-01-01T00:00:00Z',
    };
    const a = render('price', { ...fictionalPlace(), facts: { price: [current, old] } });
    expect(a.text).toMatch(/12\.000 VND\/người.*2026-11-10.*1,00 USD\/món.*2020-01-01/);
    expect(a.sources.map((s) => s.verifiedAt)).toEqual([
      '2026-11-10T00:00:00Z',
      '2020-01-01T00:00:00Z',
    ]);
  });
  it('uses the requested schedule evidence rather than the newest other weekday', () => {
    const p = {
      ...fictionalPlace(),
      facts: {
        hours: [
          ...fictionalPlace().facts.hours!,
          {
            day: 4,
            intervals: [
              {
                ...verified({ kind: 'closed' as const }, 'verified_reference'),
                verifiedAt: '2020-01-01T00:00:00Z',
              },
            ],
          },
        ],
      },
    };
    const asked = render('hours', p, { day: 'weekday', d: 4 });
    expect(asked.text).toContain('2020-01-01');
    expect(asked.text).not.toContain('2026-11-10');
  });
  it('uses the matched amenity assignment date, never the newest tag date', () => {
    const p = {
      ...fictionalPlace(),
      facts: {
        amenity: [
          verified([{ key: 'parking', labels: { vi: 'bãi đỗ xe', en: 'parking' } }]),
          {
            ...verified(
              [{ key: 'wifi', labels: { vi: 'wifi', en: 'wifi' } }],
              'verified_reference',
            ),
            verifiedAt: '2020-01-01T00:00:00Z',
          },
        ],
      },
    };
    const asked = render('amenity', p, { k: 'wifi' });
    expect(asked.text).toContain('2020-01-01');
    expect(asked.text).not.toContain('2026-11-10');
  });
});

describe('remaining S1 topic and numeric cells', () => {
  it.each([
    ['address', '12 Fictional Street'],
    ['directions', '12 Fictional Street'],
    ['contact', '+84912345678'],
    ['parking', 'bãi đỗ xe'],
    ['overview', 'cà phê'],
    ['suitability', 'nhóm bạn'],
    ['out_of_data', 'hỏi trực tiếp địa điểm'],
  ] as const)('renders the closed %s template from its eligible fixture', (topic, value) => {
    expect(render(topic).text).toContain(value);
  });
  it('converts safe-integer minor units exactly, including near the maximum', () => {
    const p = {
      ...fictionalPlace(),
      facts: {
        price: [
          verified([
            {
              min: Number.MAX_SAFE_INTEGER,
              max: Number.MAX_SAFE_INTEGER,
              currency: 'USD',
              unit: 'per_item' as const,
            },
          ]),
        ],
      },
    };
    expect(render('price', p).text).toContain('90.071.992.547.409,91 USD/món');
  });
  it('does not promote Google-owned contacts or active-only unverified assignments', () => {
    const p = fictionalPlace();
    const address = {
      ...p.facts.address!,
      source: { kind: 'google' as const, collectedAt: '2026-11-10T00:00:00Z' },
    };
    expect(render('address', { ...p, facts: { address } }).text).not.toContain('Fictional Street');
    const amenity = { ...p.facts.amenity![0]!, tier: 'unconfirmed' } as unknown as NonNullable<
      PlaceFacts['facts']['amenity']
    >[number];
    expect(
      render('amenity', { ...p, facts: { amenity: [amenity] } }, { k: 'wifi' }).text,
    ).not.toContain('GoGo ghi nhận');
  });
});

describe('round-1 complete schedule with per-interval evidence', () => {
  it('preserves two Wednesday intervals with different dates and tiers', () => {
    const morning = verified({ kind: 'interval' as const, openMinute: 540, closeMinute: 720 });
    const evening = {
      ...verified(
        { kind: 'interval' as const, openMinute: 1080, closeMinute: 1320 },
        'verified_reference',
      ),
      verifiedAt: '2020-01-01T00:00:00Z',
    };
    const p = {
      ...fictionalPlace(),
      facts: { hours: [{ day: 3, intervals: [morning, evening] }] },
    };
    const answer = render('hours', p, { day: 'weekday', d: 3, locale: 'en' });
    expect(answer.eligible).toBe(true);
    expect(answer.text).toMatch(
      /09:00–12:00.*2026-11-10.*18:00–22:00.*Reference information verified on 2020-01-01/,
    );
    expect(answer.sources.map((s) => s.verifiedAt)).toEqual([
      morning.verifiedAt,
      evening.verifiedAt,
    ]);
  });
});

it.each(['missing evidence', 'overlap', 'closed plus interval', 'duplicate weekday'] as const)(
  'suppresses the complete weekday when it has %s',
  (invalid) => {
    const morning = verified({ kind: 'interval' as const, openMinute: 540, closeMinute: 720 });
    let evening = verified({ kind: 'interval' as const, openMinute: 1080, closeMinute: 1320 });
    if (invalid === 'missing evidence') evening = { ...evening, verifiedAt: '' };
    if (invalid === 'overlap')
      evening = { ...evening, value: { ...evening.value, openMinute: 600 } };
    const intervals =
      invalid === 'closed plus interval'
        ? [morning, verified({ kind: 'closed' as const })]
        : [morning, evening];
    const hours = [{ day: 3, intervals }];
    if (invalid === 'duplicate weekday') hours.push({ day: 3, intervals: [evening] });
    const answer = render(
      'hours',
      { ...fictionalPlace(), facts: { hours } },
      { day: 'weekday', d: 3 },
    );
    expect(answer.eligible).toBe(false);
    expect(answer.sources).toEqual([]);
    expect(answer.text).not.toMatch(/09:00|18:00|đóng cửa/);
  },
);
