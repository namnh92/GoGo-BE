import type { QuarantineClass } from './change-classification';
import type { ChangeRow, UnitRow } from './snapshot';

/**
 * ADM-004 (#457) / ADR-0019 §3 — the gates a staged dataset passes before
 * anyone may publish it.
 *
 * Two severities, and the difference is not a matter of taste:
 *
 * **ERROR** means the dataset asserts something that cannot be true — a commune
 * whose province is not in the same dataset, a change edge pointing at a unit
 * nobody holds, two current units claiming one code. Publishing it would put a
 * contradiction in front of every client, so an error blocks publication and
 * nothing overrides that.
 *
 * **WARNING** means the dataset is coherent but surprising — a tenth of the
 * communes vanished, a unit disappeared with no change row explaining it, the
 * source spelled a type prefix in lowercase. Surprising is not wrong: the 2025
 * reorganisation legitimately deleted 6,714 communes in one release. So a
 * warning is shown to the reviewer and never blocks, because a gate that cries
 * wolf on every real reorganisation is a gate people learn to click through.
 *
 * Every gate is pure. The service (`administrative-validation.service.ts`)
 * supplies the rows and persists the report; nothing here reads a database, so
 * every gate is testable on a handful of constructed units.
 */

/**
 * A unit as validation and diff see it: the read path's `UnitRow` plus the two
 * provenance columns. Kept here rather than widened onto `UnitRow` itself
 * because the read endpoints have no use for them, and a field that exists only
 * to be ignored is a field the next reader has to ask about.
 */
export type ProvenancedUnit = UnitRow & { source: string; sourceVersion: string };

export type Severity = 'ERROR' | 'WARNING';

export type GateId =
  | 'SNAPSHOT_CHECKSUM'
  | 'REQUIRED_FIELDS'
  | 'EMPTY_DATASET'
  | 'DUPLICATE_ACTIVE_IDENTITY'
  | 'EFFECTIVE_PERIOD_OVERLAP'
  | 'CURRENT_COMMUNE_PARENT'
  | 'HISTORICAL_HIERARCHY'
  | 'PARENT_CYCLE'
  | 'UNSUPPORTED_TYPE'
  | 'CHANGE_SOURCE_RESOLVES'
  | 'CHANGE_TARGET_RESOLVES'
  | 'CHANGE_HIERARCHY'
  | 'MERGE_SPLIT_STRUCTURE'
  | 'QUARANTINE_EXCLUDED'
  | 'COMBINED_VERSION_CONSISTENT'
  | 'SINGLE_PUBLISHED_VERSION'
  | 'RECORD_COUNT_DELTA'
  | 'REMOVED_UNIT_UNEXPLAINED'
  | 'SOURCE_FORMATTING'
  | 'UNRESOLVED_CHANGES'
  // ADM-011 (#484) — the three things a materialised reviewer override has to
  // be true about, beyond what any canonical edge already has to be.
  | 'OVERRIDE_PROVENANCE'
  | 'OVERRIDE_CONFLICT'
  | 'OVERRIDE_REVISION_CONSISTENT';

export type Finding = {
  gate: GateId;
  severity: Severity;
  message: string;
  /** How many rows tripped the gate. `samples` is a bounded window onto them. */
  count: number;
  /** Deterministic and capped: a report is read by a person, not a machine. */
  samples: string[];
};

export const SAMPLE_LIMIT = 10;

export type QuarantineSummary = {
  classification: QuarantineClass;
  oldCode: string | null;
  newCode: string | null;
};

