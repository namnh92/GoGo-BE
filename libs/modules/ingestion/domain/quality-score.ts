/**
 * PI-BE-008 / FR-INGEST-006 — Bayesian shrinkage of provider ratings.
 * Raw rating/count stay untouched in the provider source row; this only
 * derives a comparable 0..100 score.
 */

export const MIN_CONFIDENCE_COUNT = 50;

export type RatingPriors = {
  /** category+city mean when the corpus has enough samples. */
  categoryCity?: number | undefined;
  city?: number | undefined;
  global: number;
};

export function priorFor(priors: RatingPriors): number {
  return priors.categoryCity ?? priors.city ?? priors.global;
}

/** adjusted = (n/(n+m))·rating + (m/(n+m))·prior, m = MIN_CONFIDENCE_COUNT. */
export function adjustedRating(
  rating: number | null,
  reviewCount: number | null,
  priors: RatingPriors,
  minimumConfidenceCount = MIN_CONFIDENCE_COUNT,
): number {
  const prior = priorFor(priors);
  if (rating === null || reviewCount === null || reviewCount <= 0) return prior;
  const n = reviewCount;
  const m = minimumConfidenceCount;
  return (n / (n + m)) * rating + (m / (n + m)) * prior;
}

/** 0..100 provider score derived from the shrunk rating. */
export function providerScore(
  rating: number | null,
  reviewCount: number | null,
  priors: RatingPriors,
): number {
  return round2(adjustedRating(rating, reviewCount, priors) * 20);
}

/**
 * Composite once GoGo has its own reviews. GoGo weight is capped at 0.7 so a
 * handful of in-house reviews never fully overrides provider signal.
 */
export function compositeQualityScore(input: {
  gogoScore: number | null;
  gogoReviewCount: number;
  providerScore: number;
}): { composite: number; gogoWeight: number } {
  const gogoWeight =
    input.gogoScore === null
      ? 0
      : Math.min(0.7, input.gogoReviewCount / (input.gogoReviewCount + 20));
  const composite = (input.gogoScore ?? 0) * gogoWeight + input.providerScore * (1 - gogoWeight);
  return { composite: round2(composite), gogoWeight: round2(gogoWeight) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
