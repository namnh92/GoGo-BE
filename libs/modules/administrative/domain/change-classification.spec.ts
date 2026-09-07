import { describe, expect, it } from 'vitest';
import {
  classifyMapping,
  isCanonical,
  summarise,
  type MappingRow,
  type UnitIndex,
} from './change-classification';

/**
 * ADM-002 (#455) — the classifier, on constructed rows.
 *
 * The counterpart test (`administrative-import.int.spec.ts`) runs the real
 * pinned file and asserts the totals. This one asserts the *reasons*, which a
 * total cannot: that a divided commune is never given a single target, that a
 * target GoGo does not hold is never minted, and that a hierarchy the source
 * asserts is checked rather than believed.
 */

const index: UnitIndex = {
  currentCommuneProvince: new Map([
    ['00004', '01'],
    ['00008', '01'],
    ['00025', '01'],
    ['26732', '79'],
  ]),
  currentProvinces: new Set(['01', '79']),
  historicalCommunes: new Set(['00007', '00019', '00001', '00013']),
  historicalDistricts: new Set(['001', '755']),
};

const row = (over: Partial<MappingRow> = {}): MappingRow => ({
  provinceCode: '01',
  districtCode: '001',
  wardCode: '00001',
  province: 'Thành phố Hà Nội',
  district: 'Quận Ba Đình',
  ward: 'Phường Phúc Xá',
  newProvinceCode: '01',
  newWardCode: '00004',
  newProvince: 'Thành phố Hà Nội',
  newWard: 'Phường Ba Đình',
  isMergedWard: false,
  isDividedWard: false,
  ...over,
});

describe('a divided commune is never given one target', () => {
  it('quarantines every branch and lists the candidates instead', () => {
    // The source names a "default" successor per branch. That default is the
    // guess ADR-0019 forbids: which successor an address landed in is a
    // question about coordinates or a person, not about CSV row order.
    const rows = ['00004', '00008', '00025'].map((newWardCode) =>
      row({ wardCode: '00007', newWardCode, isDividedWard: true, isMergedWard: true }),
    );
    const out = classifyMapping(rows, index);

    expect(out.map((c) => c.classification)).toEqual([
      'DIVIDED_REQUIRES_REVIEW',
      'DIVIDED_REQUIRES_REVIEW',
      'DIVIDED_REQUIRES_REVIEW',
    ]);
    expect(out.every((c) => c.edge === undefined)).toBe(true);
    expect(out.every((c) => !isCanonical(c.classification))).toBe(true);
    // Candidates are offered; none is chosen, and the order is stable so a
    // reviewer sees the same list twice.
    expect(out[0]!.candidates).toEqual(['00004', '00008', '00025']);
  });

  it('catches a split the source failed to flag', () => {
    // Two targets and `isDividedWard=false` is the source contradicting itself.
    // Believing the flag would silently record one arbitrary successor.
    const rows = ['00004', '00008'].map((newWardCode) =>
      row({ wardCode: '00019', newWardCode, isDividedWard: false }),
    );
    const out = classifyMapping(rows, index);
    expect(out.map((c) => c.classification)).toEqual(['MULTIPLE_TARGETS', 'MULTIPLE_TARGETS']);
    expect(out.every((c) => c.edge === undefined)).toBe(true);
  });
});

describe('an endpoint GoGo does not hold is never minted', () => {
  it('quarantines a target absent from the current snapshot', () => {
    const out = classifyMapping([row({ newWardCode: '99999' })], index);
    expect(out[0]!.classification).toBe('TARGET_NOT_FOUND');
    expect(out[0]!.edge).toBeUndefined();
    expect(out[0]!.reason).toMatch(/never minted/);
  });

  it('quarantines a source absent from the historical snapshot', () => {
    const out = classifyMapping([row({ wardCode: '88888' })], index);
    expect(out[0]!.classification).toBe('SOURCE_NOT_FOUND');
    expect(out[0]!.edge).toBeUndefined();
  });
});