/** What a gate run needs. Assembled by the service from one dataset version. */
export type DatasetUnderValidation = {
  datasetVersion: string;
  units: readonly ProvenancedUnit[];
  changes: readonly ChangeRow[];
  quarantine: readonly QuarantineSummary[];
  /** Recomputed from the pinned manifest; compared against the stored row. */
  expected: { combinedDatasetVersion: string; combinedChecksum: string };
  stored: { combinedDatasetVersion: string; combinedChecksum: string };
  /** Verified by the snapshot reader before parsing; false means drift. */
  snapshotChecksumsVerified: boolean;
  publishedVersionCount: number;
  /** The dataset's own override revision, for the #484 consistency gate. */
  overrideRevision: number;
  /** The currently published set, when there is one, for delta comparison. */
  baseline?: { datasetVersion: string; units: readonly ProvenancedUnit[] } | undefined;
};

export type ValidationReport = {
  datasetVersion: string;
  ranAt: string;
  findings: Finding[];
  errors: number;
  warnings: number;
  /** The only thing publication is allowed to consult. */
  publishable: boolean;
  counts: DatasetCounts;
};

export type DatasetCounts = {
  currentProvinces: number;
  currentCommunes: number;
  historicalProvinces: number;
  historicalDistricts: number;
  historicalCommunes: number;
  canonicalChanges: number;
  quarantined: number;
};

/**
 * A record-count swing beyond this fraction is worth a person's attention.
 * Deliberately generous: the 2025 reorganisation cut communes by two thirds in
 * one release, and a threshold that fires on the real event teaches reviewers
 * to ignore it.
 */
export const RECORD_COUNT_DELTA_THRESHOLD = 0.25;

const UNIT_TYPES = new Set([
  'PROVINCE',
  'MUNICIPALITY',
  'WARD',
  'COMMUNE',
  'SPECIAL_ZONE',
  'LEGACY_DISTRICT',
]);
const LEVELS = new Set(['PROVINCE', 'COMMUNE', 'LEGACY_DISTRICT']);
const CHANGE_TYPES = new Set(['CREATED', 'RENAMED', 'MERGED', 'SPLIT', 'REASSIGNED', 'DISSOLVED']);

/** Which unit types are legal at which level — the pair, not each alone. */
const TYPES_BY_LEVEL: Record<string, ReadonlySet<string>> = {
  PROVINCE: new Set(['PROVINCE', 'MUNICIPALITY']),
  COMMUNE: new Set(['WARD', 'COMMUNE', 'SPECIAL_ZONE']),
  LEGACY_DISTRICT: new Set(['LEGACY_DISTRICT']),
};

const isCurrent = (u: UnitRow) => u.status === 'ACTIVE' && u.effectiveTo === null;

function finding(
  gate: GateId,
  severity: Severity,
  message: string,
  offenders: string[],
): Finding | null {
  if (offenders.length === 0) return null;
  return {
    gate,
    severity,
    message,
    count: offenders.length,
    // Sorted before slicing so the same dataset always yields the same window.
    samples: [...offenders].sort().slice(0, SAMPLE_LIMIT),
  };
}

/** `(code, effectiveFrom)` — the identity, per ADR-0019 §2. Never the code alone. */
export function identity(unit: UnitRow): string {
  return `${unit.code}@${unit.effectiveFrom}`;
}

export function countUnits(
  units: readonly UnitRow[],
): Omit<DatasetCounts, 'canonicalChanges' | 'quarantined'> {
  let currentProvinces = 0;
  let currentCommunes = 0;
  let historicalProvinces = 0;
  let historicalDistricts = 0;
  let historicalCommunes = 0;
  for (const unit of units) {
    const current = isCurrent(unit);
    if (unit.level === 'PROVINCE') {
      if (current) currentProvinces += 1;
      else historicalProvinces += 1;
    } else if (unit.level === 'COMMUNE') {
      if (current) currentCommunes += 1;
      else historicalCommunes += 1;
    } else {
      // Every district-level unit is legacy by construction: the level was
      // dissolved on 2025-07-01, so there is no "current" bucket for it.
      historicalDistricts += 1;
    }
  }
  return {
    currentProvinces,
    currentCommunes,
    historicalProvinces,
    historicalDistricts,
    historicalCommunes,
  };
}

