import type { ScoredCandidate } from './types';

/**
 * SG-005 — group fairness, diversity, deterministic tie-break.
 *
 * Selection is iterative (MMR-style): at each step pick the candidate with the
 * best adjusted score = base − diversityPenalty + fairnessBoost, where
 * fairness boosts candidates that satisfy the currently least-satisfied
 * member, so a minority is never permanently ignored (FR-SUG-003).
 */
export function rankWithFairness(
  scored: ScoredCandidate[],
  options: { topK: number; diversityPenalty?: number; fairnessBoost?: number },
): ScoredCandidate[] {
  const diversityPenalty = options.diversityPenalty ?? 0.08;
  const fairnessBoost = options.fairnessBoost ?? 0.1;

  const pool = [...scored].sort(tieBreak);
  const selected: ScoredCandidate[] = [];
  const pickedCategories = new Map<string, number>();
  const memberIds = new Set(pool.flatMap((s) => Object.keys(s.memberSatisfaction)));
  const cumulative: Record<string, number> = {};
  for (const id of memberIds) cumulative[id] = 0;

  while (selected.length < options.topK && pool.length > 0) {
    // Least-satisfied member so far drives the fairness boost this round.
    let minMember: string | null = null;
    let minValue = Infinity;
    for (const id of memberIds) {
      if ((cumulative[id] ?? 0) < minValue) {
        minValue = cumulative[id] ?? 0;
        minMember = id;
      }
    }

    let bestIdx = 0;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i]!;
      const categories = s.candidate.taxonomyKeys['category'] ?? [];
      const repeats = categories.reduce((acc, c) => acc + (pickedCategories.get(c) ?? 0), 0);
      const fairness = minMember ? (s.memberSatisfaction[minMember] ?? 0) * fairnessBoost : 0;
      const adjusted = s.score - repeats * diversityPenalty + fairness;
      if (adjusted > bestAdjusted + 1e-12) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }

    const picked = pool.splice(bestIdx, 1)[0]!;
    selected.push(picked);
    for (const c of picked.candidate.taxonomyKeys['category'] ?? []) {
      pickedCategories.set(c, (pickedCategories.get(c) ?? 0) + 1);
    }
    for (const id of memberIds) {
      cumulative[id] = (cumulative[id] ?? 0) + (picked.memberSatisfaction[id] ?? 0);
    }
  }
  return selected;
}

/** Deterministic tie-break: score → rating → ratingCount → placeId (FR-SUG-004). */
export function tieBreak(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const ra = a.candidate.rating ?? 0;
  const rb = b.candidate.rating ?? 0;
  if (rb !== ra) return rb - ra;
  if (b.candidate.ratingCount !== a.candidate.ratingCount) {
    return b.candidate.ratingCount - a.candidate.ratingCount;
  }
  return a.candidate.placeId < b.candidate.placeId ? -1 : 1;
}
