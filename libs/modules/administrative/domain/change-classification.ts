import type { schema } from '@gogo/database';

/**
 * ADM-002 (#455) / ADR-0019 §6 — classifying advisory change-mapping rows.
 *
 * The mapping upstream is **advisory**. It is a third party's reading of the
 * 2025 reorganisation, last updated 2025-10-08, and it is not authoritative for
 * anything. A row becomes a canonical `administrative_unit_changes` edge only
 * when both of its endpoints resolve against the two pinned unit snapshots —
 * so a canonical edge can never point at a unit that does not exist, and
 * nothing here can mint a current unit to satisfy a mapping target.
 *
 * Everything else is quarantined with its raw payload kept verbatim, so a
 * reviewer sees what the source said rather than GoGo's reading of it.
 *
 * The one class that matters most is `DIVIDED_REQUIRES_REVIEW`. The source
 * offers a single "default" target for a split commune. That default is exactly
 * the guess ADR-0019 forbids: 471 historical communes were split across 2–5
 * current ones, and which one a given address landed in is a question about
 * coordinates or a person, never about which row the CSV happened to list.
 */

export type QuarantineClass = (typeof schema.administrativeQuarantineClass.enumValues)[number];

/** One row of `convert_legacy_2025_simple.csv`, already split into fields. */
export type MappingRow = {
  provinceCode: string;
  districtCode: string;
  /** Absent for the five district-level sources; see `manifest.json`. */
  wardCode: string | null;
  province: string;
  district: string;
  ward: string;
  newProvinceCode: string;
  newWardCode: string;
  newProvince: string;
  newWard: string;
  isMergedWard: boolean;
  isDividedWard: boolean;
};

export type UnitIndex = {
  /** Current commune code → its province code. */
  currentCommuneProvince: ReadonlyMap<string, string>;
  currentProvinces: ReadonlySet<string>;
  historicalCommunes: ReadonlySet<string>;
  historicalDistricts: ReadonlySet<string>;
};

export type Classified = {
  row: MappingRow;
  classification: QuarantineClass;
  reason: string;
  /** Canonical rows carry the edge; quarantined rows carry none. */
  edge?: { oldCode: string; newCode: string; changeType: ChangeType };
  /** For an undecidable split: what GoGo could offer, never what it picked. */
  candidates: string[];
};

export type ChangeType = (typeof schema.administrativeChangeType.enumValues)[number];

const CANONICAL: ReadonlySet<QuarantineClass> = new Set<QuarantineClass>([
  'VALID_UNIQUE',
  'VALID_MERGE',
  'VALID_DISTRICT_TO_SPECIAL_ZONE',
]);

export function isCanonical(c: QuarantineClass): boolean {
  return CANONICAL.has(c);
}

/**
 * Classifies the whole file at once, because three of the classes are
 * properties of a *group* of rows rather than of any single row: whether a
 * legacy commune has one target or several, whether a current commune is the
 * target of one predecessor or many, and whether the same edge appears twice.
 */
export function classifyMapping(rows: readonly MappingRow[], index: UnitIndex): Classified[] {
  const byOldCode = new Map<string, MappingRow[]>();
  const targetPredecessors = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.wardCode) continue;
    const group = byOldCode.get(row.wardCode);
    if (group) group.push(row);
    else byOldCode.set(row.wardCode, [row]);

    const predecessors = targetPredecessors.get(row.newWardCode);
    if (predecessors) predecessors.add(row.wardCode);
    else targetPredecessors.set(row.newWardCode, new Set([row.wardCode]));
  }

  const seenEdges = new Set<string>();
  const out: Classified[] = [];

  for (const row of rows) {
    out.push(classifyOne(row, index, byOldCode, targetPredecessors, seenEdges));
  }
  return out;
}

