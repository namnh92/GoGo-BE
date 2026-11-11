import { describe, expect, it } from 'vitest';
import { placeNameVariants, resolvePlaceNameOutcome, type PlaceNameCandidate } from './resolution';
import { extractComparisonPlaceNameSpans, extractPlaceNameSpan } from './span';

const matches = (candidates: PlaceNameCandidate[], overflow = false, areaMismatch = false) => ({
  candidates,
  overflow,
  areaMismatch,
});
describe('S2 resolution truth table', () => {
  it('only whole exact unique can answer; fuzzy never answers, regardless of margin', () => {
    for (let i = 0; i <= 100; i++) {
      const score = i / 100;
      const result = resolvePlaceNameOutcome(matches([{ id: 'a', score, exact: false }]));
      expect(result.kind).toBe(score >= 0.35 ? 'confirm' : 'not_found');
    }
    expect(resolvePlaceNameOutcome(matches([{ id: 'a', score: 1, exact: true }])).kind).toBe(
      'answer',
    );
  });
  it('overflow and unsafe area/parsing take precedence over exact uniqueness', () => {
    const candidate = { id: 'a', score: 1, exact: true };
    expect(resolvePlaceNameOutcome(matches([candidate], true)).kind).toBe('narrow');
    expect(resolvePlaceNameOutcome(matches([candidate]), { ambiguous: true }).kind).toBe('narrow');
    expect(
      resolvePlaceNameOutcome(matches([candidate]), { area: { kind: 'unresolved' } }).kind,
    ).toBe('narrow');
    expect(resolvePlaceNameOutcome(matches([candidate]), { area: { kind: 'legacy' } }).kind).toBe(
      'confirm',
    );
    expect(resolvePlaceNameOutcome(matches([candidate], false, true)).kind).toBe('choice');
    expect(
      resolvePlaceNameOutcome(
        matches([{ id: 'weak-elsewhere', score: 0.1, exact: false }], false, true),
      ),
    ).toMatchObject({ kind: 'not_found', candidates: [] });
  });
  it('branch families choose, ties only order cards, 0.35 is confirm and at most three display', () => {
    expect(
      resolvePlaceNameOutcome(matches([{ id: 'boundary', score: Math.fround(0.35), exact: false }]))
        .kind,
    ).toBe('confirm');
    const candidates = ['d', 'c', 'b', 'a'].map((id) => ({ id, score: 0.35, exact: false }));
    expect(resolvePlaceNameOutcome(matches(candidates))).toMatchObject({
      kind: 'confirm',
      candidates: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    expect(
      resolvePlaceNameOutcome(matches(candidates.map((c) => ({ ...c, exact: true })))).kind,
    ).toBe('choice');
  });
  it('punctuation variants are bounded and diacritics do not erase identifying tokens', () => {
    expect(placeNameVariants("Pizza 4P's Bến Thành")).toEqual([
      "pizza 4p's ben thanh",
      'pizza 4ps ben thanh',
      'pizza 4p s ben thanh',
    ]);
    expect(placeNameVariants('Pizza 4ps Ben Thanh')).toEqual(
      placeNameVariants("Pizza 4P's Bến Thành"),
    );
    for (const name of ['Cafe Mới Gần Tìm 24 Quận 1', 'Bến Thành', 'Cafe', 'Quận 9']) {
      expect(placeNameVariants(name).length).toBeLessThanOrEqual(3);
      expect(extractPlaceNameSpan(name)).toMatchObject({ kind: 'span', text: name });
    }
  });
});

describe('S2 positional span extraction (route admission belongs to S3)', () => {
  it('comparison grammar produces at most two original spans; và in a name is preserved', () => {
    for (const text of [
      'Mây và Mưa với Tonkin quán nào rẻ hơn?',
      'So sánh Mây và Tonkin về giá?',
    ]) {
      const result = extractComparisonPlaceNameSpans(text);
      expect(result.kind).toBe('spans');
      if (result.kind === 'spans') {
        expect(result.spans[1].text).toBe('Tonkin');
        for (const span of result.spans) expect(text.slice(span.start, span.end)).toBe(span.text);
      }
    }
    expect(extractPlaceNameSpan('Mây và Mưa')).toMatchObject({ text: 'Mây và Mưa' });
    expect(extractComparisonPlaceNameSpans('Mây và Mưa')).toEqual({ kind: 'ambiguous' });
    expect(extractComparisonPlaceNameSpans('A với B với C quán nào rẻ hơn?')).toEqual({
      kind: 'ambiguous',
    });
  });
  it.each([
    ['Giờ mở cửa của Cafe Mới 24?', 'Cafe Mới 24'],
    ['Tonkin mở cửa mấy giờ?', 'Tonkin'],
    ['Tonkin đánh giá thế nào?', 'Tonkin'],
    ['Tonkin có wifi không?', 'Tonkin'],
    ['Tonkin không có wifi?', 'Tonkin'],
    ["Pizza 4P's Bến Thành ở đâu?", "Pizza 4P's Bến Thành"],
    ['Thông tin về Cafe Gần Tìm Mới', 'Cafe Gần Tìm Mới'],
    ['Giờ mở cửa của Cà phê Bến Thành?', 'Cà phê Bến Thành'],
  ])('%s keeps original name tokens/offsets', (text, expected) => {
    const result = extractPlaceNameSpan(text);
    expect(result).toMatchObject({ kind: 'span', text: expected });
    if (result.kind === 'span') expect(text.slice(result.start, result.end)).toBe(expected);
  });
  it('removes only an explicitly identified trailing area clause', () => {
    const text = 'Giờ mở cửa của Cafe Quận 1 ở Quận 9?';
    const result = extractPlaceNameSpan(text, { start: text.indexOf('ở Quận'), end: text.length });
    expect(result).toMatchObject({ kind: 'span', text: 'Cafe Quận 1', statedArea: 'ở Quận 9?' });
    expect(extractPlaceNameSpan('Cafe A với Cafe B mở cửa mấy giờ?')).toEqual({
      kind: 'ambiguous',
    });
    expect(extractPlaceNameSpan('')).toEqual({ kind: 'ambiguous' });
    expect(extractPlaceNameSpan('Cafe Quận 1 ở Quận 9 có wifi không?')).toMatchObject({
      kind: 'span',
      text: 'Cafe Quận 1',
      statedArea: 'ở Quận 9',
    });
    expect(extractPlaceNameSpan('Giờ mở cửa Cafe Quận 1 ở Quận 2?')).toMatchObject({
      kind: 'span',
      text: 'Cafe Quận 1',
      statedArea: 'ở Quận 2?',
    });
    expect(extractPlaceNameSpan('Giờ mở cửa Tonkin ở vùng không rõ?')).toEqual({
      kind: 'ambiguous',
    });
  });
});

describe('round-1 name regressions', () => {
  it('Sol F-04 / Astra F-02: every approved spelling has the same complete exact set', () => {
    const names = ["Pizza 4P's Bến Thành", 'Pizza 4ps Bến Thành', 'Pizza 4P s Bến Thành'];
    const expected = placeNameVariants(names[0]!);
    for (const name of names) {
      expect(placeNameVariants(name)).toEqual(expected);
      const candidates = names.map((stored, i) => ({
        id: String(i),
        score: 1,
        exact: placeNameVariants(name).includes(placeNameVariants(stored)[0]!),
      }));
      expect(resolvePlaceNameOutcome(matches(candidates))).toMatchObject({
        kind: 'choice',
        candidates: [{ exact: true }, { exact: true }, { exact: true }],
      });
    }
  });
  it('Astra F-01: topic-like identifying tokens cannot select the shorter catalogue collision', () => {
    const catalogue = ['Gia Bảo', 'Bảo'];
    const parsed = extractPlaceNameSpan('Gia Bảo mở cửa mấy giờ?');
    expect(parsed).toMatchObject({ kind: 'span', text: 'Gia Bảo' });
    if (parsed.kind === 'span') {
      const candidates = catalogue
        .filter((name) => name === parsed.text)
        .map((id) => ({ id, exact: true, score: 1 }));
      expect(resolvePlaceNameOutcome(matches(candidates))).toMatchObject({
        kind: 'answer',
        candidates: [{ id: 'Gia Bảo' }],
      });
    }
    expect(extractPlaceNameSpan('Gia Bảo')).toEqual({ kind: 'ambiguous' });
  });
  it('Sol F-03: negated suffix is stripped after automatic trailing-area detection', () => {
    const text = 'Mây Lam không có wifi ở Quận 9?';
    const parsed = extractPlaceNameSpan(text);
    expect(parsed).toMatchObject({ kind: 'span', text: 'Mây Lam', statedArea: 'ở Quận 9?' });
    if (parsed.kind === 'span') expect(text.slice(parsed.start, parsed.end)).toBe('Mây Lam');
  });
  it('Astra F-04: both comparison area offsets refer to the original message', () => {
    const text = 'So sánh Mây ở Phường X và Tonkin ở Phường Y về giá?';
    const parsed = extractComparisonPlaceNameSpans(text);
    expect(parsed.kind).toBe('spans');
    if (parsed.kind === 'spans') {
      expect(parsed.spans.map((span) => span.text)).toEqual(['Mây', 'Tonkin']);
      expect(parsed.spans.map((span) => span.statedArea)).toEqual(['ở Phường X', 'ở Phường Y']);
      for (const span of parsed.spans) {
        expect(text.slice(span.start, span.end)).toBe(span.text);
        expect(text.slice(span.areaSpan!.start, span.areaSpan!.end)).toBe(span.statedArea);
      }
    }
  });
});

describe('confirm-round name regressions', () => {
  const resolveAgainst = (catalogue: readonly string[], span: string) =>
    resolvePlaceNameOutcome(
      matches(
        catalogue
          .filter((name) => placeNameVariants(span).includes(placeNameVariants(name)[0]!))
          .map((id) => ({ id, exact: true, score: 1 })),
      ),
    );
  it.each([
    ['Cafe Wifi mở cửa mấy giờ?', undefined],
    ['Cafe Wifi mở cửa mấy giờ ở Quận 9?', 'ở Quận 9?'],
    ['Cafe Wifi ở Quận 9 mở cửa mấy giờ?', 'ở Quận 9'],
    ['Cafe Wifi có wifi không?', undefined],
    ['Cafe Wifi không có wifi ở Quận 9?', 'ở Quận 9?'],
    ['Giờ mở cửa của Cafe Wifi?', undefined],
    ['Giờ mở cửa của Cafe Wifi ở Quận 9?', 'ở Quận 9?'],
  ])('Astra F-01: "%s" consumes one question clause and keeps Wifi', (text, statedArea) => {
    const parsed = extractPlaceNameSpan(text);
    expect(parsed).toMatchObject({ kind: 'span', text: 'Cafe Wifi' });
    if (parsed.kind !== 'span') return;
    expect(text.slice(parsed.start, parsed.end)).toBe('Cafe Wifi');
    expect(parsed.statedArea).toBe(statedArea);
    // The shorter catalogue collision is never the direct answer.
    expect(resolveAgainst(['Cafe Wifi', 'Cafe'], parsed.text)).toMatchObject({
      kind: 'answer',
      candidates: [{ id: 'Cafe Wifi' }],
    });
  });
  it.each([
    'Cafe Wifi?',
    'Cafe Wifi',
    'Cafe Wifi ở Quận 9?',
    'Tonkin Price',
    'Sunset Address?',
    'Cafe Chỗ Đậu Xe',
  ])('Astra F-01: bare topic noun "%s" is an uncertain boundary, never a guessed core', (text) => {
    expect(extractPlaceNameSpan(text)).toEqual({ kind: 'ambiguous' });
  });
  it('Astra F-01: one clause is still removed around an area, in either order', () => {
    for (const [text, area] of [
      ['Mây Lam không có wifi ở Quận 9?', 'ở Quận 9?'],
      ['Mây Lam ở Quận 9 không có wifi?', 'ở Quận 9'],
      ['Mây Lam có chỗ đậu xe không?', undefined],
    ] as const) {
      const parsed = extractPlaceNameSpan(text);
      expect(parsed).toMatchObject({ kind: 'span', text: 'Mây Lam' });
      if (parsed.kind === 'span') expect(parsed.statedArea).toBe(area);
    }
  });
  it('Sol F-04: only the digit-brand token varies; unrelated punctuation is preserved', () => {
    const spellings = ["O'Leary Pizza 4ps", "O'Leary Pizza 4P's", "O'Leary Pizza 4P s"];
    const expected = ["o'leary pizza 4p's", "o'leary pizza 4ps", "o'leary pizza 4p s"];
    for (const spelling of spellings) {
      expect(placeNameVariants(spelling)).toEqual(expected);
      // Stored/input self-exactness: an exact unique match answers directly.
      expect(resolveAgainst(spellings.slice(0, 1), spelling)).toMatchObject({
        kind: 'answer',
        candidates: [{ id: spellings[0], exact: true }],
      });
      // All three equivalent spellings form one branch family from any input.
      expect(resolveAgainst(spellings, spelling)).toMatchObject({ kind: 'choice' });
      expect(resolveAgainst(spellings, spelling).candidates).toHaveLength(3);
    }
    expect(placeNameVariants('O\u2019Leary Pizza 4P\u2019s')).toEqual(expected);
    // The apostrophe-free name is a different venue, not a spelling variant.
    expect(placeNameVariants("O'Leary Pizza 4ps")).not.toContain('oleary pizza 4ps');
  });
  it('Sol F-04 property: the whole folded name is always in its own bounded variant set', () => {
    for (const name of [
      "O'Leary Pizza 4ps",
      "L'Usine Lê Lợi",
      'A&B Coffee - Chi nhánh 2',
      "Mr. Bean's 24h",
      'Phở 24 (Nguyễn Trãi)',
      "4P's 5K's",
      '4ps 5ks',
      "Pizza 4P's Bến Thành",
      'Cafe 7 S Tower',
      'Bún Chả 36s',
      'Mây Lam',
    ]) {
      const variants = placeNameVariants(name);
      expect(variants.length).toBeGreaterThanOrEqual(1);
      expect(variants.length).toBeLessThanOrEqual(3);
      expect(variants).toContain(
        name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase(),
      );
      // Symmetry: every member of the set generates exactly the same set.
      for (const variant of variants) expect(placeNameVariants(variant)).toEqual(variants);
    }
  });
});

describe('round-3 boundary regressions: grammar-like name tokens', () => {
  /** Catalogue-side whole-name equality, as the SQL exact channel decides it. */
  const resolveReadings = (catalogue: readonly string[], message: string) => {
    const parsed = extractPlaceNameSpan(message);
    if (parsed.kind !== 'span') return { parsed, outcome: undefined };
    const keys = [parsed.text, ...(parsed.alternates ?? []).map((a) => a.text)].flatMap(
      placeNameVariants,
    );
    const outcome = resolvePlaceNameOutcome(
      matches(
        catalogue
          .filter((name) => keys.includes(placeNameVariants(name)[0]!))
          .map((id) => ({ id, exact: true, score: 1 })),
      ),
    );
    return { parsed, outcome };
  };
  it('round-4: explicit topic retains the complete Cafe Không Có Wifi reading', () => {
    expect(
      resolveReadings(['Cafe', 'Cafe Không Có Wifi'], 'Giờ mở cửa của Cafe Không Có Wifi?').outcome,
    ).toMatchObject({ kind: 'choice' });
  });
  it('round-4: generated grammar/name collisions preserve every boundary combination', () => {
    for (const prefix of ['', 'Giờ mở cửa của ', 'Thông tin về ', 'opening hours of ']) {
      for (const clause of [
        'không có wifi',
        'có chỗ đậu xe không',
        'mở cửa mấy giờ',
        'địa chỉ là gì',
      ]) {
        const message = `${prefix}Cafe ${clause}?`;
        const prefixTokens = prefix.trim().split(/\s+/).filter(Boolean);
        const suffixTokens = clause.split(' ');
        const parsed = extractPlaceNameSpan(message);
        expect(parsed.kind).toBe('span');
        // A complete bounded set or explicit ambiguity; never a partial set.
        for (let left = 0; left <= prefixTokens.length; left++) {
          for (let right = 0; right <= suffixTokens.length; right++) {
            const name = [
              ...prefixTokens.slice(left),
              'Cafe',
              ...suffixTokens.slice(0, right),
            ].join(' ');
            if (name === 'Cafe' || parsed.kind === 'ambiguous') continue;
            expect(
              resolveReadings(['Cafe', name], message).outcome,
              `${message} / ${name}`,
            ).toMatchObject({ kind: 'choice' });
            for (const reading of [parsed, ...(parsed.alternates ?? [])])
              expect(message.slice(reading.start, reading.end)).toBe(reading.text);
          }
        }
      }
    }
  });
  it.each([
    ['Cafe Cỏ mở cửa mấy giờ?', 'Cafe Cỏ'],
    ['Cafe Cỏ có wifi không?', 'Cafe Cỏ'],
    ['Cafe Cô mở cửa không?', 'Cafe Cô'],
    ['Trà Khổng có chỗ đậu xe không?', 'Trà Khổng'],
    ['Cafe Mây sao?', undefined],
    ['Bún Giã giá bao nhiêu?', 'Bún Giã'],
    ['Phở Ô ở đâu?', 'Phở Ô'],
    ['Bánh Mỡ mở cửa mấy giờ?', 'Bánh Mỡ'],
    ['Cafe Giò đánh giá thế nào?', 'Cafe Giò'],
  ])('Astra F-01 r3: accented name token in "%s" is never question grammar', (text, expected) => {
    const parsed = extractPlaceNameSpan(text);
    if (expected === undefined) {
      // "Mây" is not "mấy": nothing is stripped, so the short core cannot be selected.
      expect(parsed).toMatchObject({ kind: 'span', text: 'Cafe Mây sao' });
      return;
    }
    expect(parsed).toMatchObject({ kind: 'span', text: expected });
    if (parsed.kind === 'span') expect(text.slice(parsed.start, parsed.end)).toBe(expected);
  });
  it.each([
    // [message, shortened core, the longer whole-name reading that must also be probed]
    ['Cafe Co mo cua may gio?', 'Cafe', 'Cafe Co'],
    ['Cafe co wifi khong?', 'Cafe', 'Cafe co'],
    ['Cafe Có mở cửa không?', 'Cafe', 'Cafe Có'],
    ['Quan Khong co wifi?', 'Quan', 'Quan Khong'],
    ['Quán Không có wifi?', 'Quán', 'Quán Không'],
    ['Cafe May sao?', 'Cafe', 'Cafe May'],
    ['Cafe Mấy sao?', 'Cafe', 'Cafe Mấy'],
    ['Bun Gia bao nhieu?', 'Bun', 'Bun Gia'],
    ['Pho O dau?', 'Pho', 'Pho O'],
    ['Phở Ở đâu?', 'Phở', 'Phở Ở'],
  ])(
    'Astra F-01 r3: "%s" keeps the longer reading; the short core is never a silent exact unique',
    (text, core, longer) => {
      const parsed = extractPlaceNameSpan(text);
      expect(parsed).toMatchObject({ kind: 'span', text: core });
      if (parsed.kind !== 'span') return;
      const readings = (parsed.alternates ?? []).map((a) => a.text);
      expect(readings).toContain(longer);
      for (const a of parsed.alternates ?? []) expect(text.slice(a.start, a.end)).toBe(a.text);
      // Both venues exist: the user chooses, whichever reading was meant.
      expect(resolveReadings([core, longer], text).outcome).toMatchObject({ kind: 'choice' });
      expect(resolveReadings([core, longer], text).outcome!.candidates).toHaveLength(2);
      // Only the longer venue exists: it answers, the core is not invented.
      expect(resolveReadings([longer], text).outcome).toMatchObject({
        kind: 'answer',
        candidates: [{ id: longer }],
      });
      // Only the short venue exists: ordinary direct answer, no needless confirm.
      expect(resolveReadings([core], text).outcome).toMatchObject({
        kind: 'answer',
        candidates: [{ id: core }],
      });
    },
  );
  it('Astra F-01 r3: a doubled particle is consumed once (Quán Có có wifi không?)', () => {
    for (const [text, expected] of [
      ['Quán Có có wifi không?', 'Quán Có'],
      ['Quan Co co wifi khong?', 'Quan Co'],
      ['Quán Không không có wifi?', 'Quán Không'],
      ['Cafe Mở mở cửa mấy giờ?', 'Cafe Mở'],
    ] as const)
      expect(extractPlaceNameSpan(text)).toMatchObject({ kind: 'span', text: expected });
  });
  it('Astra F-01 r3: area markers and stripped topic prefixes keep their whole-name reading', () => {
    // "Ô"/"Ổ" are not the marker "ở": no area is invented from a name token.
    expect(extractPlaceNameSpan('Phở Ổ Quận 9 mở cửa mấy giờ?')).toMatchObject({
      kind: 'span',
      text: 'Phở Ổ Quận 9',
    });
    expect(extractPlaceNameSpan('Phở Ổ Quận 9 mở cửa mấy giờ?')).not.toHaveProperty('statedArea');
    // Unaccented "o" may be the marker or a name token: both readings are returned.
    const unaccented = extractPlaceNameSpan('Pho O Quan 9 mo cua may gio?');
    expect(unaccented).toMatchObject({ kind: 'span', text: 'Pho', statedArea: 'O Quan 9' });
    expect(unaccented).toMatchObject({
      alternates: expect.arrayContaining([
        expect.objectContaining({ text: 'Pho O Quan 9', includesArea: true }),
      ]),
    });
    const typed = extractPlaceNameSpan('Tonkin ở Quận 9 có wifi không?');
    expect(typed).toMatchObject({
      text: 'Tonkin',
      alternates: expect.arrayContaining([
        expect.objectContaining({ text: 'Tonkin ở Quận 9', includesArea: true }),
      ]),
    });
    // A topic prefix with no "của/về" may be the start of the name.
    const prefixed = extractPlaceNameSpan('Thông tin Cafe mở cửa mấy giờ?');
    expect(prefixed).toMatchObject({ kind: 'span', text: 'Cafe' });
    if (prefixed.kind === 'span')
      expect(prefixed.alternates!.map((a) => a.text)).toEqual(
        expect.arrayContaining([
          'Thông tin Cafe',
          'Cafe mở',
          'Cafe mở cửa',
          'Thông tin Cafe mở cửa mấy giờ',
        ]),
      );
    expect(extractPlaceNameSpan('Thông tin về Cafe Gần Tìm Mới')).toMatchObject({
      alternates: expect.arrayContaining([
        expect.objectContaining({ text: 'Thông tin về Cafe Gần Tìm Mới' }),
      ]),
    });
    // Comparison operands keep alternates on original-message offsets.
    const text = 'So sánh Cafe Co mo cua khong và Tonkin về giá?';
    const compared = extractComparisonPlaceNameSpans(text);
    expect(compared.kind).toBe('spans');
    if (compared.kind === 'spans')
      for (const a of compared.spans[0].alternates ?? [])
        expect(text.slice(a.start, a.end)).toBe(a.text);
  });
});

it('round-4: reading budget overflow and unrepresentable full readings clarify without truncation', () => {
  const atLimit = extractPlaceNameSpan('Thông tin về Cafe ở Quận 9 có mở cửa không?');
  expect(atLimit.kind).toBe('span');
  if (atLimit.kind === 'span') expect(atLimit.alternates).toHaveLength(31);
  expect(extractPlaceNameSpan('Giờ mở cửa của Cafe ở Quận 9 có chỗ đậu xe không?')).toEqual({
    kind: 'ambiguous',
  });
  expect(extractPlaceNameSpan(`Giờ mở cửa của ${'a'.repeat(115)} có wifi không?`)).toEqual({
    kind: 'ambiguous',
  });
});
