# GoGo `/v1` contract changelog

Consumers vendor `openapi/gogo.v1.yaml` and generate their client from it, so a
changed guarantee has to be readable without diffing 700 KB of YAML. One entry
per contract version that changes a published guarantee; a version that only
adds optional fields or new paths does not need one.

Version numbers follow `git.md` SemVer: MAJOR when a published guarantee is
withdrawn, MINOR for backward-compatible additions, PATCH for fixes.

## 6.2.0-alpha.1 — CMS amenity filtering (GoGo-BE#779)

`GET /cms/places` accepts optional CSV `amenities`, with the same semantics as
public `/places/search`: ALL selected active taxonomy keys of kind `amenity`
must match, while `cashless_payment` means card OR QR. Lists are trimmed,
deduplicated and limited to 10 distinct keys of at most 64 characters; empty
entries are ignored. Unknown, inactive and wrong-kind keys return 400
`INVALID_TAXONOMY_KEYS` in the existing error envelope (`selections.amenity`
field errors); malformed lists return `VALIDATION_FAILED`.

The filter intersects with category, status and the other existing list filters
before keyset pagination. Sort order, cursor format and response shape stay the
same. No schema migration is needed. Rollback: stop sending `amenities` before
rolling the API back. Consumers regenerate their CMS client from this contract.

## 6.1.0-alpha.1 — CMS AI credit inspection (GoGo-BE#778)

**Additive MINOR** from 6.0.0-alpha.1. `GET /cms/users/{id}/assistant-credits`
returns minimal user identity (`id`, `displayName`), current full credit balance,
and a cursor-paginated ledger of signed deltas, reason codes and source references.
Only `ops_admin` and `super_admin` may read it. Every successful read is audited
without copying credit data into the audit. No email, message, usage ledger ID,
submission note or provider content is returned.

Balance and ledger page share one statement snapshot. Pages sort descending by
exact microsecond timestamp and UUID; cursors are opaque and user-scoped. Balance
may change between pages and is not a page subtotal. Unknown users return 404;
users without an account row have zero credits and empty history. Erased user
linkage is not reconstructed. Immutable submission/venue references survive source
deletion; `placeId` is nullable and resolves only through the surviving submission.
No credit mutation, historical award or schema migration is introduced. Consumers
must regenerate from this version; Astra and mapped CODEOWNER review are required.

## 5.1.0-alpha.1 — consumer password recovery (GoGo-BE#772 / GoGo-MobileApp#482)

**Additive recovery endpoints:** public `POST /auth/password-recovery/request`
returns a generic 202 with challenge UUID, expiry and resend time, without
confirming eligibility or delivery. Active password accounts may recover even
with unverified email; missing, guest, passwordless, suspended, banned and deleted
accounts receive the same response shape. Account-specific delivery errors stay
202 and invalidate that challenge. Six-digit proofs expire after 300 seconds,
allow five failed attempts and are replaced on resend after a 60-second cooldown.

`POST /auth/password-recovery/complete` applies the registration password policy
from 5.0.0-alpha.1 and returns an empty 204; sign in again. Success verifies email
if needed, revokes all consumer sessions across families and their refresh tokens,
and clears login lockout. It issues no session and moves no account history.
Invalid, expired, exhausted, superseded, consumed and ineligible proofs share
400 `RECOVERY_INVALID`; password errors retain `VALIDATION_FAILED` field errors.

Both operations support durable 24-hour idempotency scoped to operation, IP and
key; changed normalized bodies return 422 `IDEMPOTENCY_KEY_REUSED`. Limits count
replays and ineligible identities: request 1/minute + 3/hour/email and
10/minute + 50/hour/IP; complete 10/15 minutes/email and 30/15 minutes/IP.
Request cooldown also precedes replay. Refusals use 429 `RATE_LIMITED` and the
refusing window's `Retry-After`.

**Existing-route authentication behavior changes even with recovery mail
disabled.** Consumer AuthGuard now checks session presence, ownership and
revocation in the authoritative database on existing protected routes, and fails
closed when that database cannot answer. Deployments therefore need database
read availability for these consumer requests independently of recovery enablement.
Operational connection failures, PostgreSQL restart/unavailability, connection
exhaustion and known pool/query timeouts (including wrapped driver causes) return
503 `SERVICE_UNAVAILABLE`, `retryable: true`. SQL/schema, permission/configuration
and unexpected programming errors retain existing handling. No cached negative
result authorizes during an outage; driver diagnostics are not emitted in this
mapped response.
Superseded access sessions remain accepted; guest and CMS guard behavior is unchanged.
This existing-route change requires a release entry under the published-guarantee
rule above; the release is not limited to new paths.

