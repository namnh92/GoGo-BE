import { describe, expect, it } from 'vitest';
import { renderPlaceAnswer } from '../../assistant/domain/place-qa/templates';
import {
  factForSurface,
  freezeFactContext,
  placeTopicEligible,
  priceFact,
  projectPlaceFacts,
  type HoursFactRow,
  type PlaceFactRow,
  type PriceFactRow,
} from './place-facts';

const now = new Date('2026-11-11T17:01:00Z');
const verifiedAt = '2025-02-03T10:00:00Z';
const price: PriceFactRow = {
  price_min: '0',
  price_max: '0',
  currency: 'VND',
  unit: 'per_person',
  confidence: '0.70',
  source: 'editor',
  verified_at: verifiedAt,
};
const hour: HoursFactRow = {
  day_of_week: 1,
  entry_kind: 'interval',
  open_minute: 480,
  close_minute: 660,
  is_overnight: false,
  source: 'editor',
  verified_at: verifiedAt,
};
const row = (over: Partial<PlaceFactRow> = {}): PlaceFactRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  status: 'published',
  provider_closed: false,
  name: 'Cafe giả định',
  lat: 10,
  lng: 106,
  area_summary: null,
  address_text: null,
  phone: null,
  provenance: [],
  hours: [],
  prices: [],
  gogo_rating_count: 0,
  gogo_rating_mean: null,
  ...over,
});

