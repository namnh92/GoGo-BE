import { describe, expect, it } from 'vitest';
import { PlaceAnswerReader } from './place-answer-reader';
import { FIXTURE_A, FIXTURE_B, fictionalPlace, verified } from '../domain/place-qa/fixtures';
import { renderPlaceAnswer } from '../domain/place-qa/templates';

const name = 'The Workshop Coffee';
const areaLabel = 'Phường Sài Gòn, Hồ Chí Minh';
const places = new Map(
  [FIXTURE_A, FIXTURE_B].map((id, i) => [
    id,
    {
      ...fictionalPlace(id, name),
      areaLabel,
      card: {
        kind: 'place' as const,
        placeId: id,
        available: true,
        facts: {
          name,
          addressText: `${i ? 27 : 12} Đường Mây, ${areaLabel}`,
          providerRating: 4.5,
          providerRatingCount: 2100,
          providerRatingSource: 'google' as const,
          gogoRating: 4.2,
          gogoRatingCount: 5,
        },
      },
      facts: { address: verified(`${i ? 27 : 12} Đường Mây`, 'verified_reference') },
    },
  ]),
);
async function choice(ids = [FIXTURE_A, FIXTURE_B], snapshot = places) {
  const row = {
    id: 'choice',
    locale: 'vi' as const,
    text: ids.map((id) => `\uE000place:${id}\uE001`).join(', '),
    trace: {
      route: 'place_qa',
      placeAnswerGroup: {
        v: 1,
        kind: 'clarification',
        prompt: 'place_choice',
        cards: ids,
        sources: [],
        options: ids.map((placeId, i) => ({ id: `pick_${i + 1}`, placeId })),
      },
    },
  };
  return (
    await new PlaceAnswerReader({ placeFacts: async () => ({ places: snapshot }) }).page(
      [row],
      'history',
    )
  ).get(row.id)!;
}
describe('GoGo-BE#877 presentation regressions', () => {
  it('877-CARD: uses the PlaceDetail card even when prose has only reference evidence', async () => {
    const result = await choice();
    expect(result.cards[0]?.facts).toMatchObject({
      addressText: `12 Đường Mây, ${areaLabel}`,
      providerRating: 4.5,
      providerRatingCount: 2100,
      providerRatingSource: 'google',
      gogoRating: 4.2,
      gogoRatingCount: 5,
    });
  });
  it('877-CHOICE: same name/area adds street to prompt, bounded numbered label and name text', async () => {
    const result = await choice();
    const options = result.followUps[0]!.options;
    expect(result.text).toContain('12 Đường Mây');
    expect(result.text).toContain('27 Đường Mây');
    expect(options[0]).toEqual({
      id: 'pick_1',
      label: `1. ${name} · 12 Đường Mây`,
      text: `${name} · 12 Đường Mây`,
    });
    expect(options[1]!.text).toBe(`${name} · 27 Đường Mây`);
  });
  it('877-TEXT: unique candidate text is the place name', async () => {
    const result = await choice([FIXTURE_A]);
    expect(result.followUps[0]!.options[0]!.text).toBe(name);
    expect(result.followUps[0]!.options[0]!.label).toBe(`1. ${name}`);
  });
  function branches(branchNames: string[], addresses: string[]) {
    return new Map(
      [FIXTURE_A, FIXTURE_B].map((id, i) => {
        const p = places.get(id)!;
        return [
          id,
          {
            ...p,
            name: branchNames[i]!,
            card: {
              ...p.card,
              facts: { ...p.card.facts, name: branchNames[i]!, addressText: addresses[i]! },
            },
          },
        ];
      }),
    );
  }
  it('877-LABEL: distinct short names keep the original numbered name label', async () => {
    const result = await choice(
      undefined,
      branches(['Cà Phê Mây', 'Cà Phê Gió'], ['12 Đường Mây', '27 Đường Mây']),
    );
    expect(result.followUps[0]!.options).toEqual([
      { id: 'pick_1', label: '1. Cà Phê Mây', text: 'Cà Phê Mây' },
      { id: 'pick_2', label: '2. Cà Phê Gió', text: 'Cà Phê Gió' },
    ]);
  });
  it('877-LABEL: shortens a long Vietnamese name first, retaining the complete short address and full text/prompt', async () => {
    const longName = 'Cà Phê Không Gian Nghệ Thuật Và Những Người Bạn Sài Gòn';
    const addresses = ['12 Ngô Đức Kế', '27 Ngô Đức Kế'];
    const result = await choice(undefined, branches([longName, longName], addresses));
    const options = result.followUps[0]!.options;
    expect(new Set(options.map((o) => o.label)).size).toBe(2);
    options.forEach((option, i) => {
      expect(Array.from(option.label).length).toBeLessThanOrEqual(40);
      expect(option.label).toMatch(new RegExp(`^${i + 1}\\. Cà Phê.*… · ${addresses[i]}$`));
      expect(option.text).toBe(`${longName} · ${addresses[i]}`);
      expect(result.text).toContain(`${longName} ở ${areaLabel} · ${addresses[i]}`);
    });
  });
  it('877-LABEL: shortens the address only after the name, keeping the number and a discriminator', async () => {
    const longName = 'Cà Phê Không Gian Nghệ Thuật Và Những Người Bạn Sài Gòn';
    const addresses = [12, 27].map(
      (n) => `${n} Đường Những Người Bạn Cùng Nhau Ngắm Bình Minh Rực Rỡ`,
    );
    const result = await choice(undefined, branches([longName, longName], addresses));
    const options = result.followUps[0]!.options;
    expect(new Set(options.map((o) => o.label)).size).toBe(2);
    options.forEach((option, i) => {
      expect(Array.from(option.label).length).toBe(40);
      expect(option.label).toMatch(new RegExp(`^${i + 1}\\. … · ${i ? 27 : 12} Đường .+…$`));
      expect(option.text).toBe(`${longName} · ${addresses[i]}`);
    });
  });
  it('877-LABEL: uses the shortest distinguishing address part when the street is shared', async () => {
    const result = await choice(
      undefined,
      branches(
        [name, name],
        [`12 Đường Mây, Phường Một, ${areaLabel}`, `12 Đường Mây, Phường Hai, ${areaLabel}`],
      ),
    );
    expect(result.followUps[0]!.options.map((o) => o.label)).toEqual([
      `1. ${name} · Phường Một`,
      `2. ${name} · Phường Hai`,
    ]);
  });
  it('877-LABEL: repeated names in different areas still carry an address discriminator', async () => {
    const snapshot = branches([name, name], ['12 Ngô Đức Kế', '27 Ngô Đức Kế']);
    snapshot.get(FIXTURE_B)!.areaLabel = 'Phường Ba Đình, Hà Nội';
    const result = await choice(undefined, snapshot);
    expect(result.followUps[0]!.options.map((o) => o.label)).toEqual([
      `1. ${name} · 12 Ngô Đức Kế`,
      `2. ${name} · 27 Ngô Đức Kế`,
    ]);
    expect(result.followUps[0]!.options[1]!.text).toBe(`${name} · 27 Ngô Đức Kế`);
  });
  it('877-LABEL: ordinal keeps labels distinct even when shortened name and address portions coincide', async () => {
    const addresses = ['A', 'B'].map((tail) => `27 ${'Đường Mây '.repeat(6)}${tail}`);
    const result = await choice(undefined, branches([name, name], addresses));
    const labels = result.followUps[0]!.options.map((o) => o.label);
    expect(labels[0]!.slice(3)).toBe(labels[1]!.slice(3));
    expect(new Set(labels).size).toBe(2);
    expect(labels.every((label) => Array.from(label).length <= 40)).toBe(true);
  });
  it('877-LABEL: counts OpenAPI Unicode code points and never splits surrogate pairs', async () => {
    const emojiName = '🏡'.repeat(37);
    const result = await choice(undefined, branches([emojiName, `${emojiName}A`], ['', '']));
    const [a, b] = result.followUps[0]!.options;
    expect(a!.label).toBe(`1. ${emojiName}`);
    expect(Array.from(a!.label)).toHaveLength(40);
    expect(a!.label.length).toBe(77);
    expect(b!.label).toBe(`2. ${'🏡'.repeat(36)}…`);
    expect(b!.text).toBe(`${emojiName}A`);
  });
  it.each(['vi', 'en'] as const)(
    '877-FORMAT: grouped integer money, sentence and date (%s)',
    (locale) => {
      const price = verified(
        [{ min: 90000, max: 180000, currency: 'VND', unit: 'per_person' as const }],
        'verified_reference',
      );
      const p = {
        ...fictionalPlace(),
        facts: { price: [{ ...price, verifiedAt: '2026-10-20T00:00:00Z' }] },
      };
      const result = renderPlaceAnswer(
        { placeId: FIXTURE_A, locale, topic: 'price' },
        { places: new Map([[FIXTURE_A, p]]) },
      );
      expect(result.text).toContain(
        locale === 'vi'
          ? '90.000–180.000 VND/người. Thông tin tham khảo, xác minh ngày 2026-10-20'
          : '90,000–180,000 VND per person. Reference information verified on 2026-10-20',
      );
      expect(result.tier).toBe('verified_reference');
    },
  );
});
