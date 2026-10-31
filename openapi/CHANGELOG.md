# GoGo `/v1` contract changelog

Consumers vendor `openapi/gogo.v1.yaml` and generate their client from it, so a
changed guarantee has to be readable without diffing 700 KB of YAML. One entry
per contract version that changes a published guarantee; a version that only
adds optional fields or new paths does not need one.

Version numbers follow `git.md` SemVer: MAJOR when a published guarantee is
withdrawn, MINOR for backward-compatible additions, PATCH for fixes.

## 2.0.0-alpha.6 — taxonomy labels are one line of plain text (GoGo-BE#737)

**Narrows a request.** `cmsCreateTaxonomy` and `cmsUpdateTaxonomy` now state
what a label may be, which they did not before (`labels` values were any
string; the server already refused more than 80 characters). The server first
normalises each label — NFC, every space separator to one ASCII space,
trimmed — then requires 1–80 code points of letters, combining marks, digits,
spaces and `' " ‘ ’ “ ” ( ) & + , . / - – —`. Anything else, newlines and
markup or template delimiters included, is refused with `400`; nothing is
stripped or truncated. Why: labels are shown to people and read by the
assistant's models as data, so a label must not carry a second line or a
block delimiter. The response schema (`TaxonomyList`) is unchanged; labels
stored before this version were checked on DEV (42/42 conform) but are not
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
