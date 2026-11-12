import { describe, expect, it } from 'vitest';
import corpus from '../../eval/place-qa-cases.vi.json';
import { PlaceQaClassifier } from './classifier';
import { answerToken, parseAnswerToken } from './tokens';
const classifier = new PlaceQaClassifier();
describe('prefix and suffix clauses preserve the complete name span', () => {
  it.each([
    ['Giờ mở cửa của Quán Sao Lạ', 'hours', 'Quán Sao Lạ'],
    ['gio mo cua cua Quan Sao La', 'hours', 'Quan Sao La'],
    ['Giờ mở cửa của Quán Sao Lạa', 'hours', 'Quán Sao Lạa'],
    ['Chỗ đậu xe của Quán Sao Lạ', 'parking', 'Quán Sao Lạ'],
    ['Thông tin phù hợp của Quán Sao Lạ', 'suitability', 'Quán Sao Lạ'],
    ['Giờ mở cửa của Zzxq Vvvw Tttj 1', 'hours', 'Zzxq Vvvw Tttj 1'],
    ['Quán Sao Lạa có chỗ đậu xe không?', 'parking', 'Quán Sao Lạa'],
    ['Quán Sao Lạ có bãi đỗ xe không?', 'parking', 'Quán Sao Lạ'],
  ])('%s', (text, topic, name) => {
    expect(
      classifier.classify(text, null, { now: new Date(corpus.clock), locale: 'vi' }),
    ).toMatchObject({ kind: 'named_place_question', topic, span: { text: name } });
  });
  it('retains legacy area independently of the name', () => {
    expect(
      classifier.classify('Giờ mở cửa của Quán Sao Lạ ở Quận 1', null, {
        now: new Date(corpus.clock),
        locale: 'vi',
      }),
    ).toMatchObject({
      kind: 'named_place_question',
      span: { text: 'Quán Sao Lạ', statedArea: 'ở Quận 1' },
    });
  });
});
describe('S3 corpus grammar (diagnostic, not layer A acceptance)', () => {
  for (const c of corpus.cases)
    it(c.id, () => {
      const result = classifier.classify(
        c.text,
        c.fixture.contextPlace
          ? { kind: 'place', id: '11111111-1111-4111-8111-111111111111' }
          : null,
        { now: new Date(c.fixture.clock), locale: 'vi' },
      );
      if (c.expected.outcome === 'not_qa') expect(result.kind).toBe('not_qa');
      else {
        expect(result.kind).not.toBe('not_qa');
        if ('topic' in c.expected && 'topic' in result) expect(result.topic).toBe(c.expected.topic);
        if ('span' in result && !['overflow-narrow', 'legacy-confirm'].includes(c.id)) {
          expect(result.span.text).not.toMatch(
            /(?:giá bao nhiêu|mở cửa|đánh giá|hợp hẹn hò|thông tin|wifi|menu|đi đường nào|số điện thoại|chỗ đậu xe|đi nhóm)/iu,
          );
        }
        if ('args' in result)
          expect(
            parseAnswerToken(
              answerToken({
                ...result.args,
                topic: result.topic,
                locale: 'vi',
                placeId: '11111111-1111-4111-8111-111111111111',
              }),
            ),
          ).not.toBeNull();
      }
    });
});
describe('protected name tokens and semantic dates', () => {
  it.each([
    'Cafe Mới mở cửa mấy giờ?',
    'Cafe Gần mở cửa mấy giờ?',
    'Cafe Tìm mở cửa mấy giờ?',
    'Quán Có có wifi không?',
  ])('retains identifying name: %s', (text) => {
    expect(
      classifier.classify(text, null, { now: new Date(corpus.clock), locale: 'vi' }),
    ).toMatchObject({ kind: 'named_place_question' });
  });
  it('pins relative date once in place-local timezone', () => {
    const r = classifier.classify('Quán Sao Lạ mở cửa ngày mai?', null, {
      now: new Date('2026-11-11T18:00:00Z'),
      locale: 'vi',
    });
    expect(r).toMatchObject({
      topic: 'hours',
      args: { day: 'date', date: '2026-11-13', d: 5, tz: 'Asia/Ho_Chi_Minh' },
    });
  });
  it('clarifies an invalid explicit date without guessing weekday', () => {
    expect(
      classifier.classify('Quán Sao Lạ mở cửa 2026-02-30?', null, {
        now: new Date(corpus.clock),
        locale: 'vi',
      }).kind,
    ).toBe('clarify_referent');
  });
});

describe('English grammar and command/name collisions', () => {
  it.each([
    ['Where is Fictional Lantern?', 'address', 'Fictional Lantern'],
    ['Does Fictional Lantern have wifi?', 'amenity', 'Fictional Lantern'],
    ['Is Fictional Lantern open today?', 'hours', 'Fictional Lantern'],
    ['Phone number of Fictional Lantern', 'contact', 'Fictional Lantern'],
    ['Cafe Đánh Giá giá bao nhiêu?', 'price', 'Cafe Đánh Giá'],
    ['GoGo Cafe đánh giá thế nào?', 'rating', 'GoGo Cafe'],
    ['Tạo Kèo Bistro mở cửa mấy giờ?', 'hours', 'Tạo Kèo Bistro'],
  ])('%s', (text, topic, name) => {
    const result = classifier.classify(text, null, {
      now: new Date(corpus.clock),
      locale: /Fictional/.test(text) ? 'en' : 'vi',
    });
    expect(result).toMatchObject({ kind: 'named_place_question', topic, span: { text: name } });
  });
  it('keeps a topic noun inside a full name as an equality-only probe', () => {
    expect(
      classifier.classify('Cafe Wifi', null, { now: new Date(corpus.clock), locale: 'vi' }),
    ).toMatchObject({ kind: 'name_only', span: { text: 'Cafe Wifi' } });
  });
});

