# ADR-0016: `areaKey` is a discovery area, hours carry a day kind, and provenance is per field

- **Status:** accepted
- **Date:** 2026-09-06
- **Deciders:** BFF/API, Database, CMS Ops
- **Issue:** GoGo-BE#425 (BE-CMS-PE-001); epic GoGo-CMS#121

## Context

The CMS place editor could not finish a place. Four separate questions had no
answer in the contract, and each of them produced a different visible failure:

1. **What is `areaKey`?** `places.area_key` is free text with no catalog and no
   foreign key. The console shipped it as a plain text box under a hint telling
   the editor to "pick a taxonomy" — and `taxonomy_kind` has no `area` value, so
   the hint pointed at nothing. Six tables carry an `area_key`
   (`places`, `rooms`, `plans`, `plan_templates`, `content_recommendations`,
   `cms_banners`) and none of them could say what the legal values were.
2. **Where does the address live?** There were no `city`/`district` columns at
   all, and `phone`/`website` existed but `cmsUpdatePlace` did not accept them —
   so the console rendered them as read-only facts an editor could see and never
   correct.
3. **What can a day of opening hours say?** `place_hours` held only spans. A day
   with no row meant "closed" and "we have no data" indistinguishably; "open
   around the clock" had no encoding, because the column check stops at minute
   1439 and `00:00–23:59` shuts the place for a minute every night.
4. **Who wrote this value?** `place_sources` records that a place is _linked_ to
   a Google record and `place_provider_sources` records that link's liveness.
   Neither says who wrote the phone number, so a provider refresh had no way to
   tell an editor's own observation from its own earlier import.

There was also a concrete bug behind the epic. The console coerced an empty
number input to `0` and sent `avgVisitMinutes: 0`; the server floor is `10`; so
**every save of a place with no visit duration returned
`400 VALIDATION_FAILED`**. The same coercion sent `lat: 0, lng: 0` for an empty
coordinate — which the server _accepted_, moving the place to Null Island and
invalidating every cached travel leg. The contract had no way to say "this field
is empty" other than omitting it, and the console had no way to omit it.

## Options considered

### Q1 — the `areaKey` vocabulary

1. **Add a `taxonomy_kind` of `area`.** Reuses the taxonomy labels, `is_active`
   and sort order the CMS already renders. But taxonomies describe _what a place
   is like_ and hang off `place_taxonomies`; an area is a scalar that rooms,
   plans, banners and recommendations each hold one of. It would also need a
   parent (a district belongs to a city) that `taxonomies.parent_id` would have
   to fake, and it would put areas in the taxonomy screen next to moods.
2. **A new `areas` table.** Clean shape, and wrong: it would be a _second_
   catalog of the same thing.
3. **Expose the `service_areas` table that already exists.** Its keys are
   literally the values `places.area_key` holds (`hcm_q1`, `hcm_thuduc`), and it
   is already the list community import checks a submitted place's coordinates
   against. It was invisible to the CMS only because nothing exposed it.

### Q3 — closed / unknown / 24h

1. **Sentinel minutes** (`0–1440`, or `0–0` meaning closed). Rejected: 1440 is
   outside the existing check constraint, and every reader would have to know
   which magic pair meant what — `hard-filter.ts`, `search.repository.ts`,
   `search.service.ts` and the CMS all read these columns.
2. **A separate `place_hour_days` table** holding a per-day state. Correct but
   two tables to keep consistent, and a day's state and its spans would be
   writable independently.
3. **An `entry_kind` enum column on `place_hours`.** One row shape, one write
   path, and the column check keeps a whole-day row from carrying minutes.

## Decision

**`areaKey` is the discovery area, and its vocabulary is `service_areas.key`.**
It is exposed as `GET /cms/areas` (`cmsListAreas`) with the count of places
already filed under each key. Keys present on places but absent from the catalog
are returned with `known: false` — `places.area_key` has never been a foreign
key, and hiding those would make a place's own value vanish from the picker
meant to show it. It stays free text rather than becoming a foreign key:
existing rows carry keys the catalog does not list, and a FK added in the same
migration that creates the catalog would fail the deploy on the first such row.

**The administrative address is separate from the discovery area.**
`places.city` and `places.district` are new, nullable, free-text _names_ rather
than codes: Vietnamese administrative units are reorganised, editors need to
type one the catalog does not carry, and minting a code for it would put a key
in the data that resolves to nothing. **A district is not required** — an
address without one is valid. A place can sit in Bình Thạnh and belong to the
Thảo Điền discovery area, which is exactly why these are two fields.

