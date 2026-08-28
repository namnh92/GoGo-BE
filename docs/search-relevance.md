# Search Relevance Spec (SE-001)

Scope: place search MVP on PostgreSQL (`unaccent` + FTS + `pg_trgm` + PostGIS)
per SRS §11. External engine only when SE-009 thresholds trigger.

## Normalization rules (SE-002)

Both sides of the comparison run through the same pipeline:

| Step       | SQL side                         | TS side (`normalizeVietnamese`) |
| ---------- | -------------------------------- | ------------------------------- |
| Unicode    | `f_unaccent` (immutable wrapper) | NFD + strip combining marks     |
| đ/Đ        | handled by unaccent              | explicit `đ→d`                  |
| Case       | `lower()`                        | `toLowerCase()`                 |
| Whitespace | trigger stores collapsed         | collapse + trim                 |

Query text is additionally stripped of tsquery metacharacters before
`websearch_to_tsquery('simple', …)`.

## Retrieval

`search_tsv` (generated column: name×2 weights A, description C, area B) OR
trigram `similarity(name_normalized, q) > 0.2` — the OR arm supplies typo
tolerance (FR-SEARCH-001). Hard filters (status, geo radius, categories,
open-at incl. overnight ranges, per-person price bounds, dietary/accessibility
ALL-of, suitability ≥ 0.5, lodging opt-in) are SQL predicates, never post-hoc.

## Ranking (SE-004)

`score = w_text·min(ts_rank+similarity,1) + w_distance·1/(1+km) +
w_quality·(rating/5·log-scaled count) + w_freshness·e^(−days/60) +
w_curated·1/(1+rank)`

Weights come from the active `ranking_configs['search.ranking']` row
(versioned, bounded, CMS-approved — FR-CMS-007); defaults
`0.4/0.2/0.2/0.1/0.1`. Response meta reports `weightsVersion` for audit.

Pagination: keyset `(sort_value, id)` descending, opaque base64 cursor —
stable under concurrent inserts, no duplicates (FR-SEARCH-004).

Reason codes: `TEXT_MATCH`, `NEAR_YOU` (<2 km), `HIGHLY_RATED` (≥4.3 &
≥100), `CURATED`, `OPEN_NOW`.

## Golden query set (SE-008 baseline — asserted in `apps/api/test/search.int.spec.ts`)

| #   | Query                | Filters                   | Must contain (top 3)                  | Rule exercised        |
| --- | -------------------- | ------------------------- | ------------------------------------- | --------------------- |
| G1  | `cà phê`             | —                         | The Workshop Coffee                   | accented text match   |
| G2  | `ca phe`             | —                         | The Workshop Coffee                   | unaccented ↔ accented |
| G3  | `cofee` _(typo)_     | —                         | The Workshop Coffee                   | trigram tolerance     |
| G4  | —                    | category=park, geo Q1 2km | Công viên Tao Đàn                     | filter + geo          |
| G5  | —                    | openAt=03:00              | rooftop bar only                      | overnight hours       |
| G6  | —                    | priceMaxPerPerson=50000   | free/cheap places, no rooftop bar     | price bound           |
| G7  | —                    | suitedFor=couple          | no group-only foodcourt top-ranked    | suitability           |
| G8  | `zzzz-không-tồn-tại` | —                         | ∅ + `search.zero_result` outbox event | zero-result telemetry |

Quality gate: every golden row passes in CI on the seeded corpus. Regression =
PR blocked. NDCG over a larger judged set starts when real query logs exist
(SE-006 dashboards — blocked on infra, tracked on GoGo-BE#36).

## Zero-result logging (FR-SEARCH-008)

`search.zero_result` outbox event: normalized query, filter summary,
pseudonymous actor. Never raw user text with PII, never location coordinates.

## When we would leave Postgres FTS (SE-009, #39)

The acceptance for SE-009 is "only do it when a threshold triggers", and no
threshold existed — so the trigger is defined in
[ADR-0008](adr/0008-search-engine-migration-trigger.md) and measured from data
`search_query_daily` already collects.

Short version: latency p95 > 700ms for 7 days at real volume, zero-result rate

> 15% for 14 days _after_ a synonym pass, a required capability that cannot be
> expressed (vector similarity, learning-to-rank, personalised ranking), or index
> maintenance costing more than a minute of degraded search a week.

Not triggers: corpus size on its own, one slow query, one bad week.

No spike has been started, deliberately. A spike answers "can the other engine
do this", which was never in doubt, and its answer ages before the trigger
fires.
