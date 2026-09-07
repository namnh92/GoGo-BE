import type { schema } from '@gogo/database';

/**
 * ADM-002 (#455) — deriving a unit's type from the name the source gives it.
 *
 * The upstream carries no type column: `administrative_units.id` in its schema
 * is a lookup GoGo does not import, and the only per-row signal is the Vietnamese
 * prefix on `FullName` — "Tỉnh Lạng Sơn", "Phường Ba Đình", "Đặc khu Côn Đảo".
 *
 * **The prefix refines a level; it never decides one.** "Thành phố" appears at
 * both levels in the historical snapshot — 6 province-level cities and 87
 * district-level ones — so a prefix-only mapping would file Thành phố Thủ Đức
 * as a municipality. The level comes from where the row sits in the source
 * structure (a province's `District`, a district's `Ward`), which is the one
 * thing the source states unambiguously.
 *
 * Matching is case-insensitive because the data is not consistent: ward `06325`
 * is `"xã Bắc Sơn"` where every other row capitalises. That is a source defect
 * carried as a warning, not silently corrected — see `manifest.json`.
 */

export type UnitType = (typeof schema.administrativeUnitType.enumValues)[number];
export type UnitLevel = (typeof schema.administrativeLevel.enumValues)[number];

/**
 * Prefixes per level, longest first so "Thị xã" is tested before "Thị trấn"
 * cannot shadow it and "Thành phố" before nothing shorter matches it.
 */
const PROVINCE_PREFIXES: ReadonlyArray<readonly [string, UnitType]> = [
  ['thành phố', 'MUNICIPALITY'],
  ['tỉnh', 'PROVINCE'],
];

const COMMUNE_PREFIXES: ReadonlyArray<readonly [string, UnitType]> = [
  ['đặc khu', 'SPECIAL_ZONE'],
  ['phường', 'WARD'],
  // A thị trấn is the township of a rural district: a commune-level unit, and
  // GoGo's `COMMUNE` is exactly that level. The distinction is not lost — the
  // row keeps "Thị trấn X" verbatim in `full_name`, which is the record of what
  // the unit was called. 617 historical rows; none current, since the 2025
  // reorganisation retired the designation.
  ['thị trấn', 'COMMUNE'],
  ['xã', 'COMMUNE'],
];

/**
 * Every district-level unit is `LEGACY_DISTRICT` whatever it was called —
 * quận, huyện, thị xã or thành phố. The level is what makes it legacy, not the
 * word: all four were dissolved together on 2025-07-01.
 */
const DISTRICT_PREFIXES: ReadonlyArray<readonly [string, UnitType]> = [
  ['thành phố', 'LEGACY_DISTRICT'],
  ['thị xã', 'LEGACY_DISTRICT'],
  ['quận', 'LEGACY_DISTRICT'],
  ['huyện', 'LEGACY_DISTRICT'],
];

const BY_LEVEL: Record<UnitLevel, ReadonlyArray<readonly [string, UnitType]>> = {
  PROVINCE: PROVINCE_PREFIXES,
  COMMUNE: COMMUNE_PREFIXES,
  LEGACY_DISTRICT: DISTRICT_PREFIXES,
};

export type UnitTypeResult =
  { ok: true; unitType: UnitType; warning?: string } | { ok: false; reason: string };

/**
 * `fullName` is the source's own string, prefix included. The level must be
 * supplied by the caller from the source structure — see the file header.
 */
export function deriveUnitType(level: UnitLevel, fullName: string): UnitTypeResult {
  const trimmed = fullName.trim();
  const lowered = trimmed.toLowerCase();
  for (const [prefix, unitType] of BY_LEVEL[level]) {
    if (!lowered.startsWith(prefix)) continue;
    // The prefix matched only because we lowered it; if the source did too,
    // say so rather than repairing it silently.
    const warning = trimmed.startsWith(prefix)
      ? `unit type prefix is lowercase in the source: ${JSON.stringify(trimmed)}`
      : undefined;
    return warning ? { ok: true, unitType, warning } : { ok: true, unitType };
  }
  return {
    ok: false,
    reason: `no known ${level} unit type in ${JSON.stringify(trimmed)}`,
  };
}

/** The short name with its type prefix removed, for display and for search. */
export function stripTypePrefix(level: UnitLevel, fullName: string): string {
  const trimmed = fullName.trim();
  const lowered = trimmed.toLowerCase();
  for (const [prefix] of BY_LEVEL[level]) {
    if (lowered.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}
