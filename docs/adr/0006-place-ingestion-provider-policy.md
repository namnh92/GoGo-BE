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

## Consequences

- Predictable provider spend; a bulk job of 5.000 rows costs `core`(+`quality`
  on accepted rows) rather than full details per row.
- Attribution/freshness are structural (columns + DTO fields), not a UI
  afterthought, so a licence audit is answerable from the database.

## Rollback

Tiers and thresholds are config; switching provider means a new adapter
behind the same port — ingestion logic is untouched.
