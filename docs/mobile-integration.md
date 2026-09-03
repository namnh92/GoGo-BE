# Mobile ↔ API integration (GoGo-MobileApp)

**Contract:** `GET /v1/openapi.yaml` (the deployed spec) · **Swagger UI:**
`GET /v1/docs`. The spec's description block is the primary guide — this file
only covers what belongs to the client side of the wire.

## 1. Generate, don't hand-write

```bash
# in GoGo-MobileApp
npx openapi-typescript https://<api-host>/v1/openapi.yaml -o src/shared/api/schema.d.ts
```

Pair with a typed fetch wrapper (`openapi-fetch`). CI in GoGo-BE publishes the
same pair (`gogo-api-contract` artifact: spec + generated types) on every run —
pin a BE commit and download it rather than copying files by hand. Hand-written
DTOs are the one thing guaranteed to drift.

## 2. Token handling (the part that bites)

| Rule                                                                              | Why                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Store `accessToken` + `refreshToken` in **Keychain/Keystore**, never AsyncStorage | tokens are credentials (`.claude/rules/security.md`)                                                 |
| Access token ≤15 min — refresh on `401`, not on a timer you trust                 | server clock wins                                                                                    |
| **Serialise refresh behind one mutex**                                            | refresh tokens are single-use; two parallel refreshes replay an old token                            |
| Replaying an old refresh token **revokes the whole session family**               | theft detection — the user gets logged out of every device                                           |
| Persist `guestToken` for guests                                                   | lets them re-enter the room; `POST /auth/refresh` with `{ guestToken }` returns a fresh access token |
| On registration send the stored `claimGuestToken`                                 | migrates guest memberships/preferences/votes into the account                                        |

Cookies and the CSRF header exist for Web only — mobile ignores both.

## 3. Idempotency on retry

Every retryable mutation takes `Idempotency-Key` (8–128 chars, e.g. a UUID
generated once per user action and reused across retries):

- replay → same response + `x-idempotent-replay: true`
- same key, different body → `422 IDEMPOTENCY_KEY_REUSED`
- failed request releases the key, so a corrected retry works

Use it on: create room, cast vote, plan edit/regenerate, check-in, place
submission. Do **not** generate a fresh key per retry — that defeats it.

## 4. Rendering rules the API deliberately pushes to the client

- **Money is integer minor units.** `250000` → `250.000 ₫`. Never floats.
- **Copy is composed client-side.** DTOs ship `type`, `participantCount`,
  `budgetMode` — never "Cả hai bạn…". Build audience strings from those facts
  so i18n stays in the app.
- **Opening hours are minutes-of-day, place-local.** `open.closesAtMinute:
1380` → "Đang mở · Đóng 23:00".
- **Prices are ranges with confidence.** Show a range, never a fake exact
  number. `totals.overBudget` comes from the _upper_ bound; `totals.uncertain`
  means some stop's price is unknown — say so instead of implying certainty.
- **Provider attribution is mandatory** wherever Google-sourced facts appear
  (`sources[]`, `candidate.attributions[]`). Google rating, GoGo rating and
  the derived score are separate fields — do not merge them into one star row.
- **Taxonomy keys are stable; labels are not.** Store `key`, render
  `labels[locale]` from `GET /v1/taxonomies`. Never persist a display label.

## 5. Drive the UI from server state, not local flags

`room.status` (`draft → collecting → matching → ready → active → completed`)
decides what is legal. Attempting an action outside the state returns `409`
(`ROOM_NOT_MATCHING`, `ROOM_ACTIVE`, `ROOM_NOT_COLLECTING`). Roles are enforced
server-side: a member calling a host action gets `403 HOST_ONLY`, a guest
touching another room gets `403 ROOM_SCOPE_VIOLATION`. Hide the button _and_
handle the error — the API is the enforcement layer.

Optimistic concurrency: `preferences` (`expectedVersion`), `constraints`
(`expectedConstraintVersion`), `plans` (`expectedVersion`). On `409` reload and
re-apply — do not retry blindly.

## 6. Error handling

Branch on `code`, never `message`. Show `request_id` in the debug/report path.
`retryable: true` (429/5xx) → exponential backoff with jitter.

Codes worth explicit UI: `INVALID_CREDENTIALS`, `SESSION_REVOKED`,
`GUEST_SESSION_EXPIRED`, `ROOM_NOT_JOINABLE`, `ROOM_EXPIRED`,
`INVITE_NOT_USABLE`, `HOST_ONLY`, `NOT_A_MEMBER`, `ROOM_SCOPE_VIOLATION`,
`PREFERENCE_VERSION_CONFLICT`, `PLAN_VERSION_CONFLICT`, `NOT_A_CANDIDATE`,
`BILL_PHOTO_REQUIRED`, `PLACE_CLOSED`, `RATE_LIMITED`.

