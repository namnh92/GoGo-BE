import { describe, expect, it } from 'vitest';
import { AssistantAreaResolver } from './area-resolver.service';
import { v5Query } from './area.fixture';

/**
 * Owner 2026-10-28 (Sol N-02): places are searched by the new administrative
 * address only. A pre-2025 district name is not mapped to its old province;
 * it is not recognised, so the assistant asks for a new address.
 */
const HCM = { code: '79', name: 'Thành phố Hồ Chí Minh', fullName: 'Thành phố Hồ Chí Minh' };
const BEN_THANH = {
  code: '26740',
  name: 'Bến Thành',
  fullName: 'Phường Bến Thành',
  level: 'WARD',
  parentCode: '79',
  isCurrent: true,
};
const OLD_DISTRICT = {
  code: '760',
  name: 'Quận 10',
  fullName: 'Quận 10',
  level: 'DISTRICT',
  parentCode: '79',
  isCurrent: false,
};

const resolver = new AssistantAreaResolver({
  snapshot: async () => ({ datasetVersion: 'v2025', currentProvinces: [HCM] }),
  search: (_s: unknown, o: { includeLegacy: boolean }) => ({
    items: o.includeLegacy ? [BEN_THANH, OLD_DISTRICT] : [BEN_THANH],
  }),
} as never);

describe('area resolution uses the new administrative address only', () => {
  it('a current ward resolves', async () => {
    const r = await resolver.resolve('cà phê ở Bến Thành', 'Bến Thành');
    expect(r.kind).toBe('resolved');
  });

  it('an old district is not mapped to its province', async () => {
    expect(await resolver.resolve('cà phê ở Quận 10', 'Quận 10')).toEqual({ kind: 'none' });
  });

  it('an old district with the city named is still not recognised', async () => {
    expect(await resolver.resolve('cà phê ở Quận 10 TP HCM', 'Quận 10')).toEqual({
      kind: 'none',
    });
  });

  it('a single-digit old district with the city named is not recognised', async () => {
    expect(await resolver.resolve('cà phê ở Quận 1 TP HCM', 'Quận 1')).toEqual({ kind: 'none' });
  });

  it('the city alone resolves to the city', async () => {
    const r = await resolver.resolve('cà phê ở TP HCM', null);
    expect(r.kind).toBe('resolved');
  });
});

/**
 * GoGo-BE#733 D-6 — a phrase that is both a province alias and a commune
 * inside that province ("Sài Gòn") is asked back with both choices; a
 * qualifier or the full dataset name settles it. The fixture mirrors the
 * published v5.1.0 names (province `name` "Hồ Chí Minh", `fullName` "Thành
 * phố Hồ Chí Minh"; Phường Sài Gòn 26740).
 */
const v5 = new AssistantAreaResolver(v5Query() as never);
const resolve = (text: string, areaText: string | null) => v5.resolve(text, areaText);
const communeOf = async (text: string, areaText: string | null) => {
  const r = await resolve(text, areaText);
  return r.kind === 'resolved' ? r.value.area.communeCode : `(${r.kind})`;
};
const kindOf = async (text: string, areaText: string | null) =>
  (await resolve(text, areaText)).kind;

