# ADR-0004: Maps/Place provider strategy

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** FND-001, BE-BFF-011, BE-BFF-013, BE-BFF-016, FR-PLACE-001..007

## Context

GoGo needs place resolution (Google Maps link import), area autocomplete, and geocoding. SRS mandates providers behind adapter interfaces, server-side keys only, license-compliant caching, and deterministic fallbacks.

## Decision

1. **Google Places API is the primary provider** (link resolve, place details, autocomplete) — it is the only provider whose data users share links from (FR-PLACE-001) and has the best Vietnam coverage.
2. Every provider call goes through interfaces in `libs/providers` (`PlaceProviderPort`, `AreaAutocompletePort`, …) with a **fake implementation** used in tests and whenever `GOOGLE_PLACES_API_KEY` is empty. No domain code imports a provider SDK.
3. **Key handling:** API key server-side only; autocomplete uses provider session tokens per typing session; per-route rate limits + Redis caching within Google's allowed caching window (place IDs cacheable indefinitely; details/atmosphere data not persisted beyond permitted TTL).
4. **Attribution** fields are stored alongside cached provider data and returned in DTOs so clients can render required attribution (FR-PLACE-006).
5. Resilience per NFR: timeout, retry with jitter, circuit breaker, and a static cached fallback list for area autocomplete.

## Consequences

- Provider swap or multi-provider dedup later means adding one adapter, no domain change.
- Cost control concentrated at the adapter (cache + session tokens + quota alerts).

## Amendment 2026-09-01 — decided map architecture, provider set, cost scope

Source: `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` §0.2 C1/C4,
§3 PR0. No runtime change ships with this amendment.

### 1. Map rendering: Google Maps SDK on iOS **and** Android

The product decision is one basemap vendor on both platforms. The original
decision above predates it and said nothing about map rendering; the mobile
client had Apple Maps on iOS by default.

- iOS: shipped — GoGo-MobileApp ADR 0005, APP-040 (GoGo-MobileApp#125, PR #126,
  `origin/develop 3a6277a`). `MapCanvas` selects `PROVIDER_GOOGLE` when the key
  is linked, `PROVIDER_DEFAULT` otherwise, so a missing key degrades to Apple
  Maps rather than to a blank screen.
- Android: outstanding — GoGo-MobileApp#127 (APP-041, `android.config.googleMaps.apiKey`)
  and GoGo-Infra#102 (INF-056, API enablement + key restricted by package name/SHA-1).
- Key handling: client keys, one per platform, restricted to the app identity;
  quota cap and billing alert under GoGo-Infra#15 (INF-015). Client map keys are
  a separate concern from the server-side Places key, which stays server-side.

### 2. Provider set

| Concern | API | Adapter |
|---|---|---|
| Place resolve / details / search / autocomplete | Places API (New) | `GooglePlacesAdapter` |
| Travel time | Routes API (`computeRouteMatrix`) | `GoogleRoutesAdapter` (ADR-0007) |
| Bulk import source | Google Sheets API | `GoogleSheetsAdapter` |
| Map rendering (client) | Google Maps SDK iOS/Android | mobile `MapCanvas` |

### 3. Decision §3 corrected: there is no provider response cache

Decision §3 above describes "Redis caching within Google's allowed caching
window". No such cache was ever built — `libs/providers/src` contains no cache
and no Redis client. What the system actually does is *persist* provider-derived
fields in Postgres (`places`, `place_provider_sources`, `place_hours`,
`place_sources.raw`, `place_ingest_rows.candidates`).

That is a storage question, not a cache-TTL question, and it is governed by
**ADR-0006 §9**, not by this ADR. The sentence in §3 is superseded: read it as
"place IDs may be stored indefinitely; every other Google field follows
ADR-0006 §9".

### 4. Cost Observability — operation / SKU scope

The operation label is the adapter's `method` label on
`places_provider_requests_total`. A billed SKU folds onto its operation
(`operationForSku`, `libs/modules/cms/domain/ops-metrics.ts`).

| Operation | Google SKU | Billable unit | Instrumented today |
|---|---|---|---|
| `google.searchText` | Text Search (mask-dependent) | request | yes |
| `google.details.liveness` | Details Essentials IDs-Only ($0) | request | tier lands in PR5 |
| `google.details.core` | Details Pro | request | yes |
| `google.details.quality` | Details Enterprise | request | yes |
| `google.details.detail` | Details Enterprise + Atmosphere | request | yes |
| `google.autocomplete` | Autocomplete Requests | request | yes |
| `google.routeMatrix` | `routes.computeRouteMatrix` (Routes Essentials) | matrix **elements** | yes |
| `google.sheets.meta` / `google.sheets.values` | Sheets API — free | — | yes |
| `google.expand` | none — HTTP short-link expansion, not a Places request | — | **no** — counter added in PR3 |
| `google.maps_sdk_ios` | Dynamic Maps | map load | **no — MEASUREMENT GAP** |
| `google.maps_sdk_android` | Dynamic Maps | map load | **no — MEASUREMENT GAP** |

**The two Maps SDK rows are reported as `instrumented = false` / MEASUREMENT
GAP, never as zero.** Zero is a measurement; absence of a collector is not. A
pricing row exists for them with `price = null` → UNKNOWN (PR2); telemetry is
PR11+ and needs the SDK live on both platforms plus client keys.

### 5. Open point (GoGo-BE#80) — closed here, conclusion recorded elsewhere

BE#80 was closed without recording a conclusion, so the "legal review of caching
windows" it carried was never answered. It is re-opened as the PR0 compliance
item and its answer lives in **ADR-0006 §9**. Production Google keys stay gated
on that amendment reaching `Accepted`.

## Open point (tracked on GoGo-BE#80)

Final Google Maps Platform contract/quota tier and the legal review of caching windows need a human decision before production keys are issued.
