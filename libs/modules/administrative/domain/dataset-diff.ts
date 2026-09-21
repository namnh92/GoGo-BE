import type { ChangeRow } from './snapshot';
import { identity, type ProvenancedUnit, type QuarantineSummary } from './validation';

/**
 * ADM-004 (#457) / ADR-0019 — what changed between two dataset versions.
 *
 * The diff exists for a person: a reviewer deciding whether to publish needs to
 * see what would move, not a row count. So every entry carries both identities
 * with their effective periods, where the claim came from, and how many places
 * it touches — enough to judge one line without opening psql.
 *
 * **A code is not an identity here either.** Entries key on
 * `(code, effectiveFrom)`, because 2,212 of the 3,321 current commune codes
 * named a different unit before 2025-07-01. Diffing on code alone would report
 * 2,212 renames where there were two distinct units, and would miss every
 * genuine reuse.
 *
 * Two structural sources feed it. Unit-shape categories (CREATED, DISSOLVED,
 * RENAMED, PARENT_CHANGED, STATUS_CHANGED, EFFECTIVE_PERIOD_CHANGED) are
 * derived by comparing the two unit sets. Migration categories (MERGED, SPLIT,
 * REASSIGNED) come from the new version's canonical change rows, because a
 * merge is an assertion the dataset makes, not something a shape comparison can
 * infer. UNRESOLVED comes from quarantine, and SOURCE_DRIFT from the pinned
 * component versions.
 */

export type DiffCategory =
  | 'CREATED'
  | 'RENAMED'
  | 'MERGED'
  | 'SPLIT'
  | 'REASSIGNED'
  | 'DISSOLVED'
  | 'PARENT_CHANGED'
  | 'STATUS_CHANGED'
  | 'EFFECTIVE_PERIOD_CHANGED'
  | 'UNRESOLVED'
  | 'SOURCE_DRIFT'
  /**
   * ADM-011 (#484). A reviewer decision that reached a dataset is not the same
   * claim as an upstream migration, and a diff that reported it as one would
   * hide the only change a publication reviewer is actually being asked about.
   * Added rather than folded into SOURCE_DRIFT: the contract types `category`
   * as a string and `countsByCategory` as a free map, so this is additive.
   */
  | 'OVERRIDE_ACCEPTED'
  | 'OVERRIDE_TARGET_CHANGED'
  /**
   * ADM-028 (#623). A reviewer override the baseline carried and this version
   * does not: the decided row was rejected in a later round, the edge was not
   * copied, and the source is unresolved again. Nothing on the to-side
   * mentions it, so it is derived from what the baseline had.
   */
  | 'OVERRIDE_RETRACTED';

export type DiffIdentity = {
  code: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  fullName: string | null;
  level: string | null;
  parentCode: string | null;
  status: string | null;
};

export type DiffEntry = {
  category: DiffCategory;
  /** Stable, unique, and independent of iteration order. Used for ordering. */
  key: string;
  from: DiffIdentity | null;
  to: DiffIdentity | null;
  detail: string;
  /** Which pinned source asserted this, so a reviewer can weigh it. */
  provenance: string;
  /** Gate ids whose findings touch this entry, so a reviewer can cross-read. */
  validation: string[];
};

export type AffectedPlaces = {
  /** Places carrying a mapped code this diff touches. UNMAPPED never counts. */
  total: number;
  /** Bounded, deterministic. `truncated` says whether more exist. */
  samples: { placeId: string; name: string; code: string; status: string }[];
  truncated: boolean;
  sampleLimit: number;
};

export type DatasetDiff = {
  fromVersion: string | null;
  toVersion: string;
  countsByCategory: Record<DiffCategory, number>;
  entries: DiffEntry[];
  /** Entries are capped; the counts above are not. */
  entriesTruncated: boolean;
  entryLimit: number;
  affectedPlaces: AffectedPlaces;
};

export const DIFF_ENTRY_LIMIT = 500;

const CATEGORIES: DiffCategory[] = [
  'CREATED',
  'RENAMED',
  'MERGED',
  'SPLIT',
  'REASSIGNED',
  'DISSOLVED',
  'PARENT_CHANGED',
  'STATUS_CHANGED',
  'EFFECTIVE_PERIOD_CHANGED',
  'UNRESOLVED',
  'SOURCE_DRIFT',
  'OVERRIDE_ACCEPTED',
  'OVERRIDE_TARGET_CHANGED',
  'OVERRIDE_RETRACTED',
];

