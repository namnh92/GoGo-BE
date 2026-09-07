import {
  applyAutomaticTransition,
  isReviewerOwned,
  type MappingMethod,
  type MappingStatus,
} from './mapping-status';

/**
 * ADM-006 (#459) / ADR-0019 §7 and §10 — the Administrative Address Resolver's
 * decision, as a pure function of the evidence gathered for one place.
 *
 * Two rules generate almost all of the behaviour below.
 *
 * **Never choose arbitrarily.** Two pieces of deterministic evidence that
 * disagree do not get averaged, ranked or tie-broken; they produce
 * `NEEDS_REVIEW` with both candidates attached. The single most damaging thing
 * this code could do is pick the higher-priority one and look confident: a
 * wrong commune code is indistinguishable from a right one downstream, and the
 * disagreement is the only signal that anything is wrong.
 *
 * **A code is not an identity.** 2,212 of the 3,321 current commune codes named
 * a different unit before 2025-07-01, so every judgement here is made against
 * one named dataset version, and the version travels with the answer.
 *
 * Google administrative components appear at no level of the precedence. That
 * is ADR-0019 §10 and GoGo-BE#464: intersecting stored geometry with GoGo's
 * pinned MIT boundaries is a GoGo-generated fact; fetching Google's address
 * components to do the same job is not, whatever is persisted afterwards.
 */

/** Lower is stronger. The order is ADR-0019 §10's, and it is the only order. */
export const PRECEDENCE: Readonly<Record<MappingMethod, number>> = {
  /** A reviewer's own decision, already recorded. Nothing outranks a person. */
  editor: 1,
  trusted_code: 2,
  boundary_point_in_polygon: 3,
  components_with_coordinates: 4,
  structured_components: 5,
  exact_name: 6,
  change_mapping: 7,
  /** Suggestion only. Cannot resolve anything, at any strength. */
  fuzzy_suggestion: 99,
};

/** Closed vocabulary: these become metric labels, so free text is not allowed. */
export type ResolverReason =
  | 'NO_EVIDENCE'
  | 'EVIDENCE_CONFLICT'
  | 'INVALID_HIERARCHY'
  | 'PROVINCE_ONLY'
  | 'MULTIPLE_BOUNDARY_MATCHES'
  | 'BOUNDARY_EDGE'
  | 'NO_BOUNDARY_MATCH'
  | 'INVALID_GEOMETRY'
  | 'MISSING_GEOMETRY'
  | 'NO_BOUNDARY_VERSION'
  | 'AMBIGUOUS_NAME'
  | 'DIVIDED_CHANGE'
  | 'MULTIPLE_SUCCESSORS'
  | 'REVIEWER_OWNED';

export type Evidence = {
  method: MappingMethod;
  provinceCode: string | null;
  communeCode: string | null;
  legacyDistrictCode?: string | null;
  /**
   * Whether the commune really belongs to the province **in this dataset
   * version**. Checked by the caller against the units table, because a pair
   * that looks well-formed can still be a pair from two different releases.
   */
  hierarchyValid: boolean;
  /** False for anything that may only ever be offered to a person. */
  deterministic: boolean;
  /**
   * Boundary evidence only: the point lies on this polygon's own edge. A unique
   * match can still be an edge match — a coastline, or a border with a polygon
   * the release does not carry — and an edge is precisely where containment
   * stops being definitional.
   */
  onEdge?: boolean;
  /** Human-readable, for the audit row and the review screen. */
  detail: string;
};

export type Candidate = {
  method: MappingMethod;
  provinceCode: string | null;
  communeCode: string | null;
  detail: string;
};

export type CurrentMapping = {
  status: MappingStatus;
  provinceCode: string | null;
  communeCode: string | null;
  legacyDistrictCode: string | null;
  method: MappingMethod | null;
  datasetVersion: string | null;
  boundaryVersion: string | null;
};