## 7. Flow cheat-sheet

| Screen       | Calls                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Create room  | `POST /rooms` → `PATCH /rooms/{id}/status` `collecting`                                        |
| Invite sheet | `POST /rooms/{id}/invites` → share `code` (returned once — never re-fetchable)                 |
| Guest join   | `POST /rooms/join/guest` `{ inviteCode, displayName }`                                         |
| Preferences  | `GET/PUT /rooms/{id}/preferences/me` (autosave w/ `expectedVersion`) → `POST …/complete`       |
| Lobby        | `GET /rooms/{id}/members` (progress only — never other members' selections)                    |
| Search       | `GET /places/search` (q, geo, `openAt`, `categories`, price/person, `suitedFor`, cursor)       |
| Place detail | `GET /places/{id}`                                                                             |
| Add by link  | `POST /places/resolve-google-maps-link` → preview → `POST /place-submissions`                  |
| Matching     | `POST /rooms/{id}/suggestions` → `GET …/suggestions/current`                                   |
| Vote         | `PUT /rooms/{id}/votes/{placeId}` → host `POST …/votes/finalize`                               |
| Plan         | `GET /rooms/{id}/plans/current`, `PATCH /plans/{id}`, `POST /plans/{id}/regenerate`, lock stop |
| Active date  | `PATCH /rooms/{id}/status` `active` → `POST /plans/{id}/stops/{stopId}/complete` → `…/checkin` |
| Profile      | `GET/PATCH /me`, `/me/saved`, `/me/reviews`, `/me/notifications`, `PUT /me/device-tokens`      |

Directions: build the universal URL client-side —
`https://www.google.com/maps/dir/?api=1&destination=<lat,lng|address>`. No
in-app navigation (FR-PLAN-010).

## 8. Not available yet (mock these)

- **Photo upload for check-ins**: `photoKeys` are opaque storage keys; the R2
  presigned-upload endpoint is blocked on credentials (GoGo-BE#60/#81). Until
  then send `photoKeys: []` or a placeholder key in dev.
- **Push delivery**: `PUT /me/device-tokens` accepts and stores tokens; FCM/APNs
  adapters land with credentials (GoGo-BE#59/#60).
- **Realtime suggestion progress**: runs are synchronous today; SSE progress
  arrives with BE-BFF-010's async pipeline. Poll `…/suggestions/current`.
- **Bulk import / Sheets**: CMS-side only (PI-BE-011..017), no mobile surface.

## 9. Provider usage telemetry (APP-044, contract for GoGo-MobileApp#134)

The backend cannot count a Maps SDK map load — the SDK draws on the handset,
nothing reaches the API. `POST /v1/telemetry/provider-usage` is where the app
reports it, so the cost screen stops showing a MEASUREMENT GAP (GoGo-BE#387,
Cost Observability epic §18).

```jsonc
POST /v1/telemetry/provider-usage
Authorization: Bearer <access token>      // a guest session is enough
Idempotency-Key: <8–128 chars>            // retries replay, they do not re-count

{ "events": [ {
  "providerId":    "google",
  "serviceId":     "google.maps_sdk_ios",   // or google.maps_sdk_android
  "usageMetricId": "map_loads",
  "quantity":      1,
  "occurredAt":    "2026-09-03T09:59:00Z",
  "platform":      "ios",                   // one platform per batch
  "appVersion":    "1.4.2"
} ] }
```

Rules the client has to honour, each with a reason:

- **One event per `map-canvas` mount**, not per pan or zoom (epic §18). A deck
  that emits per gesture is a bug, and it is also money.
- **Batch, up to 100 events.** Flush every 60 seconds and on background. One
  request is one flush.
- **Send `Idempotency-Key` per flush, and re-send the identical body on retry.**
  These rows _add_ server-side; the key is what makes a retry safe, and it keys
  on the body as well, so a rebuilt batch with fresh timestamps is a new batch.
- **Send nothing else.** Unknown properties are rejected with `400
VALIDATION_FAILED` — no place id, no coordinates, no URL, no session or
  tracking id, ever.
- **Read the flag before emitting.** `mobile_provider_usage.enabled` is
  platform-scoped; the response's `enabled: false` means nothing was recorded
  and the uploader should stop rather than retry.
- **Events older than 3 days, or more than 6 hours in the future, are
  discarded** individually and reported in `rejected[]`. Hold events while
  offline, but drop your own backlog past 3 days rather than sending it.

Response:

```jsonc
{ "enabled": true, "accepted": 2, "discarded": 0, "rejected": [], "quantity": 10 }
```

`429` means the rate limit (12 requests/min per actor+IP, 5 per 10s) — back
off, do not tighten the flush interval. `quantity` is capped at 100 per event.