describe('the hierarchy the source asserts is checked, not believed', () => {
  it('quarantines a target whose real province differs from the stated one', () => {
    // 00004 is in province 01; the row claims 79. One of the two is wrong and
    // the classifier is not the thing that gets to decide which.
    const out = classifyMapping([row({ newProvinceCode: '79' })], index);
    expect(out[0]!.classification).toBe('HIERARCHY_CONFLICT');
    expect(out[0]!.reason).toMatch(/sits in province 01/);
  });

  it('quarantines a province that does not exist at all', () => {
    const out = classifyMapping([row({ newWardCode: '00004', newProvinceCode: '55' })], index);
    expect(out[0]!.classification).toBe('HIERARCHY_CONFLICT');
  });
});

describe('valid shapes', () => {
  it('records a one-to-one migration as RENAMED', () => {
    const out = classifyMapping([row()], index);
    expect(out[0]!.classification).toBe('VALID_UNIQUE');
    expect(out[0]!.edge).toEqual({ oldCode: '00001', newCode: '00004', changeType: 'RENAMED' });
  });

  it('records several predecessors of one successor as MERGED', () => {
    const rows = [row({ wardCode: '00001' }), row({ wardCode: '00013' })];
    const out = classifyMapping(rows, index);
    expect(out.map((c) => c.classification)).toEqual(['VALID_MERGE', 'VALID_MERGE']);
    expect(out.every((c) => c.edge?.changeType === 'MERGED')).toBe(true);
  });

  it('accepts a district-level predecessor as its own kind, not as garbage', () => {
    // Five island districts became đặc khu whole. The row has no ward code,
    // which is correct data in an unexpected shape — and Côn Đảo changes
    // province on the way (77 → 79), so the province is read from the target.
    const out = classifyMapping(
      [
        row({
          wardCode: null,
          districtCode: '755',
          district: 'Huyện Côn Đảo',
          ward: '',
          provinceCode: '77',
          newProvinceCode: '79',
          newWardCode: '26732',
          newWard: 'Đặc khu Côn Đảo',
        }),
      ],
      index,
    );
    expect(out[0]!.classification).toBe('VALID_DISTRICT_TO_SPECIAL_ZONE');
    expect(out[0]!.edge).toEqual({
      oldCode: '755',
      newCode: '26732',
      changeType: 'REASSIGNED',
    });
    expect(isCanonical(out[0]!.classification)).toBe(true);
  });

  it('quarantines a repeated edge rather than writing it twice', () => {
    const out = classifyMapping([row(), row()], index);
    expect(out.map((c) => c.classification)).toEqual(['VALID_UNIQUE', 'DUPLICATE']);
  });
});

describe('an unresolvable sibling taints its whole group', () => {
  it('refuses to record the resolvable branch as a clean one-to-one', () => {
    // One legacy commune, two stated successors: one GoGo holds, one it does
    // not. The missing one is quarantined on its own merits — but the *group*
    // is then not understood either, because "split into one we know and one we
    // do not" is not a migration anyone can record. Recording the known branch
    // as `VALID_UNIQUE` would assert the commune went there and only there.
    const rows = [
      row({ wardCode: '00001', newWardCode: '00004' }),
      row({ wardCode: '00001', newWardCode: '99999' }),
    ];
    const out = classifyMapping(rows, index);
    expect(out.map((c) => c.classification)).toEqual(['MULTIPLE_TARGETS', 'TARGET_NOT_FOUND']);
    expect(out.every((c) => c.edge === undefined)).toBe(true);
  });
});

describe('summarise', () => {
  it('counts by class and omits classes with no rows', () => {
    const out = summarise(
      classifyMapping([row(), row({ wardCode: '00013', newWardCode: '99999' })], index),
    );
    expect(out).toEqual({ VALID_UNIQUE: 1, TARGET_NOT_FOUND: 1 });
  });
});
