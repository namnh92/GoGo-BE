import { describe, expect, it } from 'vitest';
import { deriveUnitType, stripTypePrefix } from './unit-type';

describe('the prefix refines a level, it never decides one', () => {
  it('reads "Thành phố" as a municipality at province level', () => {
    expect(deriveUnitType('PROVINCE', 'Thành phố Hà Nội')).toEqual({
      ok: true,
      unitType: 'MUNICIPALITY',
    });
  });

  it('reads the same "Thành phố" as a legacy district at district level', () => {
    // The historical snapshot holds 6 province-level cities and 87
    // district-level ones. A prefix-only mapping would file Thành phố Thủ Đức
    // as a municipality, which is the whole reason level comes from structure.
    expect(deriveUnitType('LEGACY_DISTRICT', 'Thành phố Thủ Đức')).toEqual({
      ok: true,
      unitType: 'LEGACY_DISTRICT',
    });
  });
});

describe('commune-level types', () => {
  it.each([
    ['Phường Ba Đình', 'WARD'],
    ['Xã Bắc Sơn', 'COMMUNE'],
    ['Đặc khu Côn Đảo', 'SPECIAL_ZONE'],
    // A township is a commune-level unit and GoGo's COMMUNE is that level. The
    // designation is not lost: `full_name` keeps "Thị trấn X" verbatim.
    ['Thị trấn Cần Thạnh', 'COMMUNE'],
  ])('%s → %s', (fullName, expected) => {
    expect(deriveUnitType('COMMUNE', fullName)).toMatchObject({ ok: true, unitType: expected });
  });

  it('every legacy district word maps to LEGACY_DISTRICT', () => {
    for (const name of ['Quận 1', 'Huyện Củ Chi', 'Thị xã Sơn Tây', 'Thành phố Thủ Đức']) {
      expect(deriveUnitType('LEGACY_DISTRICT', name)).toMatchObject({
        ok: true,
        unitType: 'LEGACY_DISTRICT',
      });
    }
  });
});

describe('source defects are reported, not repaired', () => {
  it('accepts the lowercase prefix on ward 06325 and says so', () => {
    // The one row in v5.0.0 written "xã Bắc Sơn". Matching case-insensitively
    // is right; doing it silently would hide a defect worth a warning.
    const result = deriveUnitType('COMMUNE', 'xã Bắc Sơn');
    expect(result).toMatchObject({ ok: true, unitType: 'COMMUNE' });
    expect(result.ok && result.warning).toMatch(/lowercase/);
  });

  it('does not warn on a correctly capitalised name', () => {
    const result = deriveUnitType('COMMUNE', 'Xã Bắc Sơn');
    expect(result.ok && result.warning).toBeUndefined();
  });

  it('refuses a name with no known type rather than guessing one', () => {
    expect(deriveUnitType('COMMUNE', 'Khu phố Bến Thành')).toMatchObject({ ok: false });
  });
});

describe('stripTypePrefix', () => {
  it('leaves the searchable short name behind', () => {
    expect(stripTypePrefix('COMMUNE', 'Phường Ba Đình')).toBe('Ba Đình');
    expect(stripTypePrefix('PROVINCE', 'Tỉnh Lạng Sơn')).toBe('Lạng Sơn');
  });

  it('returns the name unchanged when no prefix matches', () => {
    expect(stripTypePrefix('COMMUNE', 'Ba Đình')).toBe('Ba Đình');
  });
});
