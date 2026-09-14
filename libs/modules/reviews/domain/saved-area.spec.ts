import { describe, expect, it } from 'vitest';
import { codesToLabel, planArea, placeArea, withLabels, type UnitLabel } from './saved-area';

const PUBLISHED = 'ds-2026';
const verified = (provinceCode: string, communeCode: string) => ({
  provinceCode,
  communeCode,
  status: 'VERIFIED',
  datasetVersion: PUBLISHED,
});
const units = new Map<string, UnitLabel>([
  [
    'PROVINCE:79',
    { code: '79', level: 'PROVINCE', fullName: 'Thành phố Hồ Chí Minh', parentCode: null },
  ],
  [
    'PROVINCE:01',
    { code: '01', level: 'PROVINCE', fullName: 'Thành phố Hà Nội', parentCode: null },
  ],
  [
    'COMMUNE:26734',
    { code: '26734', level: 'COMMUNE', fullName: 'Phường Bến Thành', parentCode: '79' },
  ],
  [
    'COMMUNE:26740',
    { code: '26740', level: 'COMMUNE', fullName: 'Phường Sài Gòn', parentCode: '79' },
  ],
]);

describe('saved area facts (ADM-022)', () => {
  it('trusts only a verified mapping from the published dataset with both codes', () => {
    expect(placeArea(verified('79', '26734'), PUBLISHED)).toEqual({
      provinceCode: '79',
      communeCode: '26734',
    });
    expect(placeArea({ ...verified('79', '26734'), status: 'AUTO_MATCHED' }, PUBLISHED)).toBeNull();
    expect(placeArea({ ...verified('79', '26734'), datasetVersion: 'old' }, PUBLISHED)).toBeNull();
    expect(placeArea({ ...verified('79', '26734'), communeCode: null }, PUBLISHED)).toBeNull();
    expect(placeArea(verified('79', '26734'), null)).toBeNull();
    expect(placeArea(undefined, PUBLISHED)).toBeNull();
  });

  it('places a plan by all of its stops, never by the first one', () => {
    const a = { provinceCode: '79', communeCode: '26734' };
    const b = { provinceCode: '79', communeCode: '26740' };
    const c = { provinceCode: '01', communeCode: '00001' };
    expect(planArea([a, a])).toEqual({
      scope: 'commune',
      provinceCode: '79',
      communeCode: '26734',
    });
    expect(planArea([a, b])).toEqual({ scope: 'province', provinceCode: '79' });
    expect(planArea([a, c])).toEqual({ scope: 'multiple_provinces' });
    expect(planArea([a, null])).toEqual({ scope: 'unknown' });
    expect(planArea([])).toEqual({ scope: 'unknown' });
  });

  it('labels from the published dataset and refuses a commune under another province', () => {
    expect(
      withLabels({ scope: 'commune', provinceCode: '79', communeCode: '26734' }, PUBLISHED, units),
    ).toEqual({
      scope: 'commune',
      datasetVersion: PUBLISHED,
      provinceCode: '79',
      provinceName: 'Thành phố Hồ Chí Minh',
      communeCode: '26734',
      communeName: 'Phường Bến Thành',
    });
    expect(
      withLabels({ scope: 'commune', provinceCode: '01', communeCode: '26734' }, PUBLISHED, units)
        .scope,
    ).toBe('unknown');
    expect(withLabels({ scope: 'province', provinceCode: '79' }, PUBLISHED, units)).toMatchObject({
      scope: 'province',
      provinceName: 'Thành phố Hồ Chí Minh',
      communeCode: null,
    });
    expect(withLabels({ scope: 'multiple_provinces' }, PUBLISHED, units)).toMatchObject({
      scope: 'multiple_provinces',
      datasetVersion: PUBLISHED,
      provinceCode: null,
    });
    expect(withLabels({ scope: 'province', provinceCode: '99' }, PUBLISHED, units).scope).toBe(
      'unknown',
    );
    expect(
      codesToLabel([
        { scope: 'commune', provinceCode: '79', communeCode: '26734' },
        { scope: 'province', provinceCode: '01' },
      ]).sort(),
    ).toEqual(['01', '26734', '79']);
  });
});
