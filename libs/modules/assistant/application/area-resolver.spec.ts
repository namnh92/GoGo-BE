import { describe, expect, it } from 'vitest';
import { AssistantAreaResolver } from './area-resolver.service';
import { v5Query } from './area.fixture';

/**
 * Owner 2026-10-28 (Sol N-02): places are searched by the new administrative
 * address only. A pre-2025 district name is not mapped to its old province;
 * it is not recognised, so the assistant asks for a new address.
 */
const HCM = { code: '79', name: 'Thành phố Hồ Chí Minh' };
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
    expect(await v5.hasExactUnitName('Phường Sài Gòn, Thành phố Hồ Chí Minh')).toBe(true);
    expect(await v5.hasExactUnitName('Cả Thành phố Hồ Chí Minh')).toBe(true);
    expect(await v5.hasExactUnitName('Làm sao để mời bạn?')).toBe(false);
  });
});
