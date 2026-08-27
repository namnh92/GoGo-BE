import { budgetPerPerson } from '../../rooms/domain/budget';
import { haversineMeters } from './hard-filter';
import type { Candidate, RoomSnapshot, ScoredCandidate, ScoringWeights } from './types';

/**
 * SG-004 — deterministic explainable scoring. Same snapshot + candidates +
 * weights version ⇒ identical output (no clock, no randomness).
 */

function memberPreferenceScore(
  member: RoomSnapshot['memberPreferences'][number],
  candidate: Candidate,
): number {
  let hit = 0;
  let total = 0;
  for (const [kind, keys] of Object.entries(member.selections)) {
    const candidateKeys = candidate.taxonomyKeys[kind] ?? [];
    for (const key of keys) {
      const weight = member.weights?.[`${kind}:${key}`] ?? 1;
      total += weight;
      if (candidateKeys.includes(key)) hit += weight;
    }
  }
  return total === 0 ? 0.5 : hit / total;
}

export function scoreCandidate(
  candidate: Candidate,
  snapshot: RoomSnapshot,
  weights: ScoringWeights,
): ScoredCandidate {
  const memberSatisfaction: Record<string, number> = {};
  for (const member of snapshot.memberPreferences) {
    memberSatisfaction[member.memberId] = memberPreferenceScore(member, candidate);
  }
  const satValues = Object.values(memberSatisfaction);
  const preference =
    satValues.length > 0 ? satValues.reduce((a, b) => a + b, 0) / satValues.length : 0.5;
  // Consensus: how many members get at least a partial match (FR-SUG-003).
  const consensus =
    satValues.length > 0 ? satValues.filter((s) => s > 0.2).length / satValues.length : 0.5;

  const distanceM = snapshot.origin
    ? haversineMeters(snapshot.origin, { lat: candidate.lat, lng: candidate.lng })
    : null;
  const distance = distanceM === null ? 0.5 : 1 / (1 + distanceM / 2000);

  const perPerson = budgetPerPerson(
    {
      mode: snapshot.budget.mode,
      amount: snapshot.budget.amount,
      currency: snapshot.budget.currency,
    },
    snapshot.participantCount,
  );
  let budgetFit = 0.5;
  if (candidate.pricePerPersonMax !== null && perPerson > 0) {
    const mid = ((candidate.pricePerPersonMin ?? 0) + candidate.pricePerPersonMax) / 2;
    budgetFit = Math.max(0, Math.min(1, 1 - mid / perPerson / 1.5));
  } else if (candidate.pricePerPersonMax === null) {
    budgetFit = 0.4; // unknown price — uncertainty, not free
  }

  const quality =
    candidate.rating === null
      ? 0.4
      : (candidate.rating / 5) * Math.min(Math.log1p(candidate.ratingCount) / Math.log(1000), 1);

  const freshness = candidate.freshnessDays === null ? 0 : Math.exp(-candidate.freshnessDays / 60);

  const audience = snapshot.type === 'couple' ? 'couple' : 'group';
  const suitabilityFactor = candidate.suitability?.[audience] ?? 0.6;

  const seed = candidate.isSeed ? 1 : 0;

  const components = {
    preference: round6(preference),
    consensus: round6(consensus),
    distance: round6(distance),
    budget: round6(budgetFit),
    quality: round6(quality),
    freshness: round6(freshness),
    suitability: round6(suitabilityFactor),
    seedBoost: seed,
  };

  const raw =
    weights.preference * preference +
    weights.consensus * consensus +
    weights.distance * distance +
    weights.budget * budgetFit +
    weights.quality * quality +
    weights.freshness * freshness +
    weights.seedBoost * seed;
  // Suitability multiplies: a place unsuited to the audience never outranks
  // a suited one purely on logistics.
  const score = round6(raw * (0.5 + 0.5 * suitabilityFactor));

  const reasonCodes: string[] = [];
  if (preference >= 0.5) reasonCodes.push('MATCHES_PREFERENCES');
  if (consensus >= 0.99 && satValues.length > 1) reasonCodes.push('LIKED_BY_EVERYONE');
  if (budgetFit >= 0.5) reasonCodes.push('FITS_BUDGET');
  if (distanceM !== null && distanceM < 2000) reasonCodes.push('NEAR_ORIGIN');
  if ((candidate.rating ?? 0) >= 4.3 && candidate.ratingCount >= 100) {
    reasonCodes.push('HIGHLY_RATED');
  }
  if (candidate.isSeed) reasonCodes.push('HOST_SUGGESTED');

  return { candidate, score, components, reasonCodes, memberSatisfaction };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