Recovery mail itself is sink-only in explicitly configured dev/test deployments;
production and staging recovery remain disabled with typed 503 configuration
errors until real mail and shared fail-closed quotas are configured. The sink
provides no real delivery or public code retrieval.

## 5.0.0-alpha.1 — consumer registration password policy (GoGo-MobileApp#482)

**Breaking**, authorized by the owner on 2026-11-06 for re-design group 01,
screen S56. Registration now requires 8–128 UTF-16 code units, including a
Unicode uppercase letter (Lu), lowercase letter (Ll), ASCII digit (0–9), and
a special character outside Unicode letters, numbers and marks (L/N/M).
Whitespace and emoji qualify as special characters; combining marks do not.
Length keeps the existing login cap; supplementary characters use two units.
Passwords are neither trimmed nor normalized. Vietnamese `Đ` and `ă` count
as uppercase and lowercase. The minimum falls from 10 to 8, but composition
rejects some previously accepted passwords, hence the MAJOR bump.

Consumers must update sign-up validation and hints. Read the existing 400
`VALIDATION_FAILED` envelope and `field_errors[].field === "password"` for a
policy failure; no error code or envelope field was added. Login validation
and stored credentials are unchanged: existing passwords still authenticate.
CMS admin password rules are unchanged. See ADR-0039.

## 4.0.0-alpha.10 — suggestion origin and plan next-leg travel (GoGo-BE#756)

**Additive.** Suggestion candidates gain optional `travelMinutesFromOrigin`
and `travelDistanceMFromOrigin`; `SuggestionsCurrent.travelEstimated` says
whether any returned origin leg is a straight-line estimate. The fields are
omitted when the room has no current eligible origin, including after privacy
retention clears it. Existing authorization still scopes the origin to room
members. Provider routing has independent per-room and per-actor cost ceilings;
reads beyond either ceiling use the estimate fallback, and provider route
results are not persisted.

Every plan stop also gains optional nullable `travelMinutesToNext` and
`travelDistanceMToNext`, projected from the next stop's existing stored
from-previous leg. The final stop returns null for both. Existing
`travelMinutesFromPrev`, `travelDistanceMFromPrev` and plan totals are
unchanged.

## 4.0.0-alpha.9 — pre-join invitation facts (GoGo-BE#758)

**Additive.** New public `POST /rooms/invites/preview` accepts the opaque invite
code in its body and returns only the facts needed before joining: inviter room
display name, public avatar and verified-email boolean; room type and participant
count; optional UTC start/end, verified area label and integer-minor-unit budget.
It returns no ids, email address, invite code, exact origin or member data, and
does not consume an invite use. Invalid or unusable invitations retain the join
flow's existing 404/410 answers.

## 4.0.0-alpha.8 — saved-plan condition versions (GoGo-BE#759)

**Additive.** Plan rows from `GET /me/saved` gain optional
`conditionsChanged`, `planConstraintVersion` and `currentConstraintVersion`.
The boolean is true only when the room's current constraint version is newer
than the one used to build that saved plan; clients compose warning copy from
these facts. The fields are omitted for places, missing plans and plans the
caller can no longer read. Existing saved-item fields and ordering are
unchanged.

## 4.0.0-alpha.7 — per-member vote status (GoGo-BE#760)

**Additive.** `SuggestionsCurrent.votes` gains optional `members`, listing each
active room member's `memberId`, co-member-visible `displayName` and
`hasVoted`. The boolean reports whether that member has at least one vote in
the same vote set aggregated by `votes.progress`; it never exposes another
member's ballot. Existing vote progress and candidate fields are unchanged.

## 4.0.0-alpha.6 — per-option match and like facts (GoGo-BE#755)

**Additive.** Every current `SuggestionCandidate` gains optional `matchScore`
(the existing normalized deterministic `score`, explicitly named for match
results) and `likedByCount` (members whose current vote is `yes` or `star`).
The existing candidate score, vote points and `votes.progress` breakdown stay
unchanged; clients compose display copy from these facts.

## 4.0.0-alpha.5 — GoGo ratings on place lists and review-page facts (GoGo-BE#754)

**Additive.** `PlaceSearchResult`, place `SavedItem` rows and
`SuggestionCandidate` gain optional `gogoRating` and `gogoRatingCount`. The
fields describe moderator-published GoGo reviews only and stay separate from
Google's `rating`/`ratingCount`; below five reviews the count remains and the
GoGo score is omitted.