export type AdjudicationInput = {
  placeId: string;
  datasetVersion: string;
  boundaryVersion: string | null;
  current: CurrentMapping;
  evidence: readonly Evidence[];
  /** Why a provider could not produce evidence. Ordered by the provider list. */
  reasons: readonly ResolverReason[];
  allowRematchRejected?: boolean;
};

export type Resolution = {
  placeId: string;
  status: MappingStatus;
  provinceCode: string | null;
  communeCode: string | null;
  legacyDistrictCode: string | null;
  method: MappingMethod | null;
  confidence: number | null;
  datasetVersion: string;
  /** Recorded only when boundary evidence actually decided the answer. */
  boundaryVersion: string | null;
  evidence: Evidence[];
  candidates: Candidate[];
  reason: ResolverReason | null;
  /** False when the resolver refused to touch a reviewer-owned row. */
  writable: boolean;
  /** True when the proposal differs from what is stored. */
  changed: boolean;
};

/**
 * The whole decision. Deterministic in its input: the same evidence produces
 * the same resolution, which is what makes a re-run a no-op rather than a
 * churn of audit rows.
 */
export function adjudicate(input: AdjudicationInput): Resolution {
  const base = {
    placeId: input.placeId,
    datasetVersion: input.datasetVersion,
    evidence: [...input.evidence],
  };

  // A person's decision is the top of the precedence, so it is answered before
  // any evidence is weighed rather than after — weighing it first and then
  // discarding the result is how a "just this once" override gets written.
  if (isReviewerOwned(input.current.status) && !canRematch(input)) {
    return {
      ...base,
      status: input.current.status,
      provinceCode: input.current.provinceCode,
      communeCode: input.current.communeCode,
      legacyDistrictCode: input.current.legacyDistrictCode,
      method: input.current.method,
      confidence: null,
      boundaryVersion: input.current.boundaryVersion,
      candidates: input.evidence.map(toCandidate),
      reason: 'REVIEWER_OWNED',
      writable: false,
      changed: false,
    };
  }

  const usable = input.evidence.filter((e) => e.deterministic && e.hierarchyValid);
  const complete = usable.filter((e) => e.communeCode !== null && e.provinceCode !== null);
  const pairs = new Map<string, Evidence[]>();
  for (const e of complete) {
    const key = `${e.provinceCode}/${e.communeCode}`;
    pairs.set(key, [...(pairs.get(key) ?? []), e]);
  }

  if (pairs.size === 1) {
    // Every deterministic source that spoke agrees. Attribute the answer to the
    // strongest one that produced it, not to the last one evaluated.
    const agreeing = [...pairs.values()][0]!.slice().sort(byPrecedence);
    const winner = agreeing[0]!;
    return finish(input, base, {
      status: 'AUTO_MATCHED',
      provinceCode: winner.provinceCode,
      communeCode: winner.communeCode,
      legacyDistrictCode: legacyFrom(input.evidence),
      method: winner.method,
      confidence: definitionalConfidence(winner, input.evidence),
      boundaryVersion: usesBoundary(agreeing) ? input.boundaryVersion : null,
      candidates: [],
      reason: null,
    });
  }

  if (pairs.size > 1) {
    return finish(input, base, {
      status: 'NEEDS_REVIEW',
      ...keepCurrentCodes(input.current),
      method: null,
      confidence: null,
      boundaryVersion: null,
      candidates: complete.map(toCandidate),
      reason: 'EVIDENCE_CONFLICT',
    });
  }

  // No complete pair. Rank what is left, worst news first.
  const invalid = input.evidence.filter((e) => e.deterministic && !e.hierarchyValid);
  const provinceOnly = usable.filter((e) => e.provinceCode !== null && e.communeCode === null);
  const suggestions = input.evidence.filter((e) => !e.deterministic);

  if (invalid.length > 0) {
    return finish(input, base, {
      status: 'NEEDS_REVIEW',
      ...keepCurrentCodes(input.current),
      method: null,
      confidence: null,
      boundaryVersion: null,
      candidates: invalid.map(toCandidate),
      reason: 'INVALID_HIERARCHY',
    });
  }

  if (provinceOnly.length > 0) {
    // A province alone is not an address. It is recorded as a candidate so the
    // reviewer starts from the right province instead of from nothing.
    return finish(input, base, {
      status: 'NEEDS_REVIEW',
      ...keepCurrentCodes(input.current),
      method: null,
      confidence: null,
      boundaryVersion: null,
      candidates: provinceOnly.map(toCandidate),
      reason: 'PROVINCE_ONLY',
    });
  }

  if (suggestions.length > 0 || input.reasons.length > 0) {
    const reason = firstReason(input.reasons) ?? 'AMBIGUOUS_NAME';
    // A reason that means "there is simply nothing here" is not a review task.
    const status: MappingStatus =
      suggestions.length === 0 && isEmptyEvidenceReason(reason) ? 'UNMAPPED' : 'NEEDS_REVIEW';
    return finish(input, base, {
      status,
      ...keepCurrentCodes(input.current),
      method: null,
      confidence: null,
      boundaryVersion: null,
      candidates: suggestions.map(toCandidate),
      reason,
    });
  }

  return finish(input, base, {
    status: 'UNMAPPED',
    provinceCode: null,
    communeCode: null,
    legacyDistrictCode: null,
    method: null,
    confidence: null,
    boundaryVersion: null,
    candidates: [],
    reason: 'NO_EVIDENCE',
  });
}

