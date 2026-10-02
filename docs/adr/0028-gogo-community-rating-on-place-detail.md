# ADR-0028: GoGo community rating on Place Detail

- **Status:** accepted — shape decided by SA review (Astra) on 2026-10-02 under the owner's delegation on GoGo-BE#217; contract change pending CODEOWNER approval
- **Date:** 2026-10-02
- **Deciders:** SA review (shape), backend (implementation), CODEOWNER (OpenAPI)

## Context

`GET /v1/places/{id}` carries only the provider rating (`rating`, `ratingCount`,
attributed through `sources`). `GOGO_MOBILE_FIGMA_UI_IMPROVEMENT_SPEC.md` §6
asks Place Detail to show the provider rating and a GoGo community rating side
by side, never merged and never invented, and core rule 14 says the same: two
sources never become one star, both carry their sample size, and below the
community threshold the client says so in words. With no aggregate in the
contract, Mobile (APP-021, GoGo-MobileApp#74) hard-codes "Chưa đủ đánh giá từ
cộng đồng GoGo".

The issue left five questions open (threshold, field shape, scale, source,
below-threshold behaviour). The owner delegated them to SA review on
2026-10-02; this record is that decision.

## Options considered

1. **Threshold** — a backend constant (chosen); remote configuration; a
   client-chosen threshold; reusing a provider-import threshold. Configuration
   machinery buys nothing until there is evidence the number should move.
2. **Shape** — flat `gogoRating?` + `gogoRatingCount` (chosen); a
   `RatingSummary { source, score, scale, reviewCount, updatedAt }` object per
   FEATURE_IMPROVEMENT_SPEC §27.4, which would also mean migrating the provider
   fields; duplicate aliases. The flat pair is additive and closes the named
   consumer gap.
3. **Scale** — 1–5, the scale `reviews_rating_range` stores (chosen); a /10
   conversion; Bayesian adjustment; helpful-vote weighting.
4. **Source** — every `published` review of the place, equally weighted
   (chosen); also check-ins (`stop_checkins.rating`); plan reviews; distinct
   authors only; the three-review preview.
5. **Freshness** — one aggregate computed per read inside the Place Detail
   statement, served `no-store` (chosen); a persisted total; a Redis/CDN cache;
   an asynchronous projection.

## Decision

- **Threshold: 5 published reviews, inclusive**, one constant
  (`GOGO_RATING_MIN_SAMPLE`, `libs/modules/reviews/domain/gogo-rating.ts`),
  stated in OpenAPI. Five is an SA decision, not a specified value or a
  statistical confidence guarantee.
- **Fields:** `gogoRatingCount: integer ≥ 0` is always present on a 200,
  including 0. `gogoRating: number` in [1, 5] is **omitted** — not `null`,
  not 0 — when the count is below 5, and present at 5 or more. The provider
  `rating`/`ratingCount` and their attribution are unchanged.
- **Score:** arithmetic mean, rounded once to one decimal by PostgreSQL
  `round(numeric, 1)` (half away from zero: 4.25 → 4.3), serialized as a JSON
  number.
- **Population:** every `reviews` row with `place_id` = the place and
  `status = 'published'` (`PUBLIC_REVIEW_STATUS`), weighted equally — textless
  reviews and reviews retained from deleted accounts (ADR-0023) included.
  Pending, rejected, removed and hidden reviews, plan reviews, check-ins and
  provider reviews never count. An edit that returns a review to `pending`
  removes it at once. The count is reviews, not people.
- **Computation:** one correlated aggregate (count + mean) in the existing
  Place Detail statement, through `reviews_place_idx (place_id, status)`, so
  score and count describe one snapshot. The response is
  `Cache-Control: no-store`. A failed read is an error, never "not enough
  reviews". No `updatedAt` is invented: the place's freshness timestamps do
  not describe this aggregate.
- **Telemetry:** `place_gogo_rating_total{outcome}` with
  `available | insufficient | error`, no place or user identifier; statement
  duration stays visible through `provider_request_duration_seconds`.

**Acceptance wording, revised.** The issue's "below the threshold, omit
instead of returning 0" is read in favour of core rule 14: below the
threshold the **score** is omitted and the **count** is still returned
(including 0), so the client can say in words that there are not enough GoGo
reviews yet, next to the real sample size.

## Consequences

- Mobile can render "GoGo ★ x,y (n)" at n ≥ 5 and "Chưa đủ đánh giá từ cộng
  đồng GoGo" with n below it, from contract facts and its own i18n.
- One author can hold several reviews, so the threshold is no anti-abuse
  guarantee; abuse handling stays with moderation.
- Read cost grows with a place's published-review population. Optimise only on
  measured evidence, and only with an explicit design for moderation freshness
  (a persisted total would have to follow every moderation path).
- The CMS place detail keeps its own unthresholded two-decimal aggregate; it is
  an editorial view with a different purpose and its contract is unchanged.
- No new Google content is persisted (ADR-0020's persistence exception is not
  used or widened here).
- No event and no migration.

## Migration & rollback

Additive contract change: `1.0.0-alpha.61`. Deploy the backend before the
Mobile client that reads the fields (APP-021). Rollback restores the previous
API implementation; clients must tolerate both fields being absent, which the
generated type already allows for `gogoRating` and which Mobile's current
hard-coded fallback already does for both.