`GET /places/{id}/reviews` keeps the required legacy `reviews` property capped
at three rows and now accepts opaque cursor pagination. When pagination input
is sent, the optional `items` property carries up to 20 rows. Its response also
gains the all-review aggregate, `nextCursor`, per-review `verifiedVisit` (an
approved check-in, not merely content moderation).

## 4.0.0-alpha.4 — notification rows carry display facts (GoGo-BE#753)

**Additive.** `Notification.payload` gains optional `roomName`, `inviterName`,
`preferenceProgress`, `stopCount`, `planChange`, `title` and `body`. These are
facts for clients to compose localized inbox copy: preference progress is
aggregate only, plan changes are structured, and campaign copy remains the
CMS-authored title/body. Plan changes include event-time total/optional counts
and aggregate added, removed, moved, duration, lock and optionality changes;
all remain optional for rows written before these facts existed. `campaign` is now declared in the extensible
`NotificationKind` list. Existing payload and cursor fields are unchanged.

## 4.0.0-alpha.3 — own-review rows identify their target (GoGo-BE#752)

**Additive.** `GET /me/reviews` now returns `MyReview`: the existing `Review`
fields plus required `helpfulCount` and optional independently sourced GoGo
`placeName`, verified GoGo-owned `placeAddressText`, `planTitle`, `planScheduledDate`,
and `rejectionReason`. Private room facts require the caller's active room
membership and are omitted for non-members and removed members. Target facts
are read in batches; no Google content is fetched or persisted. Review
create/update responses remain `Review` and are unchanged.

## 4.0.0-alpha.2 — review mutations return their stored rating (GoGo-BE#751)

**Fix.** `POST /reviews` and `PATCH /reviews/{id}` now return the required
`Review.rating` alongside `id` and `status`. An update that omits `rating`
returns the review's unchanged stored score. Requests and all other response
fields are unchanged.

## 4.0.0-alpha.1 — campaign audience `public`, device push identity (GoGo-BE#747)

**Breaking for readers of CMS campaigns.** `CampaignAudience` gains `public`, so
`audienceType` in a response can hold a value the previous contract excluded. A
client that fails on an unknown value must learn it first; GoGo-CMS does in
GoGo-CMS#270. Campaigns on any other audience are unaffected. MAJOR by owner
decision 2026-11-04, with the exact pair of contract files recorded in
`.github/oasdiff-exceptions.json`.

Added: `POST`/`DELETE /notifications/identity/device`,
`POST /notifications/identity/device/token`,
`PUT /notifications/device-subscriptions` (device credential, not a session) and
`GET /cms/campaigns/capabilities`. `CmsCampaign` gains `deviceRecipientCount`,
`deviceSentCount` and `deviceFailedCount`; the audience estimate gains
`estimatedAccounts` and `estimatedDevices`, with `estimatedRecipients` their sum.
Off by default per environment (ADR-0038).

## 3.0.0-alpha.1 — taxonomy labels are one line of plain text (GoGo-BE#737)

**Breaking for writers of taxonomy labels.** `cmsCreateTaxonomy` and
`cmsUpdateTaxonomy` now refuse labels they used to accept (`labels` values were
any string; the server already refused more than 80 characters). As sent, a
label may contain letters, combining marks, digits, space separators and
`' " ‘ ’ “ ” ( ) & + , . / - – —` — the request `pattern`. The server then
normalises it (NFC, every space separator to one ASCII space, runs collapsed,
leading and trailing spaces removed) and requires 1–80 code points; anything
else, newlines, tabs, a BOM, markup or template delimiters included, is
refused with `400` and nothing is stripped or truncated. A request the pattern
accepts can still be refused when it is empty or longer than 80 code points
after normalisation. MAJOR because a published guarantee (any string) is
withdrawn (`git.md` SemVer). Why: labels are shown to people and read by the
assistant's models as data, so a label must not carry a second line or a block
delimiter. The response schema (`TaxonomyList`) is unchanged; labels stored
before this version were checked on DEV (42/42 conform) but are not
re-validated. Owner decision 2026-10-31 (option B, rule from Astra).

## 2.0.0-alpha.3 — GoGo AI: SA decisions applied (GoGo-BE#713)

**Additive.** oasdiff reports no breaking change (5 info findings). The owner
delegated Astra's SA answers on GoGo-BE#713; this version writes them into the
contract. Every `/assistant/*` operation is still `x-gogo-planned`.

- **Limits (`AssistantStatus`, send, `AssistantRateLimited`).** Defaults are
  now stated: per account, 30 accepted messages per day and 5 in any rolling
  minute; the day resets at midnight Asia/Ho_Chi_Minh; idempotent replays
  consume nothing; an unset limit refuses (`503 ASSISTANT_DISABLED`), never
  unlimited. New optional `AssistantStatus.messagesPerMinuteLimit`. Defaults
  are provisional and configurable — **read both limits from
  `GET /assistant/status`, never hardcode them.**