/**
 * Reasons that mean the evidence was absent rather than contradictory. These
 * leave a place `UNMAPPED`: putting "we know nothing about this place" in a
 * human review queue buries the cases where a person could actually help.
 */
function isEmptyEvidenceReason(reason: ResolverReason): boolean {
  return (
    reason === 'MISSING_GEOMETRY' ||
    reason === 'INVALID_GEOMETRY' ||
    reason === 'NO_BOUNDARY_MATCH' ||
    reason === 'NO_BOUNDARY_VERSION' ||
    reason === 'NO_EVIDENCE'
  );
}

/** Order matters: the first listed reason a provider gave is the one reported. */
function firstReason(reasons: readonly ResolverReason[]): ResolverReason | null {
  const ranked: ResolverReason[] = [
    'MULTIPLE_BOUNDARY_MATCHES',
    'BOUNDARY_EDGE',
    'DIVIDED_CHANGE',
    'MULTIPLE_SUCCESSORS',
    'AMBIGUOUS_NAME',
    'INVALID_HIERARCHY',
    'PROVINCE_ONLY',
    'NO_BOUNDARY_MATCH',
    'INVALID_GEOMETRY',
    'MISSING_GEOMETRY',
    'NO_BOUNDARY_VERSION',
    'NO_EVIDENCE',
  ];
  for (const candidate of ranked) if (reasons.includes(candidate)) return candidate;
  return reasons[0] ?? null;
}

function canRematch(input: AdjudicationInput): boolean {
  return input.current.status === 'REJECTED' && input.allowRematchRejected === true;
}

/** A refused proposal leaves the stored codes alone rather than blanking them. */
function keepCurrentCodes(current: CurrentMapping): {
  provinceCode: string | null;
  communeCode: string | null;
  legacyDistrictCode: string | null;
} {
  return {
    provinceCode: current.provinceCode,
    communeCode: current.communeCode,
    legacyDistrictCode: current.legacyDistrictCode,
  };
}

/**
 * `legacy_district_code` is never derived from geometry — there are no legacy
 * district polygons, at any release — so it is carried only from evidence that
 * asserted it outright.
 */
function legacyFrom(evidence: readonly Evidence[]): string | null {
  const asserted = evidence
    .filter((e) => e.deterministic && e.legacyDistrictCode)
    .sort(byPrecedence);
  const distinct = new Set(asserted.map((e) => e.legacyDistrictCode));
  // Two sources naming different legacy districts is exactly the case where
  // guessing would invent history. Neither wins.
  return distinct.size === 1 ? (asserted[0]!.legacyDistrictCode ?? null) : null;
}

