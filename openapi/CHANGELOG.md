# GoGo `/v1` contract changelog

Consumers vendor `openapi/gogo.v1.yaml` and generate their client from it, so a
changed guarantee has to be readable without diffing 700 KB of YAML. One entry
per contract version that changes a published guarantee; a version that only
adds optional fields or new paths does not need one.

Version numbers follow `git.md` SemVer: MAJOR when a published guarantee is
withdrawn, MINOR for backward-compatible additions, PATCH for fixes.

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