describe('#733 province alias that is also a commune name', () => {
  it('U-5 "Sài Gòn" (any case) is a scope choice between the city and the ward', async () => {
    for (const [text, areaText] of [
      ['ăn tối ở Sài Gòn', 'Sài Gòn'],
      ['ăn tối ở sài gòn', null],
    ] as const) {
      const r = await resolve(text, areaText);
      expect(r, text).toMatchObject({
        kind: 'scope_choice',
        province: { code: '79', fullName: 'Thành phố Hồ Chí Minh' },
        communes: [{ code: '26740', fullName: 'Phường Sài Gòn' }],
      });
    }
  });

  it('U-6 a qualifier or the full dataset name settles the scope', async () => {
    expect(await communeOf('Cả Thành phố Hồ Chí Minh', null)).toBeNull();
    expect(await communeOf('Phường Sài Gòn, Thành phố Hồ Chí Minh', 'Phường Sài Gòn')).toBe(
      '26740',
    );
    expect(await communeOf('ở phường sài gòn', null)).toBe('26740');
    for (const [text, areaText] of [
      ['cà phê ở TP HCM', null],
      ['cà phê tphcm', null],
      ['cà phê ở cả Sài Gòn', 'Sài Gòn'],
      ['Ở TP.HCM', 'TP'],
      ['đi chơi thành phố Sài Gòn', null],
    ] as const) {
      expect(await communeOf(text, areaText), text).toBeNull();
      expect(await kindOf(text, areaText), text).toBe('resolved');
    }
  });

  it('U-6c a ward name in two provinces: the city named settles it, alone it is asked', async () => {
    expect(await communeOf('ở phường Phú Thọ, TP HCM', null)).toBe('27226');
    expect(await communeOf('Phường Phú Thọ, Thành phố Hồ Chí Minh', null)).toBe('27226');
    expect(await kindOf('ở phường Phú Thọ', null)).toBe('ambiguous');
  });

  it('a typed qualifier in the newest message answers the scope question', async () => {
    const r = await v5.resolve('ăn tối ở Sài Gòn\ncả Sài Gòn', 'Sài Gòn', {
      text: 'cả Sài Gòn',
      areaText: null,
    });
    expect(r).toMatchObject({ kind: 'resolved', value: { area: { communeCode: null } } });
  });

  it('Sol F-05 a ward with another province named next to it is not guessed', async () => {
    expect(await kindOf('Phường Ba Đình, TP HCM', null)).toBe('ambiguous');
    expect(await kindOf('Phường Ba Đình, Thành phố Hồ Chí Minh', null)).toBe('ambiguous');
    expect(await communeOf('Phường Ba Đình, Thành phố Hà Nội', null)).toBe('00004');
  });

  it('Sol F-03 a newest non-exact area wins over an older full name', async () => {
    const r = await v5.resolve('cà phê ở Phường Bến Thành\nỞ Hà Nội', 'Hà Nội', {
      text: 'Ở Hà Nội',
      areaText: 'Hà Nội',
    });
    expect(r).toMatchObject({ kind: 'resolved', value: { area: { provinceCode: '01' } } });
  });

  it('Astra A-F-02 an old district stays unrecognised with its city named in full', async () => {
    expect(await kindOf('cà phê ở Quận 1, Thành phố Hồ Chí Minh', 'Quận 1')).toBe('none');
    expect(await kindOf('cà phê ở Huyện Củ Chi, TP HCM', 'Huyện Củ Chi')).toBe('none');
  });

  it.each([
    'Quận Bình Thạnh, Thành phố Hồ Chí Minh',
    'Thành phố Thủ Đức, Thành phố Hồ Chí Minh',
    'Thành phố Đà Lạt, Tỉnh Lâm Đồng',
    'TP. Thủ Đức, TP.HCM',
    'Huyện Củ Chi, TP HCM',
    'Thị xã Bến Cát, Thành phố Hồ Chí Minh',
  ])('A-F-02/F-10 rejects legacy qualifiers without areaText: %s', async (text) => {
    expect(await kindOf(text, null)).toBe('none');
    expect(await v5.namesArea(text, false)).toBe(true);
  });

  it.each(['Thành phố Hồ Chí Minh', 'Thành phố Hà Nội', 'Tỉnh Lâm Đồng'])(
    'F-10 exempts a current province: %s',
    async (text) => {
      expect(await kindOf(text, null)).toBe('resolved');
      expect(await communeOf(text, null)).toBeNull();
    },
  );

  it.each(['Q. Bình Thạnh', 'Q Bình Thạnh', 'Q.Bình Thạnh', 'Q.1', 'Q1', 'Q 1'])(
    'F-15 rejects an abbreviated district even beside a current province: %s',
    async (district) => {
      const text = `${district}, TP.HCM`;
      expect(await kindOf(text, null)).toBe('none');
      expect(await kindOf(text, district)).toBe('none');
      expect(await v5.namesArea(district, false)).toBe(true);
    },
  );

  it('F-10 does not confuse quán with the legacy qualifier quận', async () => {
    expect(await kindOf('tìm quán cà phê ở Thành phố Hà Nội', 'Thành phố Hà Nội')).toBe('resolved');
    expect(await kindOf('tìm quán cà phê ở Hà Nội', 'Hà Nội')).toBe('resolved');
  });

  it('A-F-07 a bare preference cannot replace an established area', async () => {
    const messages = [
      { text: 'Tỉnh Thái Nguyên', areaText: null, allowBareArea: true },
      { text: 'bình yên', areaText: null, allowBareArea: false },
    ];
    const result = await v5.resolve('Tỉnh Thái Nguyên\nbình yên', null, messages[1], messages);
    expect(result).toMatchObject({
      kind: 'resolved',
      value: { area: { provinceCode: '19', communeCode: null } },
    });
    expect(await v5.namesArea('bình yên', false)).toBe(false);
    expect(await v5.namesArea('bình yên', true)).toBe(true);
    expect(await v5.namesArea('ở Bình Yên', false)).toBe(true);
    expect(await v5.namesArea('Xã Bình Yên', false)).toBe(true);
  });

  it.each([
    ["B'Lao", '99991'],
    ["D'Ran", '99992'],
    ['B’Lao', '99991'],
  ])('F-11 folds dataset and typed punctuation together: %s', async (text, code) => {
    expect(await v5.namesArea(text, true)).toBe(true);
    expect(await communeOf(text, null)).toBe(code);
    expect(await communeOf(`ở ${text}`, text.split(/['’]/)[0]!)).toBe(code);
  });

  it('Astra A-F-05 a bare name typed as the whole answer names the area', async () => {
    expect(await v5.namesArea('Hà Nội')).toBe(true);
    expect(await v5.namesArea('Bến Thành')).toBe(true);
    expect(await v5.namesArea('4 người')).toBe(false);
    expect(await communeOf('Bến Thành', null)).toBe('26734');
  });

  it('U-6b a province named elsewhere is context, not a scope question', async () => {
    expect(await communeOf('Ở Bến Thành, Sài Gòn', 'Bến Thành')).toBe('26734');
  });

  it('U-7 an old district stays unrecognised; a city with no same-name ward resolves', async () => {
    expect(await kindOf('ở Quận 1', 'Quận 1')).toBe('none');
    expect(await communeOf('cà phê ở Hà Nội', 'Hà Nội')).toBeNull();
    expect(await kindOf('cà phê ở Hà Nội', 'Hà Nội')).toBe('resolved');
  });

  it('the newest message decides when an episode names two areas', async () => {
    const r = await v5.resolve('tạo kèo ăn tối ở Sài Gòn\nCả Thành phố Hồ Chí Minh', 'Sài Gòn', {
      text: 'Cả Thành phố Hồ Chí Minh',
      areaText: null,
    });
    expect(r).toMatchObject({ kind: 'resolved', value: { area: { communeCode: null } } });
  });

  it('an exact unit name is found before any model call (episode gate)', async () => {
    expect(await v5.namesArea('Phường Sài Gòn, Thành phố Hồ Chí Minh')).toBe(true);
    expect(await v5.namesArea('Cả Thành phố Hồ Chí Minh')).toBe(true);
    expect(await v5.namesArea('Làm sao để mời bạn?')).toBe(false);
  });

  describe('#739 F-17 a legacy district is a snapshot name, not a level word', () => {
    it('a brand starting with "Q" beside a city resolves the city', async () => {
      for (const text of ['Q Coffee ở TP.HCM', 'Q. Coffee ở TP.HCM', 'cà phê Q Bar, TP HCM']) {
        expect(await kindOf(text, null), text).toBe('resolved');
        expect(await communeOf(text, null), text).toBeNull();
      }
    });

    it.each([
      'Q. Bình Thạnh, TP.HCM',
      'Quận 1, Thành phố Hồ Chí Minh',
      'Thành phố Thủ Đức, Thành phố Hồ Chí Minh',
      'quan binh thanh, tp hcm',
      'Thành phố Thái Nguyên, Tỉnh Thái Nguyên',
      'Huyện Quảng Ninh',
    ])('a legacy district from the snapshot stays unrecognised: %s', async (text) => {
      expect(await kindOf(text, null)).toBe('none');
    });

    it('a current province-level city is not its same-name old district', async () => {
      expect(await kindOf('Thành phố Quảng Ninh', null)).toBe('resolved');
      expect(await kindOf('cà phê ở TP Quảng Ninh', null)).toBe('resolved');
    });

    it('"quán" and other words are not level words', async () => {
      expect(await kindOf('quán Bình Thạnh ở TP HCM', null)).toBe('resolved');
    });
  });
});
