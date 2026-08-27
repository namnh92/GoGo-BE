import { normalizeVietnamese } from '../../search/domain/normalize';
import { haversineMeters } from '../../suggestions/domain/hard-filter';

/**
 * PI-BE-005 / FR-INGEST-003/004 — candidate scoring for provider matches.
 * Weights come straight from the spec; thresholds are configurable so ops can
 * tighten them without a deploy.
 */

export const MATCH_WEIGHTS = {
  name: 0.5,
  district: 0.2,
  city: 0.15,
  category: 0.1,
  coordinate: 0.05,
} as const;

export const MATCH_THRESHOLDS = { auto: 0.9, confirm: 0.7 } as const;

export type MatchOutcome = 'RESOLVED_AUTOMATICALLY' | 'NEEDS_CONFIRMATION' | 'UNRESOLVED';

export type MatchReason =
  | 'EXACT_PROVIDER_ID'
  | 'EXACT_NAME_CITY'
  | 'MULTIPLE_BRANCHES'
  | 'DISTRICT_MISMATCH'
  | 'CITY_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'LOW_CONFIDENCE';

export type MatchInput = {
  name?: string | undefined;
  city?: string | undefined;
  district?: string | undefined;
  categoryKey?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
};

export type MatchTarget = {
  googlePlaceId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  primaryType?: string | undefined;
};

/** Token-set similarity over unaccented text — order-insensitive, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeVietnamese(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeVietnamese(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

function containsNormalized(haystack: string, needle?: string): boolean {
  if (!needle) return false;
  return normalizeVietnamese(haystack).includes(normalizeVietnamese(needle));
}

/** Rough Google type → GoGo category agreement check. */
const TYPE_TO_CATEGORY: Record<string, string[]> = {
  cafe: ['cafe', 'coffee_shop'],
  restaurant: ['restaurant', 'food'],
  bar: ['bar', 'night_club'],
  park: ['park', 'tourist_attraction'],
  cinema: ['movie_theater'],
  museum: ['museum'],
  lodging: ['lodging', 'hotel'],
};

export type ScoredMatch = {
  target: MatchTarget;
  confidence: number;
  reasons: MatchReason[];
};

export function scoreMatch(input: MatchInput, target: MatchTarget): ScoredMatch {
  const reasons: MatchReason[] = [];

  const nameScore = input.name ? nameSimilarity(input.name, target.name) : 0.5;

  const districtHit = containsNormalized(target.address, input.district);
  const districtScore = input.district ? (districtHit ? 1 : 0) : 0.5;
  if (input.district && !districtHit) reasons.push('DISTRICT_MISMATCH');

  const cityHit = containsNormalized(target.address, input.city);
  const cityScore = input.city ? (cityHit ? 1 : 0) : 0.5;
  if (input.city && !cityHit) reasons.push('CITY_MISMATCH');

  let categoryScore = 0.5;
  if (input.categoryKey && target.primaryType) {
    const expected = TYPE_TO_CATEGORY[input.categoryKey] ?? [];
    const hit = expected.includes(target.primaryType);
    categoryScore = hit ? 1 : 0;
    if (!hit) reasons.push('TYPE_MISMATCH');
  }

  let coordinateScore = 0.5;
  if (input.lat !== undefined && input.lng !== undefined) {
    const d = haversineMeters({ lat: input.lat, lng: input.lng }, target);
    coordinateScore = d <= 150 ? 1 : d <= 1000 ? 0.6 : d <= 5000 ? 0.2 : 0;
  }

  const confidence = round3(
    MATCH_WEIGHTS.name * nameScore +
      MATCH_WEIGHTS.district * districtScore +
      MATCH_WEIGHTS.city * cityScore +
      MATCH_WEIGHTS.category * categoryScore +
      MATCH_WEIGHTS.coordinate * coordinateScore,
  );

  if (nameScore >= 0.99 && cityHit) reasons.unshift('EXACT_NAME_CITY');
  if (confidence < MATCH_THRESHOLDS.confirm) reasons.push('LOW_CONFIDENCE');

  return { target, confidence, reasons };
}

export type MatchDecision = {
  outcome: MatchOutcome;
  best?: ScoredMatch;
  candidates: ScoredMatch[];
  reasons: MatchReason[];
};

/**
 * Ranks candidates and applies the thresholds. Two candidates within 0.05 of
 * each other are branches of the same brand — never auto-resolve those, a
 * human picks (FR-INGEST-004).
 */
export function decideMatch(
  input: MatchInput,
  targets: MatchTarget[],
  thresholds: { auto: number; confirm: number } = MATCH_THRESHOLDS,
): MatchDecision {
  if (targets.length === 0) {
    return { outcome: 'UNRESOLVED', candidates: [], reasons: ['LOW_CONFIDENCE'] };
  }
  const scored = targets
    .map((t) => scoreMatch(input, t))
    .sort(
      (a, b) =>
        b.confidence - a.confidence || (a.target.googlePlaceId < b.target.googlePlaceId ? -1 : 1),
    );
  const best = scored[0]!;
  const runnerUp = scored[1];
  const ambiguous = runnerUp !== undefined && best.confidence - runnerUp.confidence < 0.05;
  const reasons = [...best.reasons];
  if (ambiguous) reasons.unshift('MULTIPLE_BRANCHES');

  let outcome: MatchOutcome;
  if (best.confidence >= thresholds.auto && !ambiguous) outcome = 'RESOLVED_AUTOMATICALLY';
  else if (best.confidence >= thresholds.confirm) outcome = 'NEEDS_CONFIRMATION';
  else outcome = 'UNRESOLVED';

  return { outcome, best, candidates: scored.slice(0, 5), reasons };
}

/** A provider id lifted straight from the URL always wins. */
export function exactProviderMatch(target: MatchTarget): MatchDecision {
  return {
    outcome: 'RESOLVED_AUTOMATICALLY',
    best: { target, confidence: 1, reasons: ['EXACT_PROVIDER_ID'] },
    candidates: [{ target, confidence: 1, reasons: ['EXACT_PROVIDER_ID'] }],
    reasons: ['EXACT_PROVIDER_ID'],
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
