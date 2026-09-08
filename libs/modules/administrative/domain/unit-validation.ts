import type { UnitLevel } from './unit-type';

/**
 * ADM-015 — is this pair of codes a real, current administrative address?
 *
 * The question was already answered once, inside `AdministrativeModerationService.verify`,
 * and it is about to be asked by three more callers: the place create form, the
 * place edit form, and the import that carries codes in a spreadsheet. Four
 * copies of "is this commune current, and does it really sit under this
 * province" is four chances for one of them to drift into accepting a pair the
 * others refuse — and the pair that slips through is indistinguishable from a
 * correct one downstream.
 *
 * So it lives here, as a pure function over units the caller has already looked
 * up. The lookup is the caller's because only the caller knows which executor to
 * use: a moderator's decision and a place edit both re-read inside their own
 * write transaction, and a function that reached for a connection of its own
 * would validate against a dataset the transaction cannot see.
 *
 * **A code is not an identity.** Every check here is against one named dataset
 * version, which is why the version travels in the message: 2,212 of the 3,321
 * current commune codes meant a different unit before 2025-07-01, and "05737 is
 * valid" is only true of a release.
 */

/** Enough of a unit row to judge a pair. Null means "not in this dataset, currently". */
export type CurrentUnitRef = { code: string; parentCode: string | null } | null;

export type UnitPairIssueCode =
  /** One half of the pair without the other. A province alone is not an address. */
  | 'ADMINISTRATIVE_CODES_INCOMPLETE'
  | 'PROVINCE_NOT_CURRENT'
  | 'COMMUNE_NOT_CURRENT'
  | 'HIERARCHY_INVALID'
  | 'LEGACY_DISTRICT_UNKNOWN';

export type UnitPairIssue = {
  code: UnitPairIssueCode;
  message: string;
  /** The input this is about, so a form can point at the box rather than toast. */
  field: 'provinceCode' | 'communeCode' | 'legacyDistrictCode';
};

export type UnitPairInput = {
  provinceCode: string | null | undefined;
  communeCode: string | null | undefined;
  legacyDistrictCode?: string | null | undefined;
};

export type UnitPairLookups = {
  province: CurrentUnitRef;
  commune: CurrentUnitRef;
  /** Looked up across every period — a legacy district is history by definition. */
  legacyDistrict?: CurrentUnitRef;
};

/**
 * The pair, judged. `null` means it is a usable current address.
 *
 * A pair that is absent altogether is not an error: the codes are optional on
 * every form that sends them, and "the editor did not choose a unit" is a
 * different thing from "the editor chose an impossible one".
 */
export function validateCurrentPair(
  input: UnitPairInput,
  lookups: UnitPairLookups,
  datasetVersion: string,
): UnitPairIssue | null {
  const provinceCode = input.provinceCode ?? null;
  const communeCode = input.communeCode ?? null;

  const legacy = legacyIssue(input.legacyDistrictCode ?? null, lookups.legacyDistrict);
  if (provinceCode === null && communeCode === null) return legacy;

  if (provinceCode === null || communeCode === null) {
    return {
      code: 'ADMINISTRATIVE_CODES_INCOMPLETE',
      // Named in terms of what is missing rather than "invalid pair": the form
      // has two boxes and the editor needs to know which one is empty.
      message:
        provinceCode === null
          ? 'a commune code needs the province code it belongs to'
          : 'a province code alone is not an address; choose a commune',
      field: provinceCode === null ? 'provinceCode' : 'communeCode',
    };
  }

  if (!lookups.province) {
    return {
      code: 'PROVINCE_NOT_CURRENT',
      message: `${provinceCode} is not a current province in ${datasetVersion}`,
      field: 'provinceCode',
    };
  }
  if (!lookups.commune) {
    return {
      code: 'COMMUNE_NOT_CURRENT',
      message: `${communeCode} is not a current commune in ${datasetVersion}`,
      field: 'communeCode',
    };
  }
  if (lookups.commune.parentCode !== provinceCode) {
    return {
      code: 'HIERARCHY_INVALID',
      message:
        `commune ${communeCode} belongs to ${lookups.commune.parentCode ?? 'no province'}, ` +
        `not to ${provinceCode}`,
      field: 'communeCode',
    };
  }
  return legacy;
}

function legacyIssue(
  code: string | null,
  lookup: CurrentUnitRef | undefined,
): UnitPairIssue | null {
  if (!code) return null;
  if (lookup) return null;
  return {
    code: 'LEGACY_DISTRICT_UNKNOWN',
    message: `${code} is not a district in the historical dataset`,
    field: 'legacyDistrictCode',
  };
}

/** The levels a pair is looked up at, so a caller cannot ask for the wrong one. */
export const PAIR_LEVELS: { province: UnitLevel; commune: UnitLevel; legacy: UnitLevel } = {
  province: 'PROVINCE',
  commune: 'COMMUNE',
  legacy: 'LEGACY_DISTRICT',
};