describe('semantic arguments belong to the asked clause, never identifying name tokens', () => {
  it.each([
    ['Cafe Wifi có máy lạnh không?', 'amenity', { k: 'air_conditioning' }],
    ['Quán 6 Người hợp hẹn hò không?', 'suitability', { s: 'couple' }],
    ['Cafe 2026-12-25 mở cửa mấy giờ?', 'hours', { day: 'date', date: '2026-11-11' }],
  ])('%s', (text, topic, args) => {
    expect(
      classifier.classify(text, null, { now: new Date(corpus.clock), locale: 'vi' }),
    ).toMatchObject({ topic, args });
  });
});

describe('Astra A1: initial named questions protect command words', () => {
  it.each([
    ['Cafe Gợi Ý Quán Ngon giá bao nhiêu?', 'Cafe Gợi Ý Quán Ngon', 'vi'],
    ['Nhà hàng Tìm Quán Cafe mở cửa mấy giờ?', 'Nhà hàng Tìm Quán Cafe', 'vi'],
    ['Giá của Cafe Gợi Ý Quán Ngon', 'Cafe Gợi Ý Quán Ngon', 'vi'],
    ['Cafe Tạo Kèo mở cửa mấy giờ?', 'Cafe Tạo Kèo', 'vi'],
    ['Cafe Suggest and Find is open today?', 'Cafe Suggest and Find', 'en'],
  ] as const)('%s', (text, name, locale) => {
    expect(classifier.classify(text, null, { now: new Date(corpus.clock), locale })).toMatchObject({
      kind: 'named_place_question',
      span: { text: name },
    });
  });
  it.each([
    'Gợi ý quán giống Cafe Gợi Ý Quán Ngon',
    'Cafe Gợi Ý Quán Ngon giá bao nhiêu? Và gợi ý quán khác',
    'Tạo kèo ở Cafe Tìm Quán Cafe',
    'Giá của Song Ngọc và tạo kèo ở đó',
  ])('external command still wins: %s', (text) => {
    expect(
      classifier.classify(text, null, { now: new Date(corpus.clock), locale: 'vi' }).kind,
    ).toBe('not_qa');
  });
});

describe('GoGo-BE#875 ticket-price span', () => {
  it.each([
    'Giá vé Rạp Sao Mộc Bến Sương bao nhiêu?',
    'Giá vé của Rạp Sao Mộc Bến Sương bao nhiêu?',
    'Giá vé Rạp Sao Mộc Bến Sương là bao nhiêu?',
  ])('%s strips the whole topic head and terminal question', (text) => {
    const result = classifier.classify(text, null, { now: new Date(corpus.clock), locale: 'vi' });
    expect(result).toMatchObject({
      kind: 'named_place_question',
      topic: 'price',
      span: { text: 'Rạp Sao Mộc Bến Sương' },
    });
    if ('span' in result)
      expect(text.slice(result.span.start, result.span.end)).toBe(result.span.text);
  });
});

describe('GoGo-BE#876 ticket grammar name collisions', () => {
  it.each(['Rạp Bao Nhiêu', 'Rạp Là Bao Nhiêu', 'Rạp Vé Bao Nhiêu', 'Rạp Vé', 'Rạp Vé Sao Mộc'])(
    'bare complete name: %s',
    (name) => {
      expect(
        classifier.classify(name, null, { now: new Date(corpus.clock), locale: 'vi' }),
      ).toMatchObject({
        kind: 'name_only',
        topic: 'overview',
        span: { text: name },
      });
    },
  );
  it.each(['Rạp Bao Nhiêu', 'Rạp Vé', 'Vé Rạp Sao Mộc'])(
    'explicit information preserves %s',
    (name) => {
      const result = classifier.classify(`Thông tin ${name}`, null, {
        now: new Date(corpus.clock),
        locale: 'vi',
      });
      expect(result).toMatchObject({ kind: 'named_place_question', topic: 'overview' });
      if ('span' in result)
        expect([result.span.text, ...(result.span.alternates ?? []).map((a) => a.text)]).toContain(
          name,
        );
    },
  );
  it.each(['Rạp Bao Nhiêu', 'Rạp Vé', 'Vé Rạp Sao Mộc'])(
    'ticket question preserves name reading: %s',
    (name) => {
      const text = `Giá vé ${name} bao nhiêu?`;
      const result = classifier.classify(text, null, { now: new Date(corpus.clock), locale: 'vi' });
      expect(result).toMatchObject({ kind: 'named_place_question', topic: 'price' });
      if ('span' in result) {
        const readings = [result.span.text, ...(result.span.alternates ?? []).map((a) => a.text)];
        expect(readings).toContain(name);
        expect(readings).toContain(`${name} bao nhiêu`);
        expect(readings).toContain(`vé ${name}`);
      }
    },
  );
});
