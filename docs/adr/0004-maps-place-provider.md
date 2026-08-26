# ADR-0004: Maps/Place provider strategy

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** FND-001, BE-BFF-011, BE-BFF-013, BE-BFF-016, FR-PLACE-001..007

## Context

GoGo needs place resolution (Google Maps link import), area autocomplete, and geocoding. SRS mandates providers behind adapter interfaces, server-side keys only, license-compliant caching, and deterministic fallbacks.

## Decision

1. **Google Places API is the primary provider** (link resolve, place details, autocomplete) — it is the only provider whose data users share links from (FR-PLACE-001) and has the best Vietnam coverage.
2. Every provider call goes through interfaces in `libs/providers` (`PlaceProviderPort`, `AreaAutocompletePort`, …) with a **fake implementation** used in tests and whenever `GOOGLE_MAPS_API_KEY` is empty. No domain code imports a provider SDK.
3. **Key handling:** API key server-side only; autocomplete uses provider session tokens per typing session; per-route rate limits + Redis caching within Google's allowed caching window (place IDs cacheable indefinitely; details/atmosphere data not persisted beyond permitted TTL).
4. **Attribution** fields are stored alongside cached provider data and returned in DTOs so clients can render required attribution (FR-PLACE-006).
5. Resilience per NFR: timeout, retry with jitter, circuit breaker, and a static cached fallback list for area autocomplete.

## Consequences

- Provider swap or multi-provider dedup later means adding one adapter, no domain change.
- Cost control concentrated at the adapter (cache + session tokens + quota alerts).

## Open point (tracked on GoGo-BE#80)

Final Google Maps Platform contract/quota tier and the legal review of caching windows need a human decision before production keys are issued.
