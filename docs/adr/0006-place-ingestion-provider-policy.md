# ADR-0006: Place ingestion — provider policy, field masks, freshness, attribution

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** PI-BE-001, FR-INGEST-001..015, `GOGO_PLACE_INGESTION_SPEC.md` §3/§7
- **Supersedes nothing; extends** ADR-0004 (maps/place provider)
- **Amended 2026-09-01** — §9 Google content persistence policy (status _Proposed_, sign-off pending; the freeze in §9.5 applies from today)

## Context

Two entry points feed the catalog — CMS bulk import (CSV/XLSX/Sheets) and
Mobile add-by-link. Both need provider data, both cost money per call, and
both carry licence obligations. Without one policy they drift apart and the
SKU bill grows silently.

## Decision

### 1. One resolver, no direct provider access

CMS and Mobile call GoGo endpoints only. `PlaceIngestionModule` owns URL
parsing, resolution, scoring, dedup and enrichment; the provider sits behind
`PlaceProviderPort` (ADR-0004). No HTML scraping of Google Maps anywhere.

### 2. Field-mask tiers (cost control)

| Tier       | When                                      | SKU                         | $/1k | Fields                                                                                           |
| ---------- | ----------------------------------------- | --------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `liveness` | refresh; id/moved-place verification only | Details Essentials IDs-Only | 0    | `id,movedPlaceId`                                                                                |
| `core`     | every resolve                             | Details Pro                 | 17   | `id,displayName,formattedAddress,location,businessStatus,primaryType,types,googleMapsUri,photos` |
| `quality`  | row accepted / preview shown / publish    | Details Enterprise          | 20   | `+ rating,userRatingCount,regularOpeningHours,priceLevel,priceRange`                             |
| `detail`   | explicit open by admin/user               | Details E + Atmosphere      | 25   | `+ reviews`                                                                                      |

Bulk jobs never request `detail`. Each call records its tier so cost per SKU
is attributable (`places_provider_requests_total{method,status}`), and the
masks are pinned by equality in `google-places-field-mask.spec.ts`: the field
mask _is_ the cost decision, so changing one is a cost change that needs the
test updated in the same PR.

