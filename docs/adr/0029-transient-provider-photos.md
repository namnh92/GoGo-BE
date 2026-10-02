# ADR-0029: Transient Google photos on Place Detail; no provider price range

- **Status:** accepted (owner decision 2026-10-02 on GoGo-BE#509; shape by SA review, Astra)
- **Date:** 2026-10-02
- **Deciders:** owner (product), SA (shape), DEV (implementation)

## Context

GoGo-BE#509 (PI-BE-027) found two Google fields bought and discarded: `photos`
on every `core` Details call and `priceRange` on every `quality` call. The owner
first asked to store and show both. SA review rejected durable storage: Google
forbids caching photo names, storing a reference is not a workaround for
storing bytes, ADR-0020's exception covers only enumerated facts on one
creation path, and the repo rule "no new persistent Google content" is
permanent. `priceRange` has monetary bounds and no consumption unit, so core
rule 13 ("a price never leaves its unit behind") forbids rendering it.

## Options considered

1. **Persist photos/price** (names, URLs or bytes in DB/R2/Redis) — rejected:
   conflicts with Google's terms and the permanent persistence freeze.
2. **Drop both, show nothing** — no conflict, but no Google imagery at all.
3. **Transient display** — fetch on Place Detail open, return once, store
   nothing; suppress the unscoped price. Chosen.

## Decision

- Photos: `GET /v1/places/{id}/provider-photos`, detail-only, never per list
  card. Within one request: `google.details.photos` (mask `id,photos`, Place
  Details Essentials IDs Only, free) → up to three `google.photoMedia` calls
  (Place Details Photos, $7/1k) → image bytes read from the returned URL
  (validated `https` on a Google image host, no key, no redirects, ≤400 KiB,
  jpeg/png/webp) → base64 in the response with structured per-photo
  `authorAttributions{displayName,uri,photoUri}` and `googleMapsUri`, plus
  "Google Maps" attribution. `Cache-Control: private, no-store`. Photo names,
  URLs and bytes are written nowhere (DB, R2, Redis, jobs, snapshots).
- Bounds: kill switch `place_provider_photos.enabled` (default off,
  `FLAG_PLACE_PROVIDER_PHOTOS`), default-deny daily budget scope
  `google.places.display` reserving one unit per billed media call, 2.5 s
  per-call timeout with no retry, 6 s overall deadline, 30/min/IP rate limit.
  Every failure answers 200 with no photos and a `status`; Place Detail is
  independent.
- A place whose Google id answers as a different (moved) id shows no provider
  photos.
- `priceRange`: removed from the `quality` mask, never mapped, never exposed.
  GoGo prices (`place_prices`) are unchanged.
- `photos` removed from the `core` mask; `ResolvedProviderPlace.photos`
  removed. Ingestion never asks for photos.
- The `detail` tier comment is corrected: no production caller exists.

## Consequences

- Each Place Detail view with photos enabled costs up to 3 × $0.007 at list
  price; tracked as `google.photoMedia` on the cost ledger and capped by the
  budget. Latency is added to the photo request only, not to Place Detail.
- base64 adds ~33% payload overhead on a bounded response.
- Removing `photos`/`priceRange` does not lower the `core`/`quality` SKU.
- Clients (Mobile) must render each photo's credit with it, must not keep the
  bytes in a disk/offline cache or persisted query state, and must not call
  Google directly. Mobile display is a follow-up.
- A numeric Google price would need an explicit rule-13 exception; none exists.

## Migration & rollback

No migration, no event. Contract: new path + schemas (`1.0.0-alpha.62`),
additive. Rollback: flag row `enabled = false` (instant), or revert the PR —
nothing was stored, so nothing has to be cleaned up.
