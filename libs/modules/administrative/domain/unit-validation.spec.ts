import { describe, expect, it } from 'vitest';
import { validateCurrentPair } from './unit-validation';

/**
 * ADM-015 — the pair check, on its own.
 *
 * Every case here was previously reachable only through a moderator's HTTP
 * request. Three more callers are about to depend on it, so the rules get their
 * own tests rather than being asserted once, indirectly, through a queue.
 */

const VERSION = 'v5.0.0+test';
const commune = { code: '00004', parentCode: '01' };
const province = { code: '01', parentCode: null };

describe('validateCurrentPair', () => {
  it('accepts a current commune under the province it really belongs to', () => {
    expect(
      validateCurrentPair(
        { provinceCode: '01', communeCode: '00004' },
        { province, commune },
        VERSION,
      ),
    ).toBeNull();
  });

  it('accepts an absent pair — not choosing a unit is not an error', () => {
    expect(
      validateCurrentPair(
        { provinceCode: null, communeCode: undefined },
        { province: null, commune: null },
        VERSION,
      ),
    ).toBeNull();
  });

  it('refuses a commune with no province, and points at the empty box', () => {
    const issue = validateCurrentPair(
      { provinceCode: null, communeCode: '00004' },
      { province: null, commune },
      VERSION,
    );
    expect(issue?.code).toBe('ADMINISTRATIVE_CODES_INCOMPLETE');
    expect(issue?.field).toBe('provinceCode');
  });

  it('refuses a province with no commune — a province alone is not an address', () => {
    const issue = validateCurrentPair(
      { provinceCode: '01', communeCode: null },
      { province, commune: null },
      VERSION,
    );
    expect(issue?.code).toBe('ADMINISTRATIVE_CODES_INCOMPLETE');
    expect(issue?.field).toBe('communeCode');
  });

  it('refuses a province the active dataset does not carry as current', () => {
    const issue = validateCurrentPair(
      { provinceCode: '99', communeCode: '00004' },
      { province: null, commune },
      VERSION,
    );
    expect(issue?.code).toBe('PROVINCE_NOT_CURRENT');
    // The version is in the message because a code is only valid *of a release*.
    expect(issue?.message).toContain(VERSION);
  });

  it('refuses a commune that is not current in the active dataset', () => {
    const issue = validateCurrentPair(
      { provinceCode: '01', communeCode: '00004' },
      { province, commune: null },
      VERSION,
    );
    expect(issue?.code).toBe('COMMUNE_NOT_CURRENT');
    expect(issue?.field).toBe('communeCode');
  });

  it('refuses a cross-province pair even though both codes are current', () => {
    const issue = validateCurrentPair(
      { provinceCode: '79', communeCode: '00004' },
      { province: { code: '79', parentCode: null }, commune },
      VERSION,
    );
    expect(issue?.code).toBe('HIERARCHY_INVALID');
    expect(issue?.message).toContain('01');
    expect(issue?.message).toContain('79');
  });

  it('refuses a legacy district code the historical dataset has never held', () => {
    const issue = validateCurrentPair(
      { provinceCode: '01', communeCode: '00004', legacyDistrictCode: '001' },
      { province, commune, legacyDistrict: null },
      VERSION,
    );
    expect(issue?.code).toBe('LEGACY_DISTRICT_UNKNOWN');
    expect(issue?.field).toBe('legacyDistrictCode');
  });

  it('accepts a legacy district that exists, alongside a current pair', () => {
    expect(
      validateCurrentPair(
        { provinceCode: '01', communeCode: '00004', legacyDistrictCode: '001' },
        { province, commune, legacyDistrict: { code: '001', parentCode: '01' } },
        VERSION,
      ),
    ).toBeNull();
  });

  it('still checks a legacy district when no current pair was sent at all', () => {
    // A legacy code is a claim of its own; it does not get a free pass because
    // the two current levels are empty.
    const issue = validateCurrentPair(
      { provinceCode: null, communeCode: null, legacyDistrictCode: '001' },
      { province: null, commune: null, legacyDistrict: null },
      VERSION,
    );
    expect(issue?.code).toBe('LEGACY_DISTRICT_UNKNOWN');
  });
});
