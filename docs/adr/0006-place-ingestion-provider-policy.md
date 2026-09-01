# ADR-0006: Place ingestion — provider policy, field masks, freshness, attribution

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** PI-BE-001, FR-INGEST-001..015, `GOGO_PLACE_INGESTION_SPEC.md` §3/§7
- **Supersedes nothing; extends** ADR-0004 (maps/place provider)
- **Amended 2026-09-01** — §9 Google content persistence policy (status *Proposed*, sign-off pending; the freeze in §9.5 applies from today)

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

| Tier      | When                         | Fields                                                                                           |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `core`    | every resolve                | `id,displayName,formattedAddress,location,businessStatus,primaryType,types,googleMapsUri,photos` |
| `quality` | row accepted / preview shown | `+ rating,userRatingCount,regularOpeningHours,priceLevel,priceRange`                             |
| `detail`  | explicit open by admin/user  | `+ reviews`                                                                                      |

Bulk jobs never request `detail`. Each call records its tier so cost per SKU
is attributable (`places_provider_requests_total{method,status}`).

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
does not take effect until counsel and product sign §9.6.** No PR may rely on a
row of §9.3 marked *needs decision* being permitted.

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

| Store | Fields | Evidence |
|---|---|---|
| `places` | `name`, `address_text`, `geom`, `rating`, `rating_count`, `price_level` | `libs/database/src/schema/places.ts:97-109` |
| `place_provider_sources` | `external_id`, `provider_uri`, `rating`, `rating_count`, `derived_score`, `price_level`, `primary_type`, `source_status`, `attribution`, `fetched_at` | `libs/database/src/schema/ingestion.ts:174-195` |
| `place_sources` | `external_id`, `url`, `attribution`, **`raw`** (full Details payload), `raw_updated_at` | `libs/database/src/schema/places.ts:152-171`; written at `libs/modules/places/application/place-import.service.ts:249-257` |
| `place_hours` | provider rows (`source='provider'`) | `libs/database/src/schema/places.ts:175-189` |
| `place_ingest_rows` | `candidates[] { googlePlaceId, name, address, lat, lng }` | `libs/database/src/schema/ingestion.ts:115-141` |

No purge job touches any of them: `libs/modules/shared/privacy-jobs.ts` covers
guest sessions and origin locations only. `place_sources.raw` is written and
**never read** — the only readers found are of an unrelated ingest-row `raw`
column (`place-import-job.service.ts:335`).

Google **photos** and **reviews** are not persisted anywhere. The `reviews`
table (`libs/database/src/schema/social.ts:52`) holds GoGo community reviews
written by GoGo users. Keep it that way.

### 9.3 Decision table (per field)

Classes: **allowed** · **temporary** (permitted but must expire) · **stop
writing** (no product need, remove) · **needs decision** (counsel must classify;
until then treated as *stop writing new*, existing rows frozen pending §9.4).

| Field | Store | Class | Basis / note |
|---|---|---|---|
| Google Place ID | `place_provider_sources.external_id`, `place_sources.external_id` | **allowed**, indefinite | SST §3. This is the identity the whole system is keyed on (§8, PR1). |
| Provider URI (`googleMapsUri`) | `place_provider_sources.provider_uri` | **allowed** | A link to Google, not Google content; required to send users back to the source. |
| Attribution string | `place_provider_sources.attribution`, `place_sources.attribution` | **allowed** — required | §3.2.3 attribution obligation; ADR-0006 §3. |
| Fetch metadata (`fetched_at`, `refresh_after`, `fetch_tier`, `source_status` timestamps) | `place_provider_sources` | **allowed** | GoGo-generated metadata about our own calls. |
| Latitude / longitude | `places.geom`, `place_ingest_rows.candidates.lat/lng` | **temporary — ≤30 consecutive days** | SST §14.3. Today nothing expires them; the 30-day rule needs a mechanism (§9.4 R2), not just a note. |
| Display name | `places.name`, `place_ingest_rows.candidates.name` | **needs decision** | §3.2.3(a)/(b). Editors also edit `places.name`, so a blanket purge would delete GoGo-authored content — remediation must distinguish provenance (no source marker exists today). |
| Formatted address | `places.address_text`, `place_ingest_rows.candidates.address` | **needs decision** | Same as name; `#280` already tracks the missing editor-override path. |
| Rating / rating count | `places.rating`, `places.rating_count`, `place_provider_sources.rating`, `.rating_count` | **needs decision** | Aggregates of Google content. Rule 14 of the workspace core rules requires provider ratings to stay separate and carry their sample size — if they may not be stored, the product shows them live-fetched or not at all. |
| Derived quality score | `place_provider_sources.derived_score` | **needs decision** | Bayesian shrinkage of Google aggregates (§5). Derived, but not independent of the source data. |
| Price level | `places.price_level`, `place_provider_sources.price_level` | **needs decision** | Google-supplied; GoGo verified prices in `place_prices(source='editor'|'bill_checkin')` are unaffected. |
| Opening hours | `place_hours` rows with `source='provider'` | **needs decision** | `source='editor'` rows are GoGo content and out of scope. |
| Business status / primary type | `place_provider_sources.source_status`, `.primary_type` | **needs decision** | Identity/closure signals; PR6 and PR7 depend on holding them. If refused, closure detection becomes fetch-time only. |
| Raw Details payload | `place_sources.raw`, `raw_updated_at` | **stop writing** | Full provider payload, unbounded, no reader, no purge. Independent of the counsel outcome: nothing reads it, so nothing justifies keeping it. |
| Photos (bytes or URLs) | not stored | **never store** | Photo references are fetched per view; unchanged by this amendment. |
| Google reviews | not stored | **never store** | Tier `detail` may fetch them for immediate display only. |

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

| Role | Name | Date | Outcome recorded |
|---|---|---|---|
| Counsel / legal review | _pending_ | _pending_ | classifies every **needs decision** row of §9.3 |
| Product owner | _pending_ | _pending_ | accepts the product consequences of each refusal |

Until both rows are filled, this amendment's status stays *Proposed*, PR8
(GoGo-BE#341) stays blocked, and production Google Places keys stay gated
(ADR-0004 §5 amendment; ex-BE#80).

## Consequences


- Predictable provider spend; a bulk job of 5.000 rows costs `core`(+`quality`
  on accepted rows) rather than full details per row.
- Attribution/freshness are structural (columns + DTO fields), not a UI
  afterthought, so a licence audit is answerable from the database.

## Rollback

Tiers and thresholds are config; switching provider means a new adapter
behind the same port — ingestion logic is untouched.