export function validateDataset(input: DatasetUnderValidation): ValidationReport {
  const findings: Finding[] = [];
  const push = (f: Finding | null) => {
    if (f) findings.push(f);
  };

  const current = input.units.filter(isCurrent);
  const byCode = new Map<string, UnitRow[]>();
  for (const unit of input.units) {
    const list = byCode.get(unit.code);
    if (list) list.push(unit);
    else byCode.set(unit.code, [unit]);
  }
  const currentByCode = new Map(current.map((u) => [u.code, u] as const));
  const currentProvinceCodes = new Set(
    current.filter((u) => u.level === 'PROVINCE').map((u) => u.code),
  );
  const historicalProvinceCodes = new Set(
    input.units.filter((u) => !isCurrent(u) && u.level === 'PROVINCE').map((u) => u.code),
  );

  // ---- ERROR gates -------------------------------------------------------

  if (!input.snapshotChecksumsVerified) {
    findings.push({
      gate: 'SNAPSHOT_CHECKSUM',
      severity: 'ERROR',
      message:
        'a pinned snapshot does not match its manifest checksum; the dataset was not built from the bytes that were reviewed',
      count: 1,
      samples: [],
    });
  }

  push(
    finding(
      'REQUIRED_FIELDS',
      'ERROR',
      'unit is missing a field the contract requires',
      input.units
        .filter(
          (u) =>
            !u.code?.trim() ||
            !u.name?.trim() ||
            !u.fullName?.trim() ||
            !u.unitType ||
            !u.level ||
            !u.effectiveFrom,
        )
        .map((u) => u.code || '(no code)'),
    ),
  );

  if (currentProvinceCodes.size === 0 || currentByCode.size === 0) {
    findings.push({
      gate: 'EMPTY_DATASET',
      severity: 'ERROR',
      message: 'the dataset has no current units; publishing it would empty the API',
      count: 1,
      samples: [],
    });
  }

  const duplicateActive: string[] = [];
  const seenCurrent = new Set<string>();
  for (const unit of current) {
    if (seenCurrent.has(unit.code)) duplicateActive.push(unit.code);
    seenCurrent.add(unit.code);
  }
  push(
    finding(
      'DUPLICATE_ACTIVE_IDENTITY',
      'ERROR',
      'two current units claim the same code, so the code resolves to neither',
      duplicateActive,
    ),
  );

  const overlaps: string[] = [];
  for (const [code, periods] of byCode) {
    const sorted = [...periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const next = sorted[i]!;
      // An open-ended earlier period overlaps everything after it; otherwise
      // the earlier period must close strictly before the next one opens.
      if (previous.effectiveTo === null || previous.effectiveTo >= next.effectiveFrom) {
        overlaps.push(`${code}@${previous.effectiveFrom}/${next.effectiveFrom}`);
      }
    }
  }
  push(
    finding(
      'EFFECTIVE_PERIOD_OVERLAP',
      'ERROR',
      'one code has two periods covering the same day, so it names two units at once',
      overlaps,
    ),
  );

  push(
    finding(
      'CURRENT_COMMUNE_PARENT',
      'ERROR',
      'current commune has no current province parent in this dataset',
      current
        .filter((u) => u.level === 'COMMUNE')
        .filter((u) => !u.parentCode || !currentProvinceCodes.has(u.parentCode))
        .map((u) => u.code),
    ),
  );

  push(
    finding(
      'HISTORICAL_HIERARCHY',
      'ERROR',
      'historical unit has no historical province parent in this dataset',
      input.units
        .filter((u) => !isCurrent(u) && u.level !== 'PROVINCE')
        .filter((u) => !u.parentCode || !historicalProvinceCodes.has(u.parentCode))
        .map((u) => identity(u)),
    ),
  );

  const cycles: string[] = [];
  for (const unit of input.units) {
    let cursor = unit.parentCode;
    const seen = new Set([unit.code]);
    let hops = 0;
    while (cursor && hops < 16) {
      if (seen.has(cursor)) {
        cycles.push(unit.code);
        break;
      }
      seen.add(cursor);
      cursor = byCode.get(cursor)?.[0]?.parentCode ?? null;
      hops += 1;
    }
  }
  push(finding('PARENT_CYCLE', 'ERROR', 'unit is its own ancestor', cycles));

  push(
    finding(
      'UNSUPPORTED_TYPE',
      'ERROR',
      'unit type or level is unknown, or the pair is not a legal combination',
      input.units
        .filter(
          (u) =>
            !UNIT_TYPES.has(u.unitType) ||
            !LEVELS.has(u.level) ||
            !TYPES_BY_LEVEL[u.level]?.has(u.unitType),
        )
        .map((u) => `${u.code}:${u.level}/${u.unitType}`),
    ),
  );

  push(
    finding(
      'CHANGE_SOURCE_RESOLVES',
      'ERROR',
      'canonical change names a predecessor this dataset does not hold',
      input.changes
        .filter((c) => c.oldCode !== null && !byCode.has(c.oldCode))
        .map((c) => `${c.oldCode}->${c.newCode}`),
    ),
  );

  push(
    finding(
      'CHANGE_TARGET_RESOLVES',
      'ERROR',
      'canonical change names a successor this dataset does not hold',
      input.changes
        .filter((c) => c.newCode !== null && !byCode.has(c.newCode))
        .map((c) => `${c.oldCode}->${c.newCode}`),
    ),
  );

  push(
    finding(
      'CHANGE_HIERARCHY',
      'ERROR',
      'canonical change points at a successor that is not a current unit',
      input.changes
        .filter((c) => c.newCode !== null && !currentByCode.has(c.newCode))
        .map((c) => `${c.oldCode}->${c.newCode}`),
    ),
  );

  // MERGED asserts that its target absorbed more than one predecessor; RENAMED
  // asserts it absorbed exactly one. A SPLIT is never canonical at all — the
  // source offers a default successor and ADR-0019 forbids trusting it.
  //
  // Predecessors are counted across canonical **and quarantined** rows, because
  // that is the universe the importer classified against. 104 of the pinned
  // MERGED rows have a single canonical predecessor and at least one more that
  // is quarantined pending review: the successor really did absorb several
  // units, and one of them is simply not decided yet. Counting only canonical
  // rows would report those 104 as malformed, which would be the gate
  // disagreeing with the import rather than with the data.
  const predecessorsByTarget = new Map<string, Set<string>>();
  const addPredecessor = (target: string | null, source: string | null) => {
    if (!target || !source) return;
    const set = predecessorsByTarget.get(target);
    if (set) set.add(source);
    else predecessorsByTarget.set(target, new Set([source]));
  };
  for (const change of input.changes) addPredecessor(change.newCode, change.oldCode);
  for (const row of input.quarantine) addPredecessor(row.newCode, row.oldCode);
  const structural: string[] = [];
  for (const change of input.changes) {
    if (!CHANGE_TYPES.has(change.changeType)) {
      structural.push(`${change.oldCode}->${change.newCode}:${change.changeType}`);
      continue;
    }
    /*
     * A SPLIT is never canonical **from the upstream**: the source offers a
     * default successor for a divided commune and ADR-0019 forbids trusting it.
     * A SPLIT a reviewer decided is a different claim entirely — it carries the
     * id of the decision that made it, and that is what the provenance gate
     * below checks. Without this exemption the override feature would have
     * shipped producing datasets its own validation calls malformed.
     */
    if (change.changeType === 'SPLIT') {
      if (!change.overrideDecisionId) {
        structural.push(`${change.oldCode}->${change.newCode}:SPLIT is never canonical`);
      }
      continue;
    }
    if (!change.newCode) continue;
    const predecessors = predecessorsByTarget.get(change.newCode)?.size ?? 0;
    if (change.changeType === 'MERGED' && predecessors < 2) {
      structural.push(`${change.oldCode}->${change.newCode}:MERGED with ${predecessors} source`);
    }
    if (change.changeType === 'RENAMED' && predecessors > 1) {
      structural.push(`${change.oldCode}->${change.newCode}:RENAMED with ${predecessors} sources`);
    }
  }
  push(
    finding(
      'MERGE_SPLIT_STRUCTURE',
      'ERROR',
      'change type contradicts the shape of the mapping it records',
      structural,
    ),
  );

  /*
   * An advisory row that is also canonical means the importer promoted
   * something it had quarantined — except where a reviewer decided it. The
   * quarantine row is *retained* through a materialisation on purpose: it is
   * the evidence of what the source said before anybody adjudicated it, and
   * dropping it to satisfy this gate would destroy the only record of the
   * question the decision answered.
   */
  const upstreamEdges = new Set(
    input.changes
      .filter((c) => !c.overrideDecisionId)
      .map((c) => `${c.oldCode ?? ''}>${c.newCode ?? ''}`),
  );
  push(
    finding(
      'QUARANTINE_EXCLUDED',
      'ERROR',
      'a quarantined advisory row also appears as a canonical change',
      input.quarantine
        .map((q) => `${q.oldCode ?? ''}>${q.newCode ?? ''}`)
        .filter((edge) => upstreamEdges.has(edge)),
    ),
  );

  // ADM-011 (#484) — what a materialised reviewer override must be true about.
  const overrides = input.changes.filter((c) => c.overrideDecisionId);
  push(
    finding(
      'OVERRIDE_PROVENANCE',
      'ERROR',
      'a reviewer override names no source or no target, so it asserts nothing',
      overrides
        .filter((c) => !c.oldCode || !c.newCode)
        .map((c) => `${c.oldCode ?? '?'}->${c.newCode ?? '?'}`),
    ),
  );

  // Two effective overrides sending one source to different successors is the
  // contradiction the whole append-only decision model exists to prevent. Until
  // GoGo-BE#622 the accept path could still produce it — a decision is taken
  // on a row, and two rows describe one divided commune — so this gate is what
  // caught it; it now also refuses at decision time.
  const overrideTargets = new Map<string, Set<string>>();
  for (const change of overrides) {
    if (!change.oldCode || !change.newCode) continue;
    const targets = overrideTargets.get(change.oldCode) ?? new Set<string>();
    targets.add(change.newCode);
    overrideTargets.set(change.oldCode, targets);
  }
  push(
    finding(
      'OVERRIDE_CONFLICT',
      'ERROR',
      'one source carries reviewer overrides onto more than one successor',
      [...overrideTargets.entries()]
        .filter(([, targets]) => targets.size > 1)
        .map(([source, targets]) => `${source}->${[...targets].sort().join('|')}`),
    ),
  );

  // A dataset holding reviewer overrides at revision 0 is one whose identity
  // does not account for them — and the identity is what publication and the
  // duplicate-import gate both read.
  push(
    finding(
      'OVERRIDE_REVISION_CONSISTENT',
      'ERROR',
      'the dataset carries reviewer overrides but its override revision is zero',
      overrides.length > 0 && input.overrideRevision === 0
        ? [`${overrides.length} override edge(s) at r0`]
        : [],
    ),
  );

  if (
    input.stored.combinedDatasetVersion !== input.expected.combinedDatasetVersion ||
    input.stored.combinedChecksum !== input.expected.combinedChecksum
  ) {
    findings.push({
      gate: 'COMBINED_VERSION_CONSISTENT',
      severity: 'ERROR',
      message:
        'the stored combined version or checksum does not match what the pinned components produce',
      count: 1,
      samples: [
        `stored=${input.stored.combinedDatasetVersion}/${input.stored.combinedChecksum.slice(0, 12)}`,
        `expected=${input.expected.combinedDatasetVersion}/${input.expected.combinedChecksum.slice(0, 12)}`,
      ],
    });
  }

  if (input.publishedVersionCount > 1) {
    findings.push({
      gate: 'SINGLE_PUBLISHED_VERSION',
      severity: 'ERROR',
      message: `${input.publishedVersionCount} datasets are published at once; exactly one may be`,
      count: input.publishedVersionCount,
      samples: [],
    });
  }

  // ---- WARNING gates -----------------------------------------------------

  const counts: DatasetCounts = {
    ...countUnits(input.units),
    canonicalChanges: input.changes.length,
    quarantined: input.quarantine.length,
  };

  if (input.baseline) {
    const baselineCounts = countUnits(input.baseline.units);
    const deltas: string[] = [];
    for (const key of ['currentProvinces', 'currentCommunes'] as const) {
      const before = baselineCounts[key];
      const after = counts[key];
      if (before === 0) continue;
      const delta = Math.abs(after - before) / before;
      if (delta > RECORD_COUNT_DELTA_THRESHOLD) {
        deltas.push(`${key}: ${before} → ${after} (${(delta * 100).toFixed(1)}%)`);
      }
    }
    push(
      finding(
        'RECORD_COUNT_DELTA',
        'WARNING',
        `record count moved more than ${(RECORD_COUNT_DELTA_THRESHOLD * 100).toFixed(0)}% against the published dataset`,
        deltas,
      ),
    );

    // A unit that was current and is now absent should be explained by a change
    // edge. Absent explanation is not wrong — a decree can simply retire a unit
    // — but it is the shape of an import that lost rows, so it is surfaced.
    const explained = new Set(input.changes.map((c) => c.oldCode).filter(Boolean) as string[]);
    push(
      finding(
        'REMOVED_UNIT_UNEXPLAINED',
        'WARNING',
        'unit was current in the published dataset, is absent here, and no change row explains it',
        input.baseline.units
          .filter(isCurrent)
          .filter((u) => !currentByCode.has(u.code) && !explained.has(u.code))
          .map((u) => u.code),
      ),
    );
  }

  push(
    finding(
      'SOURCE_FORMATTING',
      'WARNING',
      'source spelled a unit type prefix in a case the rest of the file does not use',
      input.units
        // A space, not `\b`: these words end in non-ASCII letters and JS word
        // boundaries are ASCII-only, so `\b` never matches after "xã".
        .filter((u) =>
          /^(xã|phường|đặc khu|tỉnh|thành phố|thị trấn|thị xã|quận|huyện) /.test(u.fullName),
        )
        .map((u) => `${u.code}: ${u.fullName}`),
    ),
  );

  const divided = input.quarantine.filter(
    (q) => q.classification === 'DIVIDED_REQUIRES_REVIEW',
  ).length;
  if (input.quarantine.length > 0) {
    findings.push({
      gate: 'UNRESOLVED_CHANGES',
      severity: 'WARNING',
      message: `${input.quarantine.length} advisory mapping rows are quarantined (${divided} from divided communes) and await review`,
      count: input.quarantine.length,
      samples: [...input.quarantine]
        .map((q) => `${q.classification}:${q.oldCode ?? '?'}>${q.newCode ?? '?'}`)
        .sort()
        .slice(0, SAMPLE_LIMIT),
    });
  }

  // Stable order: errors first, then by gate name, so two runs of the same
  // dataset produce byte-identical reports.
  findings.sort((a, b) =>
    a.severity === b.severity ? a.gate.localeCompare(b.gate) : a.severity === 'ERROR' ? -1 : 1,
  );

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  return {
    datasetVersion: input.datasetVersion,
    ranAt: new Date().toISOString(),
    findings,
    errors,
    warnings: findings.length - errors,
    publishable: errors === 0,
    counts,
  };
}
