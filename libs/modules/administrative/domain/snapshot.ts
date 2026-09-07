import { normalizeVietnamese } from '../../search/domain/normalize';
import type { UnitLevel, UnitType } from './unit-type';

/**
 * ADM-003 (#456) / ADR-0019 §8 — one published dataset, indexed once.
 *
 * A snapshot is built when a version becomes active and never mutated after.
 * Every read endpoint answers out of these maps, so a request never queries the
 * full dataset — the whole point of the in-process design, and the reason it is
 * cheaper than a Redis round trip rather than merely different.
 *
 * The indexes are chosen by the questions the six endpoints actually ask; a map
 * that no endpoint reads is memory spent for nothing.
 */

export type UnitRow = {
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
  status: 'ACTIVE' | 'INACTIVE' | 'FUTURE';
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type ChangeRow = {
  oldCode: string | null;
  newCode: string | null;
  changeType: string;
  effectiveDate: string;
  legalReference: string | null;
};

export type SearchEntry = {
  unit: UnitRow;
  /** Both forms are indexed so "ba dinh" and "phuong ba dinh" both hit. */
  nameNormalized: string;
  fullNameNormalized: string;
};

export type DatasetSnapshot = {
  datasetVersion: string;
  datasetVersionId: string;
  effectiveDate: string;
  publishedAt: string | null;
  /** Every effective period of a code, oldest first. Code reuse lives here. */
  byCode: ReadonlyMap<string, readonly UnitRow[]>;
  currentProvinces: readonly UnitRow[];
  communesByProvince: ReadonlyMap<string, readonly UnitRow[]>;
  /** Current units first, then legacy — so a search can stop early by default. */
  currentSearch: readonly SearchEntry[];
  legacySearch: readonly SearchEntry[];
  /** Canonical changes only. Quarantined rows are not changes and never appear. */
  changesByOldCode: ReadonlyMap<string, readonly ChangeRow[]>;
  changesByNewCode: ReadonlyMap<string, readonly ChangeRow[]>;
  counts: {
    provinces: number;
    communes: number;
    legacyDistricts: number;
    legacyCommunes: number;
    changes: number;
  };
};

/** A unit is *current* when it is active and its period has not been closed. */
export function isCurrent(unit: UnitRow): boolean {
  return unit.status === 'ACTIVE' && unit.effectiveTo === null;
}

/**
 * Which period a code denoted on a given date.
 *
 * This is the reason a code alone is not an identity: 2,212 of the 3,321
 * current commune codes named a different unit before 2025-07-01. Asking for
 * `00004` without a date is asking for the current one; asking with a date is
 * asking what it meant then, and the two are different units.
 */
export function unitAt(periods: readonly UnitRow[], date: string): UnitRow | undefined {
  return periods.find(
    (u) => u.effectiveFrom <= date && (u.effectiveTo === null || date <= u.effectiveTo),
  );
}

function byCodeAsc(a: UnitRow, b: UnitRow): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function buildSnapshot(input: {
  datasetVersion: string;
  datasetVersionId: string;
  effectiveDate: string;
  publishedAt: string | null;
  units: readonly UnitRow[];
  changes: readonly ChangeRow[];
}): DatasetSnapshot {
  const byCode = new Map<string, UnitRow[]>();
  for (const unit of input.units) {
    const periods = byCode.get(unit.code);
    if (periods) periods.push(unit);
    else byCode.set(unit.code, [unit]);
  }
  // Oldest period first, so `unitAt` scans in a defined order and a caller
  // reading the list sees a history rather than an arbitrary pair.
  for (const periods of byCode.values()) {
    periods.sort((a, b) =>
      a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
    );
  }

  const currentProvinces: UnitRow[] = [];
  const communesByProvince = new Map<string, UnitRow[]>();
  const currentSearch: SearchEntry[] = [];
  const legacySearch: SearchEntry[] = [];

  for (const unit of input.units) {
    const entry: SearchEntry = {
      unit,
      nameNormalized: unit.nameNormalized,
      fullNameNormalized: unit.fullNameNormalized,
    };
    if (isCurrent(unit)) {
      currentSearch.push(entry);
      if (unit.level === 'PROVINCE') currentProvinces.push(unit);
      if (unit.level === 'COMMUNE' && unit.parentCode) {
        const siblings = communesByProvince.get(unit.parentCode);
        if (siblings) siblings.push(unit);
        else communesByProvince.set(unit.parentCode, [unit]);
      }
    } else {
      legacySearch.push(entry);
    }
  }

  // Stable ordering is a contract, not a nicety: a cursor page is only
  // meaningful if the same query orders the same way every time, and code is
  // the only total order these rows carry.
  currentProvinces.sort(byCodeAsc);
  for (const siblings of communesByProvince.values()) siblings.sort(byCodeAsc);
  const searchOrder = (a: SearchEntry, b: SearchEntry) => byCodeAsc(a.unit, b.unit);
  currentSearch.sort(searchOrder);
  legacySearch.sort(searchOrder);

  const changesByOldCode = new Map<string, ChangeRow[]>();
  const changesByNewCode = new Map<string, ChangeRow[]>();
  for (const change of input.changes) {
    if (change.oldCode) {
      const list = changesByOldCode.get(change.oldCode);
      if (list) list.push(change);
      else changesByOldCode.set(change.oldCode, [change]);
    }
    if (change.newCode) {
      const list = changesByNewCode.get(change.newCode);
      if (list) list.push(change);
      else changesByNewCode.set(change.newCode, [change]);
    }
  }
  const changeOrder = (a: ChangeRow, b: ChangeRow) =>
    (a.newCode ?? '') < (b.newCode ?? '')
      ? -1
      : (a.newCode ?? '') > (b.newCode ?? '')
        ? 1
        : (a.oldCode ?? '') < (b.oldCode ?? '')
          ? -1
          : (a.oldCode ?? '') > (b.oldCode ?? '')
            ? 1
            : 0;
  for (const list of changesByOldCode.values()) list.sort(changeOrder);
  for (const list of changesByNewCode.values()) list.sort(changeOrder);

  const legacyDistricts = input.units.filter((u) => u.level === 'LEGACY_DISTRICT').length;
  return {
    datasetVersion: input.datasetVersion,
    datasetVersionId: input.datasetVersionId,
    effectiveDate: input.effectiveDate,
    publishedAt: input.publishedAt,
    byCode,
    currentProvinces,
    communesByProvince,
    currentSearch,
    legacySearch,
    changesByOldCode,
    changesByNewCode,
    counts: {
      provinces: currentProvinces.length,
      communes: [...communesByProvince.values()].reduce((n, l) => n + l.length, 0),
      legacyDistricts,
      legacyCommunes: legacySearch.filter((e) => e.unit.level === 'COMMUNE').length,
      changes: input.changes.length,
    },
  };
}

/** Accent-insensitive, matching the SQL side through the one shared normalizer. */
export function matches(entry: SearchEntry, needle: string): boolean {
  return entry.nameNormalized.includes(needle) || entry.fullNameNormalized.includes(needle);
}

export { normalizeVietnamese };