- **`truncated` status.** Added to `AssistantMessageStatus` and
  `AssistantStreamDone.status` (both `x-extensible-enum`, so an older client
  already treats it as an unknown finished value). The hard ceiling was hit:
  partial text persisted, unfinished structured outputs discarded. Clients show
  "Reply cut short" with an explicit retry; no automatic continuation.
- **Export.** `GET /me/export` and `POST /me/exports/{id}/download` now
  reference a new `UserExportDocument` (still `additionalProperties: true`)
  with an optional `assistantConversations` section
  (`UserExportAssistantConversation`, `UserExportAssistantMessage`): titles,
  role, text, timestamps, terminal status, the account's own feedback. Never
  internal prompts, retrieval internals or upload keys; attachments excluded
  pending owner approval. **Absent until the assistant module lands** — treat
  absent and `[]` alike.
- **`PUT /cms/feature-flags/{key}` takes `reason`** (string, trimmed, 3–500),
  recorded in the `feature_flag.set` audit entry. **Optional in this version**
  so older writers keep working; it will become required in a later version
  (a breaking change, announced here first). The CMS should send it on every
  flag write now. Served today: an out-of-bounds reason is
  `400 VALIDATION_FAILED` on `reason`.
- **`GET /cms/assistant/feedback` roles.** `moderator`, `ops_admin`,
  `super_admin` only — an explicit exception to the hierarchical read rule;
  `editor` is refused. Guide documents stay hierarchical. Read-only in v1; it
  never shows the user's own question (known limitation stated on the
  operation).

## 2.0.0-alpha.2 — GoGo AI assistant, declared ahead of its module (`x-gogo-planned`)

**Additive.** 24 new operations, all tagged `assistant` and marked
`x-gogo-planned: GoGo-BE#713`: `/assistant/*` (conversations, messages, the
reply stream, stop, feedback, proposals and confirm) and
`/cms/assistant/*` (the "GoGo guide" source documents with versions,
publish / unpublish, and the feedback queue). `POST /uploads` accepts a new
`purpose: assistant_image`. Nothing existing changed.