function classifyOne(
  row: MappingRow,
  index: UnitIndex,
  byOldCode: ReadonlyMap<string, MappingRow[]>,
  targetPredecessors: ReadonlyMap<string, ReadonlySet<string>>,
  seenEdges: Set<string>,
): Classified {
  const none: string[] = [];

  // A district-level source is not a malformed commune row. Five island
  // districts became đặc khu whole, so the predecessor is genuinely a district
  // — two of them changing province as well (Cồn Cỏ 45→44, Côn Đảo 77→79).
  if (!row.wardCode) {
    if (!index.historicalDistricts.has(row.districtCode)) {
      return {
        row,
        classification: 'SOURCE_NOT_FOUND',
        reason: `district ${row.districtCode} is not in the historical snapshot`,
        candidates: none,
      };
    }
    if (!index.currentCommuneProvince.has(row.newWardCode)) {
      return {
        row,
        classification: 'TARGET_NOT_FOUND',
        reason: `current unit ${row.newWardCode} does not exist — a mapping target is never minted`,
        candidates: none,
      };
    }
    return {
      row,
      classification: 'VALID_DISTRICT_TO_SPECIAL_ZONE',
      reason: 'district-level predecessor became a special zone whole',
      edge: {
        oldCode: row.districtCode,
        newCode: row.newWardCode,
        changeType: 'REASSIGNED',
      },
      candidates: none,
    };
  }

  if (!index.historicalCommunes.has(row.wardCode)) {
    return {
      row,
      classification: 'SOURCE_NOT_FOUND',
      reason: `commune ${row.wardCode} is not in the historical snapshot`,
      candidates: none,
    };
  }

  const targetProvince = index.currentCommuneProvince.get(row.newWardCode);
  if (targetProvince === undefined) {
    return {
      row,
      classification: 'TARGET_NOT_FOUND',
      reason: `current commune ${row.newWardCode} does not exist — a mapping target is never minted`,
      candidates: none,
    };
  }
  if (!index.currentProvinces.has(row.newProvinceCode)) {
    return {
      row,
      classification: 'HIERARCHY_CONFLICT',
      reason: `province ${row.newProvinceCode} does not exist in the current snapshot`,
      candidates: none,
    };
  }
  if (targetProvince !== row.newProvinceCode) {
    return {
      row,
      classification: 'HIERARCHY_CONFLICT',
      reason: `commune ${row.newWardCode} sits in province ${targetProvince}, not ${row.newProvinceCode}`,
      candidates: none,
    };
  }

  const edgeKey = `${row.wardCode}>${row.newWardCode}`;
  if (seenEdges.has(edgeKey)) {
    return {
      row,
      classification: 'DUPLICATE',
      reason: `edge ${edgeKey} already seen in this file`,
      candidates: none,
    };
  }
  seenEdges.add(edgeKey);

  const siblings = byOldCode.get(row.wardCode) ?? [];
  const distinctTargets = new Set(siblings.map((s) => s.newWardCode));

  // The source's own split flag, and the shape of the data, must agree. Where
  // either says the commune was divided, no single target may be recorded.
  if (row.isDividedWard || distinctTargets.size > 1) {
    return {
      row,
      classification: row.isDividedWard ? 'DIVIDED_REQUIRES_REVIEW' : 'MULTIPLE_TARGETS',
      reason: row.isDividedWard
        ? `commune ${row.wardCode} was divided across ${distinctTargets.size} current units; the source's default target is a guess and is not recorded`
        : `commune ${row.wardCode} has ${distinctTargets.size} targets but is not flagged divided`,
      candidates: [...distinctTargets].sort(),
    };
  }

  const predecessors = targetPredecessors.get(row.newWardCode);
  const merged = (predecessors?.size ?? 1) > 1;
  return {
    row,
    classification: merged ? 'VALID_MERGE' : 'VALID_UNIQUE',
    reason: merged
      ? `commune ${row.newWardCode} absorbed ${predecessors?.size ?? 0} predecessors`
      : 'one predecessor, one successor',
    edge: {
      oldCode: row.wardCode,
      newCode: row.newWardCode,
      changeType: merged ? 'MERGED' : 'RENAMED',
    },
    candidates: none,
  };
}

/** Counts by class, for the validation report and the CMS drift queue. */
export function summarise(classified: readonly Classified[]): Record<QuarantineClass, number> {
  const out = {} as Record<QuarantineClass, number>;
  for (const c of classified) out[c.classification] = (out[c.classification] ?? 0) + 1;
  return out;
}