function toIdentity(unit: ProvenancedUnit | undefined): DiffIdentity | null {
  if (!unit) return null;
  return {
    code: unit.code,
    effectiveFrom: unit.effectiveFrom,
    effectiveTo: unit.effectiveTo,
    fullName: unit.fullName,
    level: unit.level,
    parentCode: unit.parentCode,
    status: unit.status,
  };
}

export type DiffInput = {
  fromVersion: string | null;
  toVersion: string;
  fromUnits: readonly ProvenancedUnit[];
  toUnits: readonly ProvenancedUnit[];
  toChanges: readonly ChangeRow[];
  toQuarantine: readonly QuarantineSummary[];
  /**
   * The baseline's own edges. A migration the published dataset already
   * asserted is not news: re-listing all 9,569 of them because a reviewer
   * bumped an override revision would bury the one thing that actually moved.
   * Absent (first publication) means everything is new, which it is.
   */
  fromChanges?: readonly ChangeRow[] | undefined;
  fromQuarantine?: readonly QuarantineSummary[] | undefined;
  fromSources: Record<string, string | null> | null;
  toSources: Record<string, string | null>;
  affectedPlaces: AffectedPlaces;
  /** Gate ids that fired, so entries can point at the findings that concern them. */
  firedGates?: readonly string[] | undefined;
  entryLimit?: number | undefined;
};

