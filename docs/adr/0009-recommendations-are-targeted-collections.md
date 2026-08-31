# ADR-0009: A recommendation is a targeted collection, not a second content type

- **Status:** accepted
- **Date:** 2026-08-31
- **Deciders:** BE + product
- **Relates to** BE-CMS-G4a (#222), CMS-025 (GoGo-CMS#39), CMS-006 (#6)

## Context

GoGo-CMS#39 needs a Recommendations screen: create a named, ordered list of
places, aimed at an audience, in a city, live between two dates. Nothing in the
contract answers to that, so the screen cannot start.

`/v1/cms/collections` already exists and is shipped. A collection is a named,
ordered list of places with a slug, a title, a status and a schedule. Compared
against what the recommendation screen asks for, the overlap is not partial:

| Recommendation field                                        | Collection today                                    |
| ----------------------------------------------------------- | --------------------------------------------------- |
| Internal Key                                                | `slug`                                              |
| Title                                                       | `title`                                             |
| Places, ordered                                             | `collection_items.position`                         |
| Start / End                                                 | `starts_at` / `ends_at`                             |
| Status                                                      | `status` (draft / scheduled / published / archived) |
| Name, Subtitle, Audience, City, Categories, Vibes, Priority | — missing                                           |

So the question #222 asks — new resource, or subtype — is really: are the seven
missing fields a different _thing_, or the same thing with targeting on it?

The failure mode to avoid is the one the issue names: editorial content split
across two stores that cannot be recombined. If both exist, "the ordered list of
places we show on the home screen" lives in two tables, two APIs and two
screens, and any later feature — scheduling, moderation, analytics, a
place-removal cascade — has to be built twice or silently works on half the
data.

## Options considered

1. **New `recommendations` + `recommendation_places` tables.**
   Cheapest to write: no migration risk to a shipped screen, no shared status
   machine, a schema that says exactly what the mockup shows. But it duplicates
   the collection model field for field, and every subsequent editorial
   capability has to be implemented in both places or gain a branch. The two
   drift on the first feature that touches only one.

2. **One table, discriminated by `kind`, with the targeting columns nullable.**
   One editorial store, one status machine, one item-ordering mechanism, one
   audit vocabulary. The cost is nullable columns that are meaningless for a
   plain collection, and a shipped endpoint whose result set must now be
   filtered so it does not start returning rows the screen was never built for.

3. **Fold recommendations into collections with no discriminator** — every
   collection simply gains optional targeting.
   Simplest schema of the three, but it removes the ability to ask "is this a
   curated list or a targeted recommendation", which the console needs in order
   to show two screens at all, and makes it impossible to enforce that a
   recommendation has the fields a recommendation needs.

## Decision

**Option 2.** `content_collections` gains `kind ('collection' | 'recommendation')`
plus the targeting columns, and `/v1/cms/recommendations` is a view over the
rows where `kind = 'recommendation'`.

Two resources in the API, one model underneath. That is the honest description
of what these are: a recommendation _is_ a collection that knows who it is for.
Targeting is data about the same object, not a different object — and the moment
we need "which lists contain this place", "what is scheduled next week", or
"unpublish everything referencing a suspended place", the answer is one query
rather than two that must agree.

Validation, not nullability, carries the difference: a `recommendation` must
have an audience and a priority; a `collection` must not be given them.

## Consequences

- `GET /v1/cms/collections` now returns only `kind = 'collection'`. This is a
  behaviour change to a shipped endpoint, and it is the point: without it the
  collections screen would start listing recommendations it cannot edit.
- Taxonomy links (categories, vibes) live in a new join table against
  `taxonomies`, so they are stable keys, not display labels — the same rule as
  everywhere else.
- The consumer-facing surface is unchanged by this ADR. Nothing reads
  recommendations yet; when something does, it reads the same table.
- If product later decides recommendations need a genuinely different lifecycle
  (approval, experiments, per-user ranking), that is the trigger to revisit —
  a different _state machine_ would be real evidence of a different thing, in a
  way that a different form layout is not.

## Migration & rollback

`0023_recommendations.sql` is additive: a new enum, a `kind` column defaulting
to `'collection'` so every existing row keeps its meaning, nullable targeting
columns, and one join table. No existing row is rewritten and no column is
dropped.

Rollback is `DELETE FROM content_collections WHERE kind = 'recommendation'`
followed by dropping the added columns and the join table; the collections
screen is unaffected either way because its rows never carried the new columns.
