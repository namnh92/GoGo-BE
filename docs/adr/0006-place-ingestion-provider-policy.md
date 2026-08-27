# ADR-0006: Place ingestion — provider policy, field masks, freshness, attribution

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** PI-BE-001, FR-INGEST-001..015, `GOGO_PLACE_INGESTION_SPEC.md` §3/§7
- **Supersedes nothing; extends** ADR-0004 (maps/place provider)

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

## Consequences

- Predictable provider spend; a bulk job of 5.000 rows costs `core`(+`quality`
  on accepted rows) rather than full details per row.
- Attribution/freshness are structural (columns + DTO fields), not a UI
  afterthought, so a licence audit is answerable from the database.

## Rollback

Tiers and thresholds are config; switching provider means a new adapter
behind the same port — ingestion logic is untouched.
