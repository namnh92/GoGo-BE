# ADR-0047: Global taxonomy generation and conditional reads

- Status: Accepted for GoGo-BE#799 (owner direction 2026-11-07)
- Contract: 7.3.0-alpha.1, MINOR additive

## Context

Taxonomies change rarely, while mood, filters and contribution screens repeatedly
need the same labels. FR-PREF-002 requires API keys; CMS remains the writer.
Mobile needs a persistent offline cache per locale without downloading every list
on every screen opening. CMS also needs the current generation and change time.

## Options and decision

Keep the existing `GET /v1/taxonomies` and add `version`, conditional GET and an
optional exact `locale` filter. Omitting locale retains all labels. Unknown or
missing translations produce no label in that locale; there is no implicit fallback.
The existing `kinds` semantics remain, including unknown kinds and empty filters.

Choose a separate `GET /v1/taxonomies/version` rather than coupling the generation
to bootstrap/profile responses: it is public, needs only one singleton-row query,
and works for guests and every consumer without expanding unrelated contracts.
It returns `{ version, updatedAt }`, ETag and `public, max-age=0, must-revalidate`.
CMS reads the same state through authenticated `/v1/cms/taxonomies/version`.
Existing CMS list arrays stay unchanged. Write responses add the committed state.

A migration initializes generation 1 and its timestamp for existing taxonomies.
Every successful CMS taxonomy operation locks the singleton **before** changing
rows, increments exactly once, and audits the resulting version/time in the same
transaction. This includes creation, labels, order, activation, deactivation,
synonym addition and removal. Synonyms affect client search behavior even though
they are absent from the picker payload, so conservatively invalidate all lists.
Accepted no-op updates and duplicate synonym additions also increment: generation
tracks successful write operations, not a content hash. Failures roll back data,
version and audit together. Audit failure prevents the write. Existing action names
are retained, including `taxonomy.deactivated`; all other updates gain
`taxonomy.updated`. The diff includes changed inputs, reference count when
deactivating, and the committed generation.

List version and rows use a repeatable-read, read-only transaction. A request may
serve the snapshot just preceding a concurrent commit, but can never label newer
rows with an older version. Writers serialize globally; no in-memory/Redis pointer
can become stale between instances. Stable row ordering breaks ties by key/locale.

Weak list ETags hash representation revision 1, generation, canonical sorted and
deduplicated kinds, and exact locale (omitted means all). Weakness allows harmless
serialization changes. Version and list validators use separate scopes. GET
If-None-Match supports weak comparison, lists and wildcard. 304 has no body and
retains the validator and cache policy. A matching list validator reads only the
singleton, skipping the list query. List policy is
`public, max-age=60, stale-while-revalidate=300`: this permits bounded staleness;
clients requiring a current generation call the version endpoint to revalidate.

## Consequences and verification

Consumers persist list + generation + ETag keyed by locale and kinds, render it
immediately/offline, and revalidate on app opening. An unchanged generation needs
no list transfer; a changed generation requires fetching that variant. An explicit
version check does not bypass a still-fresh shared list cache: consumers that need
the checked generation must request the list with `Cache-Control: no-cache` and
verify its returned version, retrying if a concurrent edit advances it again.
Locale changes select another persisted variant. Browser CORS permits
`If-None-Match` and `Cache-Control` requests and exposes `ETag`. CMS and Mobile implementation
remain separate issues.

No new metric is necessary: existing HTTP metrics capture statuses/latency and the
transactional audit captures writes and generations, without high-cardinality
version labels. Tests cover headers/304, locale/kinds separation, mutation types,
concurrent increments, failed writes and audit failure rollback on real Postgres.

## Migration and rollback

Apply additive migration 0087 before the API. Older API versions tolerate the new
table. CMS writes through an older binary do not increment it: pause CMS writes
during a mixed-version rollout/rollback. Before resuming upgraded writers after an
old binary has written, increment the preserved generation and timestamp in an
audited maintenance transaction so existing caches invalidate. Never reset/drop
or recreate the generation: clients may retain old validators indefinitely.
Integer overflow fails and rolls back rather than wrapping; widening before
approaching the PostgreSQL integer limit is a future additive migration.