describe('S2 fact policy: verified, unconfirmed-as-absent, absent', () => {
  it('never treats ownership/publication/place freshness as verification; Q-2 cannot enable price', () => {
    const facts = projectPlaceFacts(
      row({
        prices: [{ ...price, verified_at: null }],
        hours: [{ ...hour, verified_at: null }],
        address_text: '12 đường giả định',
      }),
      now,
    );
    expect(facts.available).toBe(true);
    if (!facts.available) return;
    expect(facts.facts.price).toBeUndefined();
    expect(facts.facts.hours).toBeUndefined();
    expect(facts.facts.address).toBeUndefined();
    expect(placeTopicEligible(facts, 'price')).toBe(false);
    expect(placeTopicEligible(facts, 'amenity', { key: 'wifi' })).toBe(false);
    expect(placeTopicEligible(facts, 'suitability', { key: 'group', capacity: 6 })).toBe(false);
    expect(placeTopicEligible(facts, 'overview')).toBe(false);
    expect(facts.facts.openNow).toBeUndefined();
  });
  it('retains true zero, units/currencies and own dates; reference cannot enter compact cards', () => {
    const value = priceFact(price, now);
    expect(value).toMatchObject({
      tier: 'verified_reference',
      value: { min: 0, max: 0, unit: 'per_person', currency: 'VND' },
      verifiedAt: '2025-02-03T10:00:00.000Z',
      warning: 'confirm_with_place',
    });
    expect(factForSurface(value, 'card', true).tier).toBe('absent');
    expect(factForSurface(value, 'prose', false).tier).toBe('absent');
    expect(factForSurface(value, 'prose', true)).toBe(value);
    for (const unit of ['per_person', 'per_item', 'per_hour', 'per_night'])
      for (const currency of ['VND', 'USD'])
        expect(priceFact({ ...price, unit, currency }, now).tier).toBe('verified_reference');
    for (const over of [
      { unit: null },
      { unit: 'per_group' },
      { price_min: null },
      { price_max: null },
      { price_min: '9007199254740992' },
      { price_min: '1.5' },
      { price_min: -1 },
      { price_max: -1 },
      { currency: null },
      { currency: 'vnd' },
      { currency: 'ZZZ' },
      { confidence: null },
      { confidence: 'NaN' },
      { source: 'provider' },
      { verified_at: '2027-01-01' },
    ])
      expect(priceFact({ ...price, ...over }, now).tier).toBe('absent');
  });
  it('property: any absent bound/unit or invalid minor integer stays absent, never free', () => {
    for (let n = 0; n < 100; n++) {
      expect(
        priceFact({ ...price, price_min: String(n), price_max: String(n + 10), unit: null }, now)
          .tier,
      ).toBe('absent');
      expect(priceFact({ ...price, price_min: n + 0.1, price_max: n + 10 }, now).tier).toBe(
        'absent',
      );
      expect(priceFact({ ...price, price_min: null, price_max: n }, now).tier).toBe('absent');
    }
  });
  it('validates independent field evidence as well as field verification', () => {
    const provenance = {
      field: 'address_text',
      source_type: 'editorial',
      source_reference: 'merchant attestation',
      collected_at: '2025-02-01T10:00:00Z',
      verified_at: verifiedAt,
    };
    const facts = projectPlaceFacts(
      row({ address_text: '12 Đường Giả Định', provenance: [provenance] }),
      now,
    );
    expect(facts).toMatchObject({
      facts: {
        address: {
          tier: 'verified_reference',
          value: '12 Đường Giả Định',
          source: { kind: 'gogo', collectedAt: '2025-02-01T10:00:00.000Z' },
        },
      },
    });
    for (const over of [
      { source_type: 'google_derived' },
      { source_reference: 'Google Maps' },
      { source_reference: 'sheet 123' },
      { collected_at: null },
      { verified_at: null },
      { verified_at: 'bad' },
      { collected_at: '2027-01-01T10:00:00Z' },
    ])
      expect(
        projectPlaceFacts(
          row({ address_text: '12 Đường Giả Định', provenance: [{ ...provenance, ...over }] }),
          now,
        ),
      ).not.toHaveProperty('facts.address');
  });
  it('every interval must be verified; multiple/overnight/24h/closed preserve weekly semantics', () => {
    const facts = projectPlaceFacts(
      row({
        hours: [
          hour,
          { ...hour, open_minute: 1020, close_minute: 1380, verified_at: '2025-02-04T10:00:00Z' },
          { ...hour, day_of_week: 2, open_minute: 1200, close_minute: 120, is_overnight: true },
          { ...hour, day_of_week: 4, entry_kind: 'open_24h', open_minute: 0, close_minute: 0 },
          { ...hour, day_of_week: 5, entry_kind: 'closed', open_minute: 0, close_minute: 0 },
        ],
      }),
      now,
    );
    expect(facts.facts.hours).toMatchObject([
      {
        day: 1,
        intervals: [
          { tier: 'verified_reference', value: { openMinute: 480 } },
          { tier: 'verified_reference', value: { openMinute: 1020 } },
        ],
      },
      { day: 2, intervals: [{ value: { overnight: true } }] },
      { day: 4, intervals: [{ value: { kind: 'open_24h' } }] },
      { day: 5, intervals: [{ value: { kind: 'closed' } }] },
    ]);
    expect(facts.facts.openNow).toBeUndefined();
    expect(placeTopicEligible(facts, 'hours', { day: 3 })).toBe(false);
    for (const hours of [
      [hour, { ...hour, open_minute: 1020, close_minute: 1380, verified_at: null }],
      [
        { ...hour, open_minute: 1000, close_minute: 500, is_overnight: true },
        { ...hour, open_minute: 400, close_minute: 600, day_of_week: 2 },
      ],
      [{ ...hour, entry_kind: 'closed' }, hour],
    ]) {
      const invalid = projectPlaceFacts(row({ hours }), now);
      expect(invalid.facts.hours).toBeUndefined();
      expect(placeTopicEligible(invalid, 'hours', { day: 1 })).toBe(false);
    }
  });
  it('live GoGo aggregate retains count/source/threshold with actual moderation and collection dates', () => {
    for (let count = 0; count < 10; count++) {
      const facts = projectPlaceFacts(
        row({
          gogo_rating_count: count,
          gogo_rating_mean: count ? '4.3' : null,
          gogo_rating_verified_at: verifiedAt,
          gogo_rating_collected_at: '2025-02-01T10:00:00Z',
          gogo_rating_latest_verified_at: '2026-11-11T17:01:00Z',
          gogo_rating_latest_collected_at: '2026-11-10T10:00:00Z',
        }),
        now,
      );
      expect(facts.facts.rating).toEqual({
        tier: 'verified_current',
        value: { source: 'community', count, score: count >= 5 ? 4.3 : null },
        verifiedAt: '2025-02-03T10:00:00.000Z',
        source: { kind: 'community', collectedAt: '2025-02-01T10:00:00.000Z' },
      });
      expect(placeTopicEligible(facts, 'rating')).toBe(true);
      expect(facts.facts.providerRating).toBeUndefined();
    }
    // Do not invent verification/collection dates for legacy review aggregates.
    expect(
      projectPlaceFacts(row({ gogo_rating_count: 5, gogo_rating_mean: '4.3' }), now).facts.rating,
    ).toBeUndefined();
  });
  it('closed/unpublished has no facts or name; freezes the shared response context', () => {
    for (const over of [
      { status: 'draft' },
      { status: 'suspended' },
      { status: 'archived' },
      { provider_closed: true },
    ])
      expect(projectPlaceFacts(row(over), now)).toEqual({
        id: row().id,
        available: false,
        name: '',
        facts: {},
      });
    const context = freezeFactContext(
      new Map([[row().id, projectPlaceFacts(row({ prices: [price] }), now)]]),
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.places.get(row().id)!.facts.price![0]!.value)).toBe(true);
    expect(context.places).not.toHaveProperty('set');
    expect([...context.places.keys()]).toEqual([row().id]);
    expect(
      renderPlaceAnswer({ placeId: row().id, topic: 'price', locale: 'vi' }, context).eligible,
    ).toBe(true);
    expect(Object.isFrozen(context.places.get(row().id))).toBe(true);
  });
});

