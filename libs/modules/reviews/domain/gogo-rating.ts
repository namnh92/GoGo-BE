/**
 * GoGo-BE#217 (ADR-0028) — the GoGo community rating Place Detail carries.
 *
 * The population is every review of the place a moderator published
 * (`PUBLIC_REVIEW_STATUS`), weighted equally: a textless review counts, a
 * review kept from a deleted account counts (ADR-0023), and one author with
 * several reviews counts several times — the count is reviews, not people, and
 * this cutoff is no anti-abuse guarantee. Check-ins, plan reviews and provider
 * ratings are never part of it, and it never merges with the provider
 * `rating`/`ratingCount` (core rule 14).
 *
 * Below the threshold the count still goes out (it is a fact, and the client
 * says "not enough reviews yet" in words next to it) but the score does not:
 * a mean of three reviews is not a rating worth a star.
 *
 * Five is the SA decision recorded in ADR-0028, not a statistical confidence
 * guarantee. One constant, no remote configuration, no client choice.
 */
export const GOGO_RATING_MIN_SAMPLE = 5;

/** The 1–5 scale the `reviews_rating_range` constraint stores. */
export const GOGO_RATING_SCALE = { min: 1, max: 5 } as const;

export type GogoRatingFacts = {
  /** Absent below `GOGO_RATING_MIN_SAMPLE`; never `null`, never 0. */
  gogoRating?: number;
  gogoRatingCount: number;
};

export type GogoRatingOutcome = 'available' | 'insufficient';

/**
 * `count` and `mean` come from one aggregate in one statement, so they always
 * describe the same population. `mean` is already rounded to one decimal by
 * PostgreSQL `round(numeric, 1)` — half away from zero, so 4.25 → 4.3 — and
 * arrives as the string `pg` returns for `numeric`.
 */
export function toGogoRating(
  count: number | undefined,
  mean: string | number | null,
): GogoRatingFacts {
  // A missing count is a broken read, never "no reviews" — it must not
  // quietly become 0 and render as an insufficient sample.
  if (count === undefined || !Number.isInteger(count) || count < 0) {
    throw new Error(`GoGo rating count must be a non-negative integer, got ${count}`);
  }
  if (count < GOGO_RATING_MIN_SAMPLE) return { gogoRatingCount: count };
  const score = Number(mean);
  if (mean === null || !Number.isFinite(score)) {
    throw new Error('GoGo rating mean missing for a population above the threshold');
  }
  return { gogoRating: score, gogoRatingCount: count };
}

export function gogoRatingOutcome(facts: GogoRatingFacts): GogoRatingOutcome {
  return facts.gogoRating === undefined ? 'insufficient' : 'available';
}