/**
 * `1` only where the evidence *defines* the answer; `null` everywhere else.
 *
 * Deterministic selection and calibrated certainty are different claims, and
 * conflating them is how a number nobody measured ends up steering a decision
 * downstream. Two kinds of evidence are definitional: an official code checked
 * against this exact dataset version, and a point that falls strictly inside
 * exactly one commune polygon. Both answer "which unit is this" by construction.
 *
 * Everything else is *evidence*, however good. A name that matched exactly under
 * a unique parent is a strong argument, not a definition — Vietnamese unit names
 * repeat, and the match is only as unique as the parent narrowing it. A unique
 * canonical successor is GoGo's own record of a legal change, which is why it is
 * trusted enough to `AUTO_MATCH`, and still not a measurement of this place. So
 * those results are deterministic with a null confidence, and their certainty is
 * carried by `method`, `evidence`, `status` and `datasetVersion` — four things a
 * reviewer can check — rather than by one number that cannot be checked at all.
 *
 * Any contradiction voids it. If a second deterministic source named a different
 * commune, this answer is not conflict-free even when the contradiction was
 * itself invalid, and 1.00 would be asserting more than the evidence supports.
 */
export function definitionalConfidence(winner: Evidence, all: readonly Evidence[]): number | null {
  if (winner.provinceCode === null || winner.communeCode === null) return null;

  const contradicted = all.some(
    (e) =>
      e.deterministic &&
      e.communeCode !== null &&
      (e.communeCode !== winner.communeCode || e.provinceCode !== winner.provinceCode),
  );
  if (contradicted) return null;

  if (winner.method === 'trusted_code') return 1;
  if (winner.method === 'boundary_point_in_polygon' && winner.onEdge !== true) return 1;
  return null;
}

function usesBoundary(evidence: readonly Evidence[]): boolean {
  return evidence.some((e) => e.method === 'boundary_point_in_polygon');
}

function byPrecedence(a: Evidence, b: Evidence): number {
  return PRECEDENCE[a.method] - PRECEDENCE[b.method];
}

function toCandidate(e: Evidence): Candidate {
  return {
    method: e.method,
    provinceCode: e.provinceCode,
    communeCode: e.communeCode,
    detail: e.detail,
  };
}

/** Applies the transition matrix and works out whether anything actually moved. */
function finish(
  input: AdjudicationInput,
  base: Pick<Resolution, 'placeId' | 'datasetVersion' | 'evidence'>,
  proposal: Omit<Resolution, 'placeId' | 'datasetVersion' | 'evidence' | 'writable' | 'changed'>,
): Resolution {
  const decision = applyAutomaticTransition(input.current.status, proposal.status, {
    ...(input.allowRematchRejected === undefined
      ? {}
      : { allowRematchRejected: input.allowRematchRejected }),
  });
  if (!decision.allowed) {
    return {
      ...base,
      ...proposal,
      status: decision.status,
      ...keepCurrentCodes(input.current),
      method: input.current.method,
      confidence: null,
      boundaryVersion: input.current.boundaryVersion,
      reason: 'REVIEWER_OWNED',
      writable: false,
      changed: false,
    };
  }
  // `changed` must mean "the stored row would differ", which is not the same as
  // "the answer is new". An `UNMAPPED` result claims nothing, so it stamps no
  // version and no method — and a place that is already `UNMAPPED` is therefore
  // unchanged by it, however recent the dataset is. Comparing against the
  // dataset version regardless made a dry run promise a write that the write
  // path then correctly declined to make.
  const claims = proposal.status !== 'UNMAPPED';
  const changed =
    proposal.status !== input.current.status ||
    proposal.provinceCode !== input.current.provinceCode ||
    proposal.communeCode !== input.current.communeCode ||
    proposal.legacyDistrictCode !== input.current.legacyDistrictCode ||
    (claims ? proposal.method : null) !== input.current.method ||
    (claims ? input.datasetVersion : null) !== input.current.datasetVersion ||
    (claims ? proposal.boundaryVersion : null) !== input.current.boundaryVersion;
  return { ...base, ...proposal, writable: true, changed };
}
