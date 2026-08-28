# ADR-0008: When to leave Postgres full-text search

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** BE + product
- **Relates to** SE-009 (#39), SE-006 (#36)

## Context

Search runs on PostgreSQL: `unaccent` + `pg_trgm` + full-text, with PostGIS for
geo filtering. SE-009 is "spike an external engine and write the migration
ADR", and its acceptance is **only do it when a threshold triggers**.

That acceptance is not satisfiable as written, because no threshold was ever
defined. "When Postgres is not enough" is a feeling, and a feeling triggers on
whichever week someone is frustrated — usually the week after a slow query
nobody profiled. Meanwhile the cost of migrating early is concrete: a second
datastore to run, keep in sync, secure, back up and restore, and a
reindexing pipeline that must be idempotent and resumable (SE-007) before it is
worth anything.

So the decision needed now is not which engine. It is **what would have to be
true** for that question to be worth asking, and how we would know.

Since #36 there is something to measure with: `search_query_daily` carries
searches, zero-results, mean result count and latency per day, and
`GET /cms/search-analytics` reads it back.

## Options considered

1. **Spike now, decide later.** A spike answers "can Elasticsearch do this",
   which was never in doubt. It does not answer "is Postgres failing us", and
   the answer ages: by the time the trigger fires, the spike is against an old
   corpus, an old query mix and an old version of both engines.
2. **Migrate when the corpus passes some size.** Simple and wrong. Size is not
   what breaks Postgres FTS — a million rows with simple queries is fine, and
   fifty thousand with heavy fuzzy ranking is not.
3. **Define measurable triggers, re-check them on a schedule, spike only when
   one fires.** More discipline, and the numbers already exist.

## Decision

**Option 3.** No spike is started. The trigger is defined here, measured from
data that is already collected, and re-checked at each release review.

Any **one** of these fires it:

| Trigger     | Threshold                                                                                                                           | Why this number                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latency     | `search` p95 > 700ms for 7 consecutive days at ≥ 1,000 searches/day                                                                 | 700ms is the search SLO in `docs/runbooks.md` §3. Seven days rules out a bad week; the volume floor stops three slow queries on a quiet Tuesday from firing it.                               |
| Relevance   | zero-result rate > 15% for 14 days **after** a synonym and taxonomy pass                                                            | Zero-result is the one relevance signal available without judgements. The "after" matters: the usual cause is a missing synonym, and a new engine does not supply Vietnamese synonyms either. |
| Query shape | a required feature cannot be expressed — semantic/vector similarity, cross-field learning-to-rank, or per-user personalised ranking | These are engine capabilities, not tuning. If one becomes a requirement, tuning Postgres is the wrong project.                                                                                |
| Operational | index maintenance forces > 1 minute of degraded search per week                                                                     | A rebuild that blocks the read path is a user-visible outage on a schedule.                                                                                                                   |

Explicitly **not** triggers: corpus size on its own; a single slow query
(profile it); one bad week; the fact that a competitor uses Elasticsearch.

**Before any spike**, the cheaper work has to be exhausted and shown not to
have fixed it: the trigram and FTS indexes actually used by the planner
(`EXPLAIN`, not assumption), a synonym pass driven by the worst-performing
queries from `cmsSearchAnalytics`, and the ranking weights re-tuned through the
offline evaluation harness (#49). Most latency complaints about Postgres FTS
are a missing index or a query that cannot use one.

**If a trigger fires**, the spike is time-boxed to 5 engineer-days and must
answer, against the real corpus and the real query mix:

- relevance against the same golden scenarios (`fixtures/golden-scenarios.json`)
- p95 latency at the volume that fired the trigger
- Vietnamese diacritic and synonym handling, measured not assumed
- cost per month at that volume, including the second datastore's backups
- reindex time from cold, and what search does while it runs

## Consequences

Easier: the argument stops being about taste. Someone proposing the migration
has to point at a number, and someone opposing it has to explain why the number
is wrong.

Harder: the triggers must actually be checked. A threshold nobody reviews is
the same as no threshold, so this is on the release-review checklist rather
than in someone's memory.

Accepted risk: a trigger could fire late — the system is measurably bad for up
to a week before the latency trigger confirms it. That is deliberate. Firing
early on noise costs a datastore we would then have to keep forever.

`SE-007` (indexing/change-data pipeline abstraction) stays worth doing on its
own merits, and it is what would make a future migration a swap rather than a
rewrite. It is not a prerequisite for this decision.

## Migration & rollback

Not applicable yet — no migration is being made. When a trigger fires, the
spike produces the migration ADR, which will need to cover dual-write, backfill,
read-path cutover behind a flag, and the rollback path back to Postgres FTS
while both indexes are still live.