export function diffDatasets(input: DiffInput): DatasetDiff {
  const entries: DiffEntry[] = [];
  const fired = new Set(input.firedGates ?? []);
  const link = (...gates: string[]) => gates.filter((g) => fired.has(g));

  const from = new Map(input.fromUnits.map((u) => [identity(u), u] as const));
  const to = new Map(input.toUnits.map((u) => [identity(u), u] as const));

  for (const [key, unit] of to) {
    const before = from.get(key);
    if (!before) {
      entries.push({
        category: 'CREATED',
        key: `CREATED:${key}`,
        from: null,
        to: toIdentity(unit),
        detail: `${unit.fullName} appears in this dataset and not in the published one`,
        provenance: `${unit.source}@${unit.sourceVersion}`,
        validation: link('REQUIRED_FIELDS', 'CURRENT_COMMUNE_PARENT', 'UNSUPPORTED_TYPE'),
      });
      continue;
    }
    // One identity can differ in several ways at once; each is its own entry,
    // because a reviewer reading "renamed" should not have to notice that the
    // parent moved too.
    if (before.fullName !== unit.fullName) {
      entries.push({
        category: 'RENAMED',
        key: `RENAMED:${key}`,
        from: toIdentity(before),
        to: toIdentity(unit),
        detail: `${before.fullName} → ${unit.fullName}`,
        provenance: `${unit.source}@${unit.sourceVersion}`,
        validation: link('SOURCE_FORMATTING'),
      });
    }
    if (before.parentCode !== unit.parentCode) {
      entries.push({
        category: 'PARENT_CHANGED',
        key: `PARENT_CHANGED:${key}`,
        from: toIdentity(before),
        to: toIdentity(unit),
        detail: `parent ${before.parentCode ?? 'none'} → ${unit.parentCode ?? 'none'}`,
        provenance: `${unit.source}@${unit.sourceVersion}`,
        validation: link('CURRENT_COMMUNE_PARENT', 'HISTORICAL_HIERARCHY', 'PARENT_CYCLE'),
      });
    }
    if (before.status !== unit.status) {
      entries.push({
        category: 'STATUS_CHANGED',
        key: `STATUS_CHANGED:${key}`,
        from: toIdentity(before),
        to: toIdentity(unit),
        detail: `${before.status} → ${unit.status}`,
        provenance: `${unit.source}@${unit.sourceVersion}`,
        validation: link('DUPLICATE_ACTIVE_IDENTITY'),
      });
    }
    if (before.effectiveTo !== unit.effectiveTo) {
      entries.push({
        category: 'EFFECTIVE_PERIOD_CHANGED',
        key: `EFFECTIVE_PERIOD_CHANGED:${key}`,
        from: toIdentity(before),
        to: toIdentity(unit),
        detail: `effective_to ${before.effectiveTo ?? 'open'} → ${unit.effectiveTo ?? 'open'}`,
        provenance: `${unit.source}@${unit.sourceVersion}`,
        validation: link('EFFECTIVE_PERIOD_OVERLAP'),
      });
    }
  }

  for (const [key, unit] of from) {
    if (to.has(key)) continue;
    entries.push({
      category: 'DISSOLVED',
      key: `DISSOLVED:${key}`,
      from: toIdentity(unit),
      to: null,
      detail: `${unit.fullName} is in the published dataset and not in this one`,
      provenance: `${unit.source}@${unit.sourceVersion}`,
      validation: link('REMOVED_UNIT_UNEXPLAINED'),
    });
  }

  // Migrations are assertions the dataset makes, not shape differences — and
  // only the ones this dataset adds belong in a diff.
  const priorEdges = new Set(
    (input.fromChanges ?? []).map((c) => `${c.oldCode ?? ''}>${c.newCode ?? ''}:${c.changeType}`),
  );
  const priorQuarantine = new Set(
    (input.fromQuarantine ?? []).map(
      (q) => `${q.oldCode ?? ''}>${q.newCode ?? ''}:${q.classification}`,
    ),
  );
  const toByCode = new Map<string, ProvenancedUnit>();
  for (const unit of input.toUnits) if (!toByCode.has(unit.code)) toByCode.set(unit.code, unit);
  /*
   * Which sources already carried a reviewer override on the from-side. A new
   * override for one of them is a *changed* decision, not a first one, and that
   * distinction is the whole reason a second review round is reviewable.
   */
  const priorOverrideTargets = new Map<string, { target: string; decisionId: string }>();
  for (const change of input.fromChanges ?? []) {
    if (change.overrideDecisionId && change.oldCode && change.newCode) {
      priorOverrideTargets.set(change.oldCode, {
        target: change.newCode,
        decisionId: change.overrideDecisionId,
      });
    }
  }
  const fromByCode = new Map<string, ProvenancedUnit>();
  for (const unit of input.fromUnits)
    if (!fromByCode.has(unit.code)) fromByCode.set(unit.code, unit);

  for (const change of input.toChanges) {
    if (priorEdges.has(`${change.oldCode ?? ''}>${change.newCode ?? ''}:${change.changeType}`)) {
      continue;
    }
    const previousTarget = change.oldCode
      ? priorOverrideTargets.get(change.oldCode)?.target
      : undefined;
    const category: DiffCategory = change.overrideDecisionId
      ? previousTarget
        ? 'OVERRIDE_TARGET_CHANGED'
        : 'OVERRIDE_ACCEPTED'
      : change.changeType === 'MERGED'
        ? 'MERGED'
        : change.changeType === 'SPLIT'
          ? 'SPLIT'
          : change.changeType === 'REASSIGNED'
            ? 'REASSIGNED'
            : change.changeType === 'DISSOLVED'
              ? 'DISSOLVED'
              : change.changeType === 'CREATED'
                ? 'CREATED'
                : 'RENAMED';
    // Every canonical change becomes an entry, including the 3,165 whose
    // successor kept the predecessor's code. The shape comparison cannot stand
    // in for them: it keys on (code, effectiveFrom), so 00160@1900 → 00160@2025
    // reads there as a dissolution and a creation, which loses the assertion
    // the dataset actually makes — that one became the other. The keys cannot
    // collide, because a shape entry is keyed by identity and a migration entry
    // by its edge.
    entries.push({
      category,
      key: `${category}:${change.oldCode ?? ''}>${change.newCode ?? ''}`,
      from: toIdentity(change.oldCode ? toByCode.get(change.oldCode) : undefined),
      to: toIdentity(change.newCode ? toByCode.get(change.newCode) : undefined),
      detail: change.overrideDecisionId
        ? previousTarget
          ? `${change.oldCode ?? '?'}: reviewer target changed ${previousTarget} → ${change.newCode ?? '?'}`
          : `${change.oldCode ?? '?'} → ${change.newCode ?? '?'} accepted by a reviewer on ${change.effectiveDate}`
        : `${change.oldCode ?? '?'} → ${change.newCode ?? '?'} on ${change.effectiveDate}`,
      provenance: change.overrideDecisionId
        ? `GoGo reviewer decision ${change.overrideDecisionId}`
        : (change.legalReference ?? 'canonical change'),
      validation: change.overrideDecisionId
        ? link(
            'CHANGE_SOURCE_RESOLVES',
            'CHANGE_TARGET_RESOLVES',
            'CHANGE_HIERARCHY',
            'OVERRIDE_PROVENANCE',
            'OVERRIDE_CONFLICT',
            'OVERRIDE_REVISION_CONSISTENT',
          )
        : link(
            'CHANGE_SOURCE_RESOLVES',
            'CHANGE_TARGET_RESOLVES',
            'CHANGE_HIERARCHY',
            'MERGE_SPLIT_STRUCTURE',
          ),
    });
  }

  /*
   * An override the baseline carried and this version does not. The to-side
   * has nothing to iterate for it, so it is read off what the baseline had:
   * every source with a prior override and no override edge now.
   */
  const toOverrideSources = new Set(
    input.toChanges.filter((c) => c.overrideDecisionId && c.oldCode).map((c) => c.oldCode!),
  );
  for (const [oldCode, prior] of priorOverrideTargets) {
    if (toOverrideSources.has(oldCode)) continue;
    entries.push({
      category: 'OVERRIDE_RETRACTED',
      key: `OVERRIDE_RETRACTED:${oldCode}>${prior.target}`,
      from: toIdentity(fromByCode.get(oldCode)),
      to: toIdentity(fromByCode.get(prior.target)),
      detail: `${oldCode} → ${prior.target}: reviewer override retracted; the source is unresolved again`,
      provenance: `GoGo reviewer decision ${prior.decisionId} retracted`,
      validation: link('UNRESOLVED_CHANGES', 'OVERRIDE_CONFLICT'),
    });
  }

  for (const row of input.toQuarantine) {
    if (priorQuarantine.has(`${row.oldCode ?? ''}>${row.newCode ?? ''}:${row.classification}`)) {
      continue;
    }
    entries.push({
      category: 'UNRESOLVED',
      key: `UNRESOLVED:${row.oldCode ?? ''}>${row.newCode ?? ''}`,
      from: toIdentity(row.oldCode ? toByCode.get(row.oldCode) : undefined),
      to: toIdentity(row.newCode ? toByCode.get(row.newCode) : undefined),
      detail: `${row.classification}: ${row.oldCode ?? '?'} → ${row.newCode ?? '?'} awaits review`,
      provenance: 'advisory mapping source (quarantined)',
      validation: link('UNRESOLVED_CHANGES', 'QUARANTINE_EXCLUDED'),
    });
  }

  if (input.fromSources) {
    for (const key of Object.keys(input.toSources).sort()) {
      const before = input.fromSources[key] ?? null;
      const after = input.toSources[key] ?? null;
      if (before === after) continue;
      entries.push({
        category: 'SOURCE_DRIFT',
        key: `SOURCE_DRIFT:${key}`,
        from: null,
        to: null,
        detail: `${key}: ${before ?? 'none'} → ${after ?? 'none'}`,
        provenance: 'pinned manifest',
        validation: link('SNAPSHOT_CHECKSUM', 'COMBINED_VERSION_CONSISTENT'),
      });
    }
  }

  // Counts are over everything; the entry list is what gets capped.
  const countsByCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<
    DiffCategory,
    number
  >;
  for (const entry of entries) countsByCategory[entry.category] += 1;

  // Category order first so a reviewer reads created-then-renamed-then-merged
  // rather than an alphabetical shuffle; `key` breaks ties, and it is unique,
  // so the ordering is total and the same input always yields the same page.
  const rank = new Map(CATEGORIES.map((c, i) => [c, i] as const));
  entries.sort((a, b) =>
    a.category === b.category
      ? a.key.localeCompare(b.key)
      : rank.get(a.category)! - rank.get(b.category)!,
  );

  const limit = input.entryLimit ?? DIFF_ENTRY_LIMIT;
  return {
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    countsByCategory,
    entries: entries.slice(0, limit),
    entriesTruncated: entries.length > limit,
    entryLimit: limit,
    affectedPlaces: input.affectedPlaces,
  };
}

/** Codes a diff touches — the input to the bounded affected-place query. */
export function impactedCodes(entries: readonly DiffEntry[]): string[] {
  const codes = new Set<string>();
  for (const entry of entries) {
    if (entry.from?.code) codes.add(entry.from.code);
    if (entry.to?.code) codes.add(entry.to.code);
  }
  return [...codes].sort();
}