describe('round-1 canonical projection regressions', () => {
  it('Sol F-01 / Astra F-03: exposes S1 renderer facts, name and no S2 identity seam', () => {
    const projected = projectPlaceFacts(row({ prices: [price] }), now);
    expect(projected).toMatchObject({
      name: row().name,
      facts: {
        price: [
          {
            tier: 'verified_reference',
            value: [{ min: 0, max: 0, currency: 'VND', unit: 'per_person' }],
          },
        ],
      },
    });
    expect(projected).not.toHaveProperty('identity');
  });
  it('keeps each interval date/tier and requires every interval to pass S1 evidence gates', () => {
    const projected = projectPlaceFacts(
      row({
        hours: [
          { ...hour, verified_at: '2025-02-04T10:00:00Z' },
          { ...hour, open_minute: 1020, close_minute: 1380 },
        ],
      }),
      now,
    );
    const schedule = projected.facts.hours![0]!;
    expect(schedule).toEqual({
      day: 1,
      intervals: [
        {
          tier: 'verified_reference',
          verifiedAt: '2025-02-04T10:00:00.000Z',
          source: { kind: 'gogo', collectedAt: '2025-02-04T10:00:00.000Z' },
          value: { kind: 'interval', openMinute: 480, closeMinute: 660, overnight: false },
        },
        {
          tier: 'verified_reference',
          verifiedAt: '2025-02-03T10:00:00.000Z',
          source: { kind: 'gogo', collectedAt: '2025-02-03T10:00:00.000Z' },
          value: { kind: 'interval', openMinute: 1020, closeMinute: 1380, overnight: false },
        },
      ],
    });
    expect(placeTopicEligible(projected, 'hours', { day: 1 })).toBe(true);
    const answer = renderPlaceAnswer(
      { placeId: projected.id, topic: 'hours', locale: 'vi', day: 'weekday', d: 1 },
      { places: new Map([[projected.id, projected]]) },
    );
    expect(answer.eligible).toBe(true);
    expect(answer.sources.map((source) => source.verifiedAt)).toEqual(
      schedule.intervals.map((interval) => interval.verifiedAt),
    );
    expect(answer.text).toContain('08:00–11:00. Thông tin tham khảo, xác minh ngày 2025-02-04');
    expect(answer.text).toContain('17:00–23:00. Thông tin tham khảo, xác minh ngày 2025-02-03');
    // Either interval failing S1 evidence gates suppresses the whole weekday.
    for (const index of [0, 1]) {
      const interval = schedule.intervals[index]!;
      for (const invalid of [
        { ...interval, verifiedAt: '' },
        { ...interval, source: { ...interval.source, collectedAt: '' } },
        { ...interval, source: { ...interval.source, kind: 'google' as const } },
      ]) {
        expect(
          placeTopicEligible(
            {
              ...projected,
              facts: {
                hours: [
                  {
                    ...schedule,
                    intervals: schedule.intervals.map((fact, i) => (i === index ? invalid : fact)),
                  },
                ],
              },
            },
            'hours',
            { day: 1 },
          ),
        ).toBe(false);
      }
    }
    expect(
      placeTopicEligible(
        projectPlaceFacts(
          row({
            hours: [hour, { ...hour, open_minute: 1020, close_minute: 1380, verified_at: null }],
          }),
          now,
        ),
        'hours',
        { day: 1 },
      ),
    ).toBe(false);
  });
  it('Sol F-05: unsupported uppercase currency never enables the price topic', () => {
    expect(priceFact({ ...price, currency: 'ZZZ' }, now).tier).toBe('absent');
    expect(
      placeTopicEligible(
        projectPlaceFacts(row({ prices: [{ ...price, currency: 'ZZZ' }] }), now),
        'price',
      ),
    ).toBe(false);
  });
});

describe('confirm-round projection regressions', () => {
  const rated = (over: Partial<PlaceFactRow>) =>
    projectPlaceFacts(
      row({
        gogo_rating_count: 6,
        gogo_rating_mean: '4.3',
        gogo_rating_verified_at: verifiedAt,
        gogo_rating_collected_at: '2025-02-01T10:00:00Z',
        gogo_rating_latest_verified_at: verifiedAt,
        gogo_rating_latest_collected_at: '2025-02-01T10:00:00Z',
        ...over,
      }),
      now,
    );
  it('Sol F-02: one future-dated review suppresses the whole aggregate, old rows cannot vouch for it', () => {
    expect(rated({}).facts.rating).toMatchObject({ tier: 'verified_current', value: { count: 6 } });
    for (const over of [
      { gogo_rating_latest_verified_at: '2026-11-11T17:01:01Z' },
      { gogo_rating_latest_collected_at: '2026-11-11T17:01:01Z' },
      { gogo_rating_latest_verified_at: null },
      { gogo_rating_latest_collected_at: null },
      { gogo_rating_latest_verified_at: 'not-a-date' },
    ] satisfies Partial<PlaceFactRow>[]) {
      const facts = rated(over);
      expect(facts.facts.rating).toBeUndefined();
      expect(placeTopicEligible(facts, 'rating')).toBe(false);
    }
  });
});