**Amendment 2026-09-02 (#338, plan §2.4).** Three things settled with the
`liveness` tier:

- `PlaceProviderPort.details` has **no default tier**. The default was
  `quality`, so a caller that never thought about cost bought Enterprise; the
  argument is now required and the compiler asks the question at every call
  site.
- `liveness` returns a `ProviderPlaceIdentity`, not a `ResolvedProviderPlace`.
  A tier that fetches no rating must not be able to report `ratingCount: 0` —
  that is "unknown" written as "zero", and it is the failure the tiers exist to
  prevent. `place_provider_sources.fetch_tier` therefore accepts only the three
  describing tiers.
- The mask is plan §2.4 verbatim, `id,movedPlaceId`. Both are Place Details
  Essentials IDs-Only fields, so the move pointer rides along without lifting
  the request to a billed tier. It carries **two independent move signals**, and
  PR7 needs both: `movedPlaceId` is Google naming a successor outright, and
  `requestedProviderPlaceId` is Google answering under a different id without
  saying so — the case §8 detects by comparison. Neither substitutes for the
  other, and a refresh watching only the id comparison would reset the freshness
  clock on every place Google moved politely. `movedPlaceId` stays out of
  `core`/`quality`/`detail`: those tiers describe a place to a caller that
  already knows which id answered.

There is no cheaper tier between `liveness` and `core`: `businessStatus` is a
Pro field, so a "is it still open?" tier would be billed exactly as `core` is.

**Amendment 2026-09-02 (#339) — `FUTURE_OPENING` is owned in the domain, not in
storage.**

The adapter used to coerce every unrecognised `businessStatus` to
`OPERATIONAL`, so `FUTURE_OPENING` — a place Google lists as announced but not
yet trading — was imported as open and published. It now has its own value on
`ResolvedProviderPlace`, and all three doors into the catalogue refuse it:
`POST /v1/place-submissions` and bulk publish with `409 PLACE_NOT_YET_OPEN`,
`POST /v1/places/imports` with `reasonCode: 'NOT_YET_OPEN'`.

It is **not** owned in storage, and that is a recorded debt rather than an
oversight. `provider_source_status` is `active | moved | temporarily_closed |
closed | unknown` (migrations 0002, 0007); adding `future_opening` would store a
strictly more specific Google fact than the column holds today, which §9.5
forbids until §9.6 is signed. `upsertProviderSource` therefore flattens it to
`unknown`, losing the difference between "Google says this has not opened" and
"we do not know".

The flattening is reachable but not load-bearing — the three refusals above mean
no place should be sitting on such a row — and `unknown` is the safe direction:
it is the one value `PROVIDER_STATUS_TO_BUSINESS_STATUS` declines to map, so a
DB-first read misses and asks Google instead of answering "open" from a fact
that was never stored.

**When §9.6 is signed**, this closes as a one-value enum migration plus a
one-word change in `upsertProviderSource`, and `future_opening` joins `closed`
and `temporarily_closed` in the search exclusion. Until then the catalogue
cannot express it, and no code should claim it can.

**Tier per call site**, as shipped:

| Path                                                              | Tier      | Why                                                           |
| ----------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| CMS bulk resolve (`create_drafts`, `dry_run`, `publish_approved`) | `core`    | settles identity, category, confidence — all Pro fields       |
| CMS bulk resolve (`update_existing`)                              | `quality` | the mode overwrites rating / review count / price level       |
| CMS bulk publish                                                  | `quality` | writes the catalogue row and its hours                        |
| CMS bulk merge into an existing place                             | `quality` | writes the canonical provider row                             |
| CMS row confirm                                                   | `core`    | reaches `applyResolved` without a context; cannot write facts |
| Mobile resolve-link preview                                       | `quality` | the candidate renders Google's rating and review count        |
| Mobile submit, un-attested                                        | `core`    | reads `businessStatus` and dedups by name + coordinate        |
| Moderator approve                                                 | `quality` | this fetch becomes the catalogue row                          |
| `POST /v1/places/imports`                                         | `quality` | gates on rating and review count, then writes them            |

### 3. Data ownership

Provider-owned: name, address, geo, rating, ratingCount, hours, photos,
reviews — stored with `fetchedAt`, `refreshAfter`, `attribution`, and never
presented as GoGo's own. GoGo-owned: taxonomy, audience, vibe, verified
price, highlights, GoGo reviews. Google rating, GoGo rating and the composite
score are three separate fields in every DTO — never merged into one number.

### 4. Freshness

`refreshAfter = fetchedAt + 30d` for quality fields; search/suggestion only
consider places whose provider source is inside the window or that have an
editor-verified override. Stale rows land in the CMS stale queue, they are
not silently shown as current.

### 5. Quality score (Bayesian shrinkage)

`adjusted = (n/(n+50))·rating + (50/(n+50))·prior`, prior = category-city mean
→ city mean → global mean. Raw `rating`/`userRatingCount` persist untouched
alongside the derived score; a handful of sample reviews is never
sentiment-scored as if representative.

### 6. Security posture

Hostname allowlist, ≤5 redirects, 5s timeout, private/loopback IP blocked
(SSRF). Upload MIME sniffed from content, macros never executed, row/size/
cell caps enforced, error-report CSV escaped against formula injection.
Provider key stays server-side.

### 8. Amendment 2026-08-27 — single provider, mandatory link, update precedence

Three refinements decided while scoping the `update_existing` import mode:

**One trusted provider for now.** Google Places is the only provider GoGo
trusts. This is a policy choice, not a modelling one: provider links stay in
`place_provider_sources (provider, external_id)`, so adding a second provider
later is a new adapter and new rows, not a migration. (This is why the
provider id is deliberately _not_ a unique column on `places`.)

**Every place is anchored to a Google Maps link.** Including places an editor
enters by hand: the link is what makes rating, review count, hours and
business status verifiable. A place without a provider link is a data-quality
defect, not a legitimate provenance — the CMS `source=manual` filter exists to
find them, not to bless them.

**On update, provider facts win.** Re-importing a row re-resolves it against
Google and takes the fresh provider-owned fields (§3), because a place may have
changed name, hours or owner since it was first ingested. Sheet/editor keeps
ownership of the GoGo-owned fields.

The consequence needs stating, because it is the case that motivated the rule:
when a place changes _owner_, provider facts and GoGo editorial content stop
describing the same business. Taking the new name while keeping the old
highlight, curated price and category produces a record that lies. So the fresh
data is always taken, but a material identity change — name similarity below
threshold, or `business_status` turning `CLOSED_PERMANENTLY` — moves the place
to `review` with a diff for an editor, rather than silently republishing it.
Saved places, GoGo reviews and plan stops still point at that row; whether they
survive the change is an editorial decision, not one the importer should make.

## 9. Amendment 2026-09-01 — Google content persistence policy

**Status: Proposed — the restrictive half is in force now; the permissive half
does not take effect until counsel signs §9.6.** Product signed on 2026-09-02;
counsel has not. No PR may rely on a row of §9.3 marked _needs decision_ being
permitted.

Source: `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` §0.2 C3/C4,
§3 PR0, §7. Supersedes ADR-0004 §3's caching sentence for everything except the
Place ID.

### 9.1 Why this is a real gate

Google Maps Platform Terms §3.2.3(a)/(b) prohibit pre-fetching, caching and
storing Places content, with narrow exceptions. Service Specific Terms §3 lets
the **Place ID** be stored indefinitely; SST §14.3 permits latitude/longitude to
be stored for **no more than 30 consecutive calendar days**. Everything else —
name, address, rating, review count, opening hours, price level, business
status, photos, reviews, raw payloads — falls under the general prohibition and
its exceptions, and reading those exceptions is a legal judgement, not an
engineering one.

Two conflations to avoid, because both are already latent in this repo:

- **A refresh cadence is not a storage allowance.** `refreshAfter = fetchedAt + 30d`
  (§4) describes when data goes stale. It says nothing about whether we were
  permitted to hold it for those 30 days, and it does not expire anything —
  `refresh_after` is written and, at this commit, never read.
- **Same-execution reuse is not a cached snapshot.** Passing one
  `ResolvedProviderPlace` down a call chain within a single request persists
  nothing. Writing it to Postgres for a later request does. Only the second is
  gated here.

### 9.2 What is persisted today (source of the inventory)

| Store                    | Fields                                                                                                                                                | Evidence                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `places`                 | `name`, `address_text`, `geom`, `rating`, `rating_count`, `price_level`                                                                               | `libs/database/src/schema/places.ts:97-109`                                                                                                    |
| `place_provider_sources` | `external_id`, `provider_uri`, `rating`, `rating_count`, `derived_score`, `price_level`, `primary_type`, `source_status`, `attribution`, `fetched_at` | `libs/database/src/schema/ingestion.ts:174-195`                                                                                                |
| `place_sources`          | `external_id`, `url`, `attribution`, **`raw`** (full Details payload), `raw_updated_at`                                                               | `libs/database/src/schema/places.ts:152-171`. Writer removed and values purged by R1 (PR #345, migration 0033); column drops one release later |
| `place_hours`            | provider rows (`source='provider'`)                                                                                                                   | `libs/database/src/schema/places.ts:175-189`                                                                                                   |
| `place_ingest_rows`      | `candidates[] { googlePlaceId, name, address, lat, lng }`                                                                                             | `libs/database/src/schema/ingestion.ts:115-141`                                                                                                |
| `place_imports`          | **`provider_snapshot`** (`jsonb`: `name`, `addressText`, `lat`, `lng`, `rating`, `ratingCount`, `attribution`)                                        | `libs/database/src/schema/places.ts:310`. Writer removed and values purged by R5 (#348, migration 0036); column drops one release later        |

No purge job touches any of them: `libs/modules/shared/privacy-jobs.ts` covers
guest sessions and origin locations only. `place_sources.raw` is written and
**never read** — the only readers found are of an unrelated ingest-row `raw`
column (`place-import-job.service.ts:335`).

**Amended by #348.** `place_imports.provider_snapshot` was missing from this
inventory. The list above was assembled around the ingestion path, and
`place_imports` belongs to the older community-import flow (BE-BFF-013), so a
whole store went uncounted — in a section whose entire value is being the
complete answer to "what is stored today". It had the same shape as
`place_sources.raw`: exactly one writer, no reader anywhere, no TTL, and
coordinates inside it. The lesson is that this inventory must be re-derived by
search (`rg` for every `jsonb` column and every provider field), not recalled
from the flow whoever is editing it happens to be working on.

Google **photos** and **reviews** are not persisted anywhere. The `reviews`
table (`libs/database/src/schema/social.ts:52`) holds GoGo community reviews
written by GoGo users. Keep it that way.

### 9.3 Decision table (per field)

Classes: **allowed** · **temporary** (permitted but must expire) · **stop
writing** (no product need, remove) · **needs decision** (counsel must classify;
until then treated as _stop writing new_, existing rows frozen pending §9.4).

| Field                                                                                                                                    | Store                                                                                                                   | Class                                | Basis / note                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google Place ID                                                                                                                          | `place_provider_sources.external_id`, `place_sources.external_id`                                                       | **allowed**, indefinite              | SST §3. This is the identity the whole system is keyed on (§8, PR1).                                                                                                                                                                                                                             |
| Provider URI (`googleMapsUri`)                                                                                                           | `place_provider_sources.provider_uri`                                                                                   | **allowed**                          | A link to Google, not Google content; required to send users back to the source.                                                                                                                                                                                                                 |
| Attribution string                                                                                                                       | `place_provider_sources.attribution`, `place_sources.attribution`                                                       | **allowed** — required               | §3.2.3 attribution obligation; ADR-0006 §3.                                                                                                                                                                                                                                                      |
| Fetch metadata (`fetched_at`, `refresh_after`, `fetch_tier`, `source_status` timestamps)                                                 | `place_provider_sources`                                                                                                | **allowed**                          | GoGo-generated metadata about our own calls.                                                                                                                                                                                                                                                     |
| Successor Google Place ID (`movedPlaceId`)                                                                                               | `place_provider_sources.moved_to_external_id`                                                                           | **allowed**, indefinite              | SST §3 — a Place ID, the same class as `external_id`. Written by PR7's liveness refresh (#340) when Google names a successor, or answers as one. Nothing repoints a place onto it automatically: the place goes to `review` and an editor decides.                                               |
| Refresh bookkeeping (`refresh_priority`, `refresh_attempts`, `transient_failures`, `last_refresh_attempt_at`, `last_refresh_error_code`) | `place_provider_sources`                                                                                                | **allowed**                          | GoGo-generated metadata about our own calls (#340). `last_refresh_error_code` holds Google's canonical status (`NOT_FOUND`, `INVALID_ARGUMENT`), `EMPTY_ANSWER`, or a transport code (`QUOTA_EXCEEDED`, `PROVIDER_UNAVAILABLE`) — a status code about our request, never a payload or a message. |
| Latitude / longitude                                                                                                                     | `places.geom`; formerly `place_ingest_rows.candidates.lat/lng` (R3a) and `place_imports.provider_snapshot.lat/lng` (R5) | **temporary — ≤30 consecutive days** | SST §14.3. Nothing expires them in `places.geom`; the 30-day rule needs a mechanism (§9.4 R2), not just a note. The two candidate/snapshot stores were removed outright instead of given a clock, because nothing read them.                                                                     |
| Display name                                                                                                                             | `places.name`, `place_ingest_rows.candidates.name`                                                                      | **needs decision**                   | §3.2.3(a)/(b). Editors also edit `places.name`, so a blanket purge would delete GoGo-authored content — remediation must distinguish provenance (no source marker exists today).                                                                                                                 |
| Formatted address                                                                                                                        | `places.address_text`, `place_ingest_rows.candidates.address`                                                           | **needs decision**                   | Same as name; `#280` already tracks the missing editor-override path.                                                                                                                                                                                                                            |
| Rating / rating count                                                                                                                    | `places.rating`, `places.rating_count`, `place_provider_sources.rating`, `.rating_count`                                | **needs decision**                   | Aggregates of Google content. Rule 14 of the workspace core rules requires provider ratings to stay separate and carry their sample size — if they may not be stored, the product shows them live-fetched or not at all.                                                                         |
| Derived quality score                                                                                                                    | `place_provider_sources.derived_score`                                                                                  | **needs decision**                   | Bayesian shrinkage of Google aggregates (§5). Derived, but not independent of the source data.                                                                                                                                                                                                   |
| Price level                                                                                                                              | `places.price_level`, `place_provider_sources.price_level`                                                              | **needs decision**                   | Google-supplied; GoGo verified prices in `place_prices(source='editor'                                                                                                                                                                                                                           | 'bill_checkin')` are unaffected. |
| Opening hours                                                                                                                            | `place_hours` rows with `source='provider'`                                                                             | **needs decision**                   | `source='editor'` rows are GoGo content and out of scope.                                                                                                                                                                                                                                        |
| Business status / primary type                                                                                                           | `place_provider_sources.source_status`, `.primary_type`                                                                 | **needs decision**                   | Identity/closure signals; PR6 and PR7 depend on holding them. If refused, closure detection becomes fetch-time only.                                                                                                                                                                             |
| Raw Details payload                                                                                                                      | `place_sources.raw`, `raw_updated_at`                                                                                   | **stop writing**                     | Full provider payload, unbounded, no reader, no purge. Independent of the counsel outcome: nothing reads it, so nothing justifies keeping it.                                                                                                                                                    |
| Import provider snapshot                                                                                                                 | `place_imports.provider_snapshot`                                                                                       | **stop writing**                     | Google Details extract (name, address, lat/lng, rating, rating count) written on every verified `/v1/places/imports`, with one writer and no reader, no TTL and no purge. Same reasoning as the row above, and likewise independent of the counsel outcome (#348, §9.4 R5).                      |
| Photos (bytes or URLs)                                                                                                                   | not stored                                                                                                              | **never store**                      | Photo references are fetched per view; unchanged by this amendment.                                                                                                                                                                                                                              |
| Google reviews                                                                                                                           | not stored                                                                                                              | **never store**                      | Tier `detail` may fetch them for immediate display only.                                                                                                                                                                                                                                         |

### 9.4 Remediation of existing rows

Recording the requirement is PR0's deliverable; the work is executed later and
**never as a silent production delete**. Each item ships as a reviewed
migration + runbook entry with a row count taken before and after.

- **R1 — `place_sources.raw` (PR1).** Stop writing at
  `place-import.service.ts:249-257`; purge existing values (`raw = NULL`,
  `raw_updated_at = NULL`) in the same forward-only migration that unifies
  provenance (§8, plan §2.1). The column is dropped one release later, once no
  deployed code references it.
- **R2 — coordinates (PR7/PR8, gated on §9.6).** A ≤30-day rule needs either a
  refresh that resets the clock or an expiry that clears the value. Phase 1
  refresh (IDs-only liveness) resets `fetched_at` but fetches no coordinates;
  the mechanism that actually satisfies §14.3 must be designed with the counsel
  answer in hand, not assumed.
- **R3 — `place_ingest_rows.candidates` (PR1).** Match candidates are working
  state for a moderation decision, not catalogue data. Trim to
  `{ googlePlaceId, confidence }` on rows in a terminal job status, and stop
  persisting `name`/`address`/`lat`/`lng` for candidates that were never chosen.
- **R5 — `place_imports.provider_snapshot` (#348).** Stop writing at
  `place-import.service.ts`; purge existing values (`provider_snapshot = NULL`)
  in forward-only migration `0036_import-provider-snapshot.sql`, which is
  guarded so a second run updates nothing. The column is dropped one release
  later, once no deployed code references it — the same shape as R1. Not gated
  on §9.6: a store with no reader has no product purpose to weigh against the
  retention rule, so classifying it does not pre-empt any counsel decision.
  `place_imports.provider_place_id` is deliberately kept (SST §3), so the row
  still records which place it resolved to.
- **R4 — `places` / `place_provider_sources` provider-derived fields (PR8).**
  Blocked on §9.6. Any deletion here removes catalogue content that editors may
  have edited, so it needs a provenance marker first — which is itself part of
  the PR8 design, not a prerequisite this ADR can hand-wave.

### 9.5 Freeze in force now

Until §9.6 is signed:

```text
Place ID persistence                      → allowed
same-execution provider object reuse      → no persistence problem
signed ID verification attestation        → carries no Google content, allowed
new persistent Google content             → NOT ALLOWED
```

Concretely, no PR may add a jsonb snapshot of a provider response, widen the set
of provider-derived columns, add a cache (Redis, memory, table) of names,
addresses, ratings, hours or coordinates, or extend how long any of them is
held. **Reviewers check the diff for new writes of provider-derived fields; such
a write outside PR8 is a blocking finding.** PR1, PR4 and PR7 are explicitly
designed to need no new stored Google content — PR4 replaces a repeated fetch
with a short-lived signed attestation over the Place ID alone, and PR7 refreshes
with the IDs-only mask.

### 9.6 Sign-off (required before PR8)

| Role                   | Name                                | Date       | Outcome recorded                                                            |
| ---------------------- | ----------------------------------- | ---------- | --------------------------------------------------------------------------- |
| Counsel / legal review | _pending_                           | _pending_  | will classify every **needs decision** row of §9.3                          |
| Product owner          | _product owner, name not on record_ | 2026-09-02 | **APPROVED** — accepts the consequences of the deny-by-default policy below |

The product row was recorded from a decision relayed by the repository owner on
2026-09-02. No individual name or signature was supplied, so none is written
here: an ADR that invents a signatory is worse evidence than one that says the
name was not recorded.

**The counsel row is empty and stays empty until counsel answers.** Nothing in
this section may be read as legal sign-off, and no later change may infer one
from the product approval — they answer different questions. Product accepted
what the current policy costs the product; counsel has not yet classified what
the policy is allowed to be.

One row of two is filled, so **this amendment's status stays _Proposed_**, PR8
(GoGo-BE#341) stays blocked, and production Google Places keys stay gated
(ADR-0004 §5 amendment; ex-BE#80).

#### 9.6.1 Program gate as amended 2026-09-02

Product approval unblocks the work that was only ever waiting on it. It changes
no row of §9.3 and relaxes no clause of §9.5.

**Allowed to proceed** — each must preserve §9.5 in full: no new persisted
Google content, no cross-request Google content snapshot, no widened retention.

| PR   | Issues                           |
| ---- | -------------------------------- |
| PR4  | GoGo-BE#337 + GoGo-MobileApp#128 |
| PR5  | GoGo-BE#338                      |
| PR7  | GoGo-BE#340                      |
| PR10 | GoGo-BE#343                      |

**Still blocked on counsel sign-off:**

| Item                                                                                                                                     | Issues                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| PR8 — provider-content refresh                                                                                                           | GoGo-BE#341 + GoGo-CMS#98 |
| Candidate `name` / `address` persistence decision (R3b)                                                                                  | GoGo-BE#346               |
| R2 (`places.geom` under SST §14.3) and R4, and any work needing persistence of Google-derived content classed **needs decision** in §9.3 | §9.4 R2/R4                |

A reviewer who finds a diff in the allowed column writing a provider-derived
field has found a blocking defect, exactly as §9.5 already says. The gate moved;
the freeze did not.

## Consequences

- Predictable provider spend; a bulk job of 5.000 rows costs `core`(+`quality`
  on accepted rows) rather than full details per row.
- Attribution/freshness are structural (columns + DTO fields), not a UI
  afterthought, so a licence audit is answerable from the database.

## Rollback

Tiers and thresholds are config; switching provider means a new adapter
behind the same port — ingestion logic is untouched.