**`phone` and `website` become writable, normalized on the way in.** Phone is
stored E.164, defaulting to `+84` for a number with a trunk `0`, and refused
outright for a bare subscriber number rather than assumed Vietnamese. Website
accepts only `http`/`https` with a host — the value is rendered as an `href` in
three clients, so the scheme list is an allowlist, not a denylist.

**`null` clears a field; an absent key leaves it alone.** This applies to every
nullable text field and to `avgVisitMinutes`. The floor of 10 minutes stays: a
ten-minute visit is a typo, and accepting `0` would trade one wrong answer for
another. The console sends `null`, not `0`, for an empty box.

**`place_hours.entry_kind` is `interval | closed | open_24h`, and unknown is the
absence of a row.** There is deliberately no `unknown` kind: "we have no data"
is not something a row asserts about a place. A day may hold up to four
`interval` rows; `closed` and `open_24h` carry no minutes and must be the only
row for their day (enforced by a column check _and_ by the domain, so the editor
gets a field path instead of a constraint violation). Overlap is validated
across the whole week on a wrapped minute line, so a Saturday-night overnight
span colliding with Sunday morning is caught.

**Provenance is recorded per field in `place_field_provenance`,** as
`editorial | provider | community | google_derived`. Per
`GOGO_PRODUCT_DATA_ARCHITECTURE.md`, an editor re-typing what a provider shows
does **not** transfer ownership — so `cmsUpdatePlace` always records
`editorial` (the person made the claim) and never `google_derived`. That value
is reserved for an apply-from-preview path, which **this ADR does not enable**:
persisting provider-derived content still needs the ADR-0006 §9.6 decision on
which fields may be stored, retention and attribution. Until then the console
previews and compares, and only a human's own typing is stored.

The table is **not backfilled.** Every place predating it has fields whose
origin nothing recorded, and writing `editorial` over them would manufacture the
provenance the table exists to keep honest. Absent means unclaimed, and the UI
must say so in words rather than defaulting it to "GoGo".

**Hours provenance is not assumed either.** A row the console declares
`source: provider` keeps provider provenance and the fetch time of the row it
replaces, and does **not** move the place's freshness clock. Only `editor` rows
stamp `verified_at`. Re-saving a provider week is not a verification anyone
performed.

**Optimistic concurrency uses `updatedAt`, not a new version column.**
`cmsUpdatePlace` and `cmsSetPlaceHours` accept `expectedUpdatedAt`; a mismatch
is `409 PLACE_MODIFIED` carrying the current value in `field_errors[0].message`
so the client can show what it would have overwritten. The field is optional, so
a script and a client predating this contract still work.

## Consequences

- The CMS gets a real area picker with loading/empty/error states over real
  data, and the place-list filter and the editor now use the same vocabulary.
- Every reader of `place_hours` had to learn `entry_kind`: `search.repository`
  (the `openAt` predicate), `search.service` (`openStateAt`), and the suggestion
  `hard-filter`. A `closed` row carries `0/0` minutes and would otherwise have
  read as "open at midnight" — the single most likely silent regression, so it
  is covered by tests in all three.
- `Candidate.hours[].kind` is optional in the suggestion domain: fixtures and
  rows predating the column have no value, and absent means `interval`, which is
  the only thing a row could have been before.
- CMS must send `null` rather than `0`/`''` for empty fields. Sending `0` for
  `avgVisitMinutes` still fails, deliberately.
- Google-content persistence remains **blocked**. CMS#126 ships preview and
  identity resolution only, and says so in the UI rather than enabling a write
  this ADR did not authorize.

## Migration & rollback

`migrations/0044_place-editor-contracts.sql` is additive only: one new table,
three new nullable/defaulted columns, two new enums, one check constraint.
Nothing is dropped, nothing changes type, and no existing value is rewritten
except `service_areas.city`, which is backfilled from the part of `name` after
the last comma (rows without a comma keep `NULL` rather than being guessed at).

Deploying it in front of the old code is a no-op for the old code, which is what
lets the backend ship before the CMS.

Rollback is the `Down:` block at the top of the migration — drop the provenance
table and both enums, drop `entry_kind` and its constraint, drop
`places.city`/`district` and `service_areas.city`. Every step removes something
this migration added, so backing out loses only what was written through the new
contract. `places.area_key` is untouched in both directions: it was free text
before and stays free text after.
