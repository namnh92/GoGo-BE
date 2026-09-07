import { normalizeVietnamese } from '../../search/domain/normalize';
import {
  deriveUnitType,
  stripTypePrefix,
  type UnitLevel,
  type UnitType,
} from '../domain/unit-type';

/**
 * ADM-002 (#455) — turning a pinned unit snapshot into rows.
 *
 * Two shapes, one parser each. The current snapshot is two-level (province →
 * wards); the historical one is three (province → District → Ward). Both name
 * their nesting explicitly, which is what supplies the level — see
 * `domain/unit-type.ts` for why the prefix cannot.
 */

export type ParsedUnit = {
  code: string;
  name: string;
  fullName: string;
  nameEn: string | null;
  nameNormalized: string;
  fullNameNormalized: string;
  codeName: string | null;
  unitType: UnitType;
  level: UnitLevel;
  parentCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'FUTURE';
};

export type ParseResult = { units: ParsedUnit[]; warnings: string[] };

type CurrentProvince = {
  Code: string;
  Name: string;
  NameEn?: string;
  FullName: string;
  CodeName?: string;
  Wards: {
    Code: string;
    Name: string;
    NameEn?: string;
    FullName: string;
    CodeName?: string;
    ProvinceCode: string;
  }[];
};

type HistoricalProvince = {
  Code: string;
  Name: string;
  NameEn?: string;
  FullName: string;
  CodeName?: string;
  District: {
    Code: string;
    Name: string;
    NameEn?: string;
    FullName: string;
    CodeName?: string;
    Ward: {
      Code: string;
      Name: string;
      NameEn?: string;
      FullName: string;
      CodeName?: string;
    }[];
  }[];
};

/** The reorganisation's effective date; the hinge both snapshots sit either side of. */
export const REORGANISATION_DATE = '2025-07-01';
export const LEGACY_EFFECTIVE_TO = '2025-06-30';

function build(
  level: UnitLevel,
  raw: { Code: string; Name: string; NameEn?: string; FullName: string; CodeName?: string },
  parentCode: string | null,
  dates: { effectiveFrom: string; effectiveTo: string | null; status: ParsedUnit['status'] },
  warnings: string[],
): ParsedUnit {
  const derived = deriveUnitType(level, raw.FullName);
  if (!derived.ok) throw new Error(`${raw.Code}: ${derived.reason}`);
  if (derived.warning) warnings.push(`${raw.Code}: ${derived.warning}`);

  // The source's own `Name` is preferred; where it is missing the prefix is
  // stripped from `FullName` rather than the whole string being used, so
  // "Phường Ba Đình" never becomes the searchable short name.
  const name = raw.Name?.trim() || stripTypePrefix(level, raw.FullName);
  return {
    code: raw.Code,
    name,
    fullName: raw.FullName.trim(),
    nameEn: raw.NameEn?.trim() || null,
    nameNormalized: normalizeVietnamese(name),
    fullNameNormalized: normalizeVietnamese(raw.FullName),
    codeName: raw.CodeName?.trim() || null,
    unitType: derived.unitType,
    level,
    parentCode,
    ...dates,
  };
}

export function parseCurrentUnits(data: CurrentProvince[]): ParseResult {
  const warnings: string[] = [];
  const units: ParsedUnit[] = [];
  const active = {
    effectiveFrom: REORGANISATION_DATE,
    effectiveTo: null,
    status: 'ACTIVE' as const,
  };
  for (const province of data) {
    units.push(build('PROVINCE', province, null, active, warnings));
    for (const ward of province.Wards) {
      units.push(build('COMMUNE', ward, province.Code, active, warnings));
    }
  }
  return { units, warnings };
}

/**
 * Historical units are imported `INACTIVE` and closed on 2025-06-30. They exist
 * so a pre-reorganisation address still names a real unit and so the advisory
 * mapping's sources can be resolved — not as anything a current-data read
 * returns. `LEGACY_DISTRICT` is excluded from those reads by level; the
 * historical communes are excluded by being inactive and closed.
 */
export function parseHistoricalUnits(data: HistoricalProvince[]): ParseResult {
  const warnings: string[] = [];
  const units: ParsedUnit[] = [];
  const closed = {
    // The upstream carries no start date for these. Claiming one GoGo does not
    // know would be worse than the earliest date the data can support, so the
    // period opens at the snapshot's own origin and closes where the law did.
    effectiveFrom: '1900-01-01',
    effectiveTo: LEGACY_EFFECTIVE_TO,
    status: 'INACTIVE' as const,
  };
  for (const province of data) {
    units.push(build('PROVINCE', province, null, closed, warnings));
    for (const district of province.District ?? []) {
      units.push(build('LEGACY_DISTRICT', district, province.Code, closed, warnings));
      for (const ward of district.Ward ?? []) {
        // Parented to the province, not the district: the commune level hangs
        // off the province in GoGo's model, and a legacy commune's province is
        // the fact that survives the reorganisation. The district it sat in is
        // recorded by the change edges, not by the hierarchy.
        units.push(build('COMMUNE', ward, province.Code, closed, warnings));
      }
    }
  }
  return { units, warnings };
}