- **New guarantee — planned operations.** An operation carrying
  `x-gogo-planned: <issue>` is in the contract so clients can generate
  against it (GoGo-MobileApp#378, GoGo-CMS#249) but is **not served yet**: a
  deployed API answers `404`, and `assistant_image` uploads are refused, until
  the module PR lands. That PR removes the marker; `pnpm api:routes` fails
  while a served operation still carries it, and still fails any unmarked
  operation that is not served. A consumer must not ship a user-facing
  surface that depends on a planned operation without its own feature gate.
- **Reply stream.** `GET /assistant/conversations/{id}/messages/{messageId}/stream`
  is SSE in the same style as `GET /rooms/{id}/events` (bearer auth, opaque
  `id`, `Last-Event-ID` resume, `: ping` keep-alive). Read the `event:` name
  before parsing `data`; it equals `data.type` (`AssistantStreamEvent`).
  Unknown event names must be ignored, not treated as errors — new ones may be
  added under this MINOR line.
- **Error codes introduced:** `USER_ONLY` (guest, reused), `ASSISTANT_DISABLED`
  (503, kill switch), `ASSISTANT_DAILY_LIMIT` / `RATE_LIMITED` (429 with
  `Retry-After`), `ASSISTANT_TURN_IN_PROGRESS`, `CONTEXT_NOT_FOUND`,
  `ATTACHMENT_INVALID`, `PROPOSAL_NOT_PENDING`, `PROPOSAL_EXPIRED`,
  `DOCUMENT_SLUG_TAKEN`, `REVISION_CONFLICT`, `VERSION_NOT_FOUND`,
  `VERSION_ALREADY_PUBLISHED`, `DOCUMENT_NOT_PUBLISHED`.
- **Design:** `docs/assistant.md`. Shipped in: GoGo-BE#713 PR 1 (contract only).

## 2.0.0-alpha.1 — `GET /v1/rooms/{id}/events` carries two frame shapes

**Breaking.** The SSE response of `GET /v1/rooms/{id}/events` is a `oneOf`: a
domain-event envelope, or `RoomEventResync { roomId, reason, checkpoint }`. The
previous schema described every frame as the domain-event envelope, so a client
generated from `1.0.0-alpha.*` may treat the envelope's fields as guaranteed —
they are absent on a `resync` frame.

- **What a consumer must do:** read the SSE `event:` name before parsing
  `data`. `event: resync` carries `RoomEventResync`, never a domain event. On a
  resync the client refetches authoritative room state and, **only after that
  refetch succeeds**, resumes from `checkpoint.cursor` — the opaque cursor, not
  the `checkpoint` object, and never a cursor built from `generation` and `seq`,
  which are informational (`RoomEventCheckpoint`). An unknown `reason` is
  treated exactly like a known one: refetch.
- **Why it is a MAJOR and not a schema fix:** the `resync` control frame already
  existed on the wire (ADR-0027 made it reliable and gave it the checkpoint); the
  published schema was wrong about it. Withdrawing the envelope guarantee is a
  real break for a generated client even though the server behaviour it describes
  got stricter, not looser.
- **Shipped in:** PR #666 (GoGo-BE#638), contract `1.0.0-alpha.65`. The
  breaking-change gate was red on that head and skipped on the push to
  `develop`, so the change landed without the gate ever passing (GoGo-BE#694).
  This version is where the break is _named_: the decision was to keep the
  `oneOf` (SA ruling on #694, owner decision 2026-10-16), record it here and in
  ADR-0027, and admit the historical oasdiff finding through
  `.github/oasdiff-exceptions.json` — not to reshape the contract around the
  tool.
- **Consumers at the time of writing:** GoGo-MobileApp handles `event: resync`
  before parsing the payload (`2447dc7`) but still vendors `1.0.0-alpha.57`;
  GoGo-CMS and GoGo-WebApp do not read this stream.

Earlier versions (`1.0.0-alpha.1` … `1.0.0-alpha.73`) predate this file. Their
history is in `git log -- openapi/gogo.v1.yaml` and in the ADRs they reference.

## 6.0.0-alpha.1 (2026-11-06) — discovery (GoGo-BE#774 / PR #775)

**Breaking for readers of CMS taxonomies.** `TaxonomyList[].kind` gains
`amenity`: `GET /cms/taxonomies` can now return a value the previous closed
response enum excluded. MAJOR per `git.md` SemVer, following the campaign
`audienceType=public` decision in GoGo-BE#747 / PR #749 (4.0.0-alpha.1).
The exact base/revision contract hashes and this single finding are recorded in
`.github/oasdiff-exceptions.json`; the checker remains unchanged. See ADR-0040.

GoGo-CMS currently rejects the entire array with `CONTRACT_MISMATCH` on an
unknown kind, including inactive rows. Before deploying this response, sync
its vendored contract and regenerate the client, add `amenity` to its runtime
taxonomy enum and kind selector, and provide Vietnamese/English kind labels.
The place editor and submission review also fetch this list unfiltered.
Changing to `x-extensible-enum` now cannot make those existing readers tolerant.

- Discovery: opt-in exact `includeTotal` with cursor-independent `meta.totalCount`/`totalCountAccuracy`; same SQL snapshot and eligibility, retryable `SEARCH_COUNT_UNAVAILABLE` permits retry without totals. Configurable count timeout/concurrency/rate guard.
- Search cards: explicit evidence-free `verification`, active `taxonomies`, localized current verified `areaSummary`; `locale=vi|en`. Publication/confidence/administrative mapping never imply a venue badge.
- Filters: CSV `amenities`, `moods`, `settings`, multi `suitedFor` including `work_reading`. OR within category/mood/setting/suitability, AND between dimensions; ALL dietary/accessibility/amenities. Deduplicate; `cashless_payment` means card OR QR, Wi-Fi+power means both. **Stricter validation:** unknown/inactive/wrong-kind keys, >10 distinct values, partial coordinates and inverted price bounds now return 400.
- CMS moderator verification: `PUT /cms/places/{id}/verification`, required Idempotency-Key/If-Match, evidence type + reference; identity/location revision-bound, revoked on name/address/geometry change. Means independently checked identity/location only, never quality or safety.
- Contributor credits: prospective original registered submission approval grants +50 once; no expiry or merged/guest/historical awards. `GET /assistant/status.creditBalance`; daily-first, then one credit per accepted user send, including subsequent provider failure. Replay/rejection consumes none. Readiness, burst, budget and BYOK checks still apply; `limit_reached` means daily allowance AND credits exhausted.
- `GET /rooms?view=home`: top one nearest temporal room across memberships; active first unless explicit end passed, start proximity (unknown last), then future collecting/matching/ready earliest start, UUID descending tie-break. `nextCursor=null`; rejects status/cursor overrides. Room list adds nullable `startAt`/`endAt`.
