# ADR-0022: Profile fields live on the account; avatars are processed server-side and served public and immutable

- **Status:** accepted (2026-09-09)
- **Date:** 2026-09-09
- **Deciders:** product owner, BE, Mobile
- **Implements** PROF-ADR-001 (#530), PROF-BE-001..007 (#531–#537), PROF-INF-001
  (GoGo-Infra#163), PROF-APP-000..005 (GoGo-MobileApp#175–#180)
- **Extends** GoGo-Infra ADR-0005 (image delivery: catalogue public, user media
  signed) with one more public prefix, `avatars/**`
- **Source spec:** `GOGO_ACCOUNT_PROFILE_EMAIL_OTP_SPEC.md` §6–§8 under the
  2026-09-09 scope override: profile only. OTP, passwordless, mail delivery and
  every auth change are out of scope and are not decided here.

## Context

A profile today is a display name and a locale. `GET /me` answers from the
identity module (`sessions.controller.ts`), `PATCH /me` from the reviews module
(`user-content.service.ts`), and the update spreads truthy values only, so a
field can never be cleared. Room members see `displayName`, `role`,
`selectionStatus`, `isGuest`, `joinedAt` and nothing else, which is the right
privacy baseline and the one this record keeps.

What the spec asks for — avatar, home area, interests, usual budget, and using
them as _defaults_ when a room is created — runs into four facts about the
codebase that a plan cannot paper over:

1. **There is no read path for user images.** `StoragePort` presigns a PUT and
   nothing else. GoGo-Infra ADR-0005 decided that user media is served by a
   presigned GET the BFF signs per request, but that GET was never built;
   check-in `photoKeys` are returned raw and no client renders them.
2. **There is no image processing stage.** Bytes go from the phone to the
   bucket and the API never sees them. The spec requires decode, resize and
   metadata stripping on the server.
3. **Consumer uploads never expire.** They land under `u/**` in the private
   bucket, which has no lifecycle rule (only `tmp/` and `imports/tmp/` do), and
   nothing purges a `media_uploads` row that stays `pending`.
4. **Two area vocabularies exist.** `room_constraints.area_key` holds either a
   Google autocomplete prediction key or a curated `service_areas.key`,
   depending on which path answered. A profile default must be stable and
   free to read, which only the curated table is.

## Options considered

### Avatar delivery

1. **Presigned GET per render**, as ADR-0005 prescribes for user media.
   Correct for a bill photo. Wrong for an avatar: every member list would sign
   N URLs, each URL rotates with its signature, and `expo-image` caches by URL,
   so a picture the app already holds is re-downloaded on every rotation.
2. **Public bucket, random immutable key.** A profile picture is shown to
   everyone in every room the person joins; it is public by the user's own
   choice, the way a picture on any profile is. The key carries no user id and
   128 bits of randomness, so a URL cannot be guessed or enumerated, and a
   replaced avatar gets a new key so nothing is ever overwritten in place.

### Processing

1. **Synchronous in the API** on `PUT /me/avatar`: fetch the original, decode,
   resize, write the public object, all inside one request with hard limits.
   The user sees the result when the request returns.
2. **Worker stage**: enqueue, process on the next tick, tell the client to poll.
   More moving parts for an operation that takes well under a second.

### Home area vocabulary

1. Whatever `area_key` a room used, Google prediction keys included.
2. `service_areas.key` only — curated, offline, grouped by city, no provider
   call, no cost.

### Cleanup

1. Best-effort delete after the response, nothing recorded when it fails.
2. A durable queue row written in the **same transaction** as the change that
   makes the object unreferenced, retried by the worker with the outbox
   backoff and dead-lettered after six attempts.

## Decision

- **Avatar delivery: option 2, public.** `avatars/**` joins `places/**` and
  `banners/**` as a public prefix of `gogo-<env>-public`. Every other user
  upload stays private and keeps ADR-0005's signed-GET rule for the day that
  read path is built.
- **Processing: option 1, synchronous in the API**, with the limits in §Avatar
  pipeline below.
- **Home area: option 2, `service_areas.key`**, exposed through a new public,
  cacheable `GET /service-areas`.
- **Cleanup: option 2, transactional queue.** No object becomes unreferenced
  without a queue row that says so.
- **Interests: `mood` only** in this wave. It is the one kind a room
  preference screen edits today. Dietary and accessibility are room
  constraints, not member preferences; adding them to a profile would store
  personal data nothing reads.
- **Usual budget: one per-person upper bound plus currency**, integer minor
  units. It prefills only a room whose budget mode is `per_person`.
- **Profile is a default, never a write.** Prefill is a chip the user taps in
  the create-room wizard or the preference screen; it fills an empty field and
  never touches a saved value or an existing room, so it can never trigger the
  constraint-change → stale rule.
- **Private DTO versus member DTO.** `GET /me` carries the whole profile.
  `RoomMember` gains `avatarUrl` and nothing else. The CMS user detail does not
  expose home area, interests or budget: no operational reader exists.
- **One module.** `libs/modules/profile` owns the profile columns,
  `user_profile_preferences` and the avatar endpoints. Identity's `GET /me`
  delegates its user branch; the reviews module keeps saved items, reviews and
  the privacy operations.
- **Deferred, not decided:** an optional avatar step after registration;
  interests beyond `mood`; an age field; Google/Apple sign-in and social
  linking.

## Data model (migration 0061, additive)

| Column / table                  | Type                                                                                                           | Notes                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `users.avatar_key`              | text, null                                                                                                     | key of the processed object in the public bucket     |
| `users.home_area_key`           | text, null, FK → `service_areas.key` on delete set null                                                        | curated area only                                    |
| `users.usual_budget_per_person` | bigint, null                                                                                                   | integer minor units, `>= 0`                          |
| `users.usual_budget_currency`   | char(3), not null, default `VND`                                                                               |                                                      |
| `user_profile_preferences`      | `user_id` PK → `users` cascade, `selections` jsonb `{kind: keys[]}`, `updated_at`                              | validated by the taxonomy check room preferences use |
| `media_cleanup_queue`           | `id`, `bucket`, `object_key`, `reason`, `attempts`, `next_attempt_at`, `failed_at`, `last_error`, `created_at` | one row per object that must disappear               |

Rollback is `drop` of the new columns and tables; production is forward-only
and a removal, if ever, is a later migration after a deprecation window.

## Avatar pipeline

### Access model

| Object           | Bucket                        | Key                                                   | Readable by                                                                 | Lifetime                                                                                |
| ---------------- | ----------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Original upload  | `gogo-<env>-assets` (private) | `tmp/avatars/<userId>/<uuid>.<ext>`                   | nobody outside the API; the API reads it once with a server-side signed GET | presigned PUT valid 15 min; the existing `tmp/` lifecycle rule deletes it after one day |
| Processed avatar | `gogo-<env>-public`           | `avatars/<random128>.webp` — no user id, no timestamp | anyone holding the URL, via `assets-<env>.gogo.id.vn`, no authentication    | until replaced or the account is deleted                                                |

The URL reaches a client only through `GET /me` for the owner and
`RoomMember.avatarUrl` for people who share a live room with them. The
server composes it from `MEDIA_PUBLIC_BASE_URL`; when that base is empty the
field is `null` even if a key is stored, so a client never receives a URL that
would 404.

### Ownership and purpose checks

- `POST /uploads { purpose: 'avatar' }` requires a `user` actor; guests get 403. Allowed types: `image/jpeg`, `image/png`, `image/webp`. HEIC is refused
  for this purpose because the prebuilt `sharp` cannot decode it; the client
  converts HEIC to JPEG before upload. Declared length ≤ 10 MB. The purpose
  decides the bucket and the prefix on the server; the client never chooses a
  key.
- `PUT /me/avatar { uploadKey }` reuses the existing `attach` rule verbatim:
  the row must exist, belong to this actor, carry purpose `avatar`, and be
  pending and unexpired — or already attached to this same user so a retry is
  idempotent. Every miss is `INVALID_UPLOAD_KEY` without saying which
  condition failed. Then the API fetches the object and checks the real length
  and that the decoded format matches the declared type; a mismatch is
  `AVATAR_UNPROCESSABLE`.
- Only the owner mutates their avatar. `DELETE /me/avatar` is idempotent and
  answers `avatarUrl: null`.
- Rate limit `me.avatar` 5/min per actor, on top of the existing 30/min
  presign limit.

### Processing limits

Decode is capped at 16 megapixels (`limitInputPixels`), so a 10 MB file
cannot expand into hundreds of megabytes. EXIF orientation is applied, then
the image is re-encoded to a 512×512 centre-crop WebP at quality 80 **without**
`withMetadata`, which is what drops EXIF, GPS and ICC. Per-image processing
timeout 3 s, whole request budget 10 s, at most 2 concurrent processings per
API process; excess answers `503 AVATAR_BUSY, retryable: true`. `sharp` runs in
the API process; the musl arm64 prebuilt is verified in the image build.

### Cleanup, transactional

The order is always database first, storage second, never inside the
transaction that holds the row lock.

- **Replace or remove:** the transaction that writes the new `avatar_key` (or
  null) also inserts a `media_cleanup_queue` row for the old public object and
  for the original in the private bucket. After commit the API attempts both
  deletes and the edge purge; on success it marks the row done, on failure the
  worker retries it.
- **Failed attachment:** when `PUT /me/avatar` fails after the original was
  uploaded — unreadable image, timeout, storage error — the request still
  commits a queue row for the original and, if a public object was already
  written, for that object too. A failed request never leaves an orphan the
  queue does not know about.
- **Account deletion** writes the queue rows inside the delete transaction.
- **Worker** retries queue rows on the existing periodic runner with the
  outbox backoff, dead-letters after six attempts, and reports
  `media_cleanup_pending` and `media_cleanup_dead_lettered`.
- **Pending uploads:** the privacy job deletes `media_uploads` rows still
  `pending` one day past `expires_at`, reported as `mediaUploadsPurged`. The
  `tmp/` lifecycle rule removes the bytes independently.
- Bucket-listing reconciliation is out of scope; the queue covers every path
  the code knows.

### Caching, and what purging does not do

Avatars are served with `Cache-Control: public, max-age=86400`, not the
year-long immutable header catalogue images carry, and a delete purges the
URL at the Cloudflare edge as a best-effort, retried step.

**Purging cannot revoke a copy a device already holds.** `expo-image`, a
browser, a chat client that unfurled a link — each keeps the bytes it fetched
until its own cache expires or is cleared, and no server-side action reaches
into those caches. What deletion guarantees is narrower and must be stated
that way to the user: the origin object is gone, the edge stops serving it
within the cache lifetime, and no _new_ fetch of that URL succeeds. That is
the same guarantee every public website makes about a removed image, and
nothing stronger is promised here.

### Upload availability is known before the picker opens

`GET /me` carries `capabilities.avatarUpload: 'available' | 'unavailable'`,
derived from the same condition that makes `POST /uploads` answer
`UPLOAD_NOT_CONFIGURED`. A client renders the avatar control disabled, with
the reason, before anyone chooses a photo. The server still enforces the
condition; the field exists so the UI does not present a control that would
fail after the user has already done the work.

## Contract (minor bump)

- `GET /me` user branch adds `avatarUrl`, `homeArea { key, name, city }`,
  `interests { mood: string[] }`, `usualBudget { perPerson, currency }`,
  `capabilities.avatarUpload`.
- `PATCH /me`: `null` clears an optional field, an omitted field is kept,
  `displayName` is never null. Existing clients that never send `null` are
  unaffected.
- `PUT /me/avatar { uploadKey }`, `DELETE /me/avatar`.
- `RoomMember.avatarUrl`, optional, users only.
- `GET /service-areas`, public, cacheable: `key`, `name`, `city`.
- `POST /uploads` purpose enum gains `avatar`.

## Consequences

- One more public prefix and a second set of R2 credentials in the API,
  scoped to the public bucket; the private credentials keep no write access to
  it. Both are named in GoGo-Infra's manifest by PROF-INF-001.
- `sharp` becomes a runtime dependency of the API image. The pnpm build
  allow-list and the Dockerfile's native toolchain already exist for `argon2`.
- Export includes the new fields; delete nulls them, drops the preference row
  and enqueues the objects. The CMS reads none of it.
- The two-vocabulary problem for `area_key` is not solved here; the profile
  simply refuses to inherit it.

## Migration & rollback

Additive migration first, BE deploy, then the mobile build. No feature flag
is needed: where storage is not configured the avatar path answers
`UPLOAD_NOT_CONFIGURED` and the client shows the control disabled, exactly as
uploads behave today. Rollback is the previous image; the columns stay, avatar
objects stay and the queue keeps draining; no data is reverted.

## Recorded auth debt (out of scope, not fixed by anything here)

Found during the review that produced this record. Listed so the next person
does not rediscover them; none is approved for work.

- Register answers 409 for an existing address and 201 for a new one, an
  account-enumeration oracle (`identity/application/auth.service.ts:57`).
- No password reset or change endpoint exists anywhere.
- `users.email_verified_at` has no writer; the CMS campaign test-send that
  requires it (`campaigns.service.ts:437-441`) is unreachable in any real
  environment.
- Guest claim on registration swallows an invalid token and the mobile app
  never sends one (`auth.service.ts:70-71`).
- Register is check-then-insert; a concurrent duplicate surfaces as a 500.
- Notification channel `email` exists in the contract with no transport.
- Vendored contract copies in Mobile and CMS declare `1.0.0-alpha.1`.
