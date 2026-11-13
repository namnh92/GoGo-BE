# GoGo `/v1` contract changelog

Consumers vendor `openapi/gogo.v1.yaml` and generate their client from it, so a
changed guarantee has to be readable without diffing 700 KB of YAML. One entry
per contract version that changes a published guarantee; a version that only
adds optional fields or new paths does not need one.

Version numbers follow `git.md` SemVer: MAJOR when a published guarantee is
withdrawn, MINOR for backward-compatible additions, PATCH for fixes.

## 12.2.0-alpha.1 — Configured room invite TTL reader (#906 BE-A)

New TOKEN128 invites read the singleton TTL from the primary DB inside the issuing
transaction, seeded at 86400 seconds. Existing credentials retain stored expiry.
Direct invite creation, ROOM_INVITE share mint and assistant `create_invite`
confirmation can return `503 INVITE_TTL_SETTING_UNAVAILABLE`: non-retryable for
missing/invalid data, retryable for database/lock failures, with no partial grant.
Share expiry exactly copies the invite. No CMS settings API or public CODE6 flow
is added. Internal CODE6 generations use min(configured TTL, 48h, room expiry).
Invite-attempt contexts, preview tickets, replay retention and risk windows keep
their independent lifetimes. See ADR-0060 for deployment order and rollback floor.

## 12.1.0-alpha.1 — Browser CSRF recovery (I05 F-01, #891)

Additive MINOR: public `POST /invite-attempt-contexts/csrf` accepts explicit `{}`
JSON and browser cookie proof with exact HTTPS Origin/Fetch Metadata checks.
Returns `200 { expiresAt, csrfToken }` without renewal, replay writes or success
cookies. Shares bootstrap flood limits. Errors are standard no-store envelopes
(400/401/403/415/429/503); 429 includes Retry-After. Existing bootstrap, mobile
and legacy/TOKEN128 contracts remain compatible. The host-only CSRF cookie is
retained but deprecated; use response-body recovery across Web/API subdomains.

### Invite-attempt bootstrap (I05, #891 / #861)

Additive MINOR: public `POST /invite-attempt-contexts`, mobile header and browser
cookie/CSRF transport, fixed 48h context TTL and encrypted UUID-keyed replay.
Generated declarations include the new operation and request/result schemas.
Legacy preview/join/session operations and their required fields are unchanged;
no proof is required for TOKEN128/omitted discriminator. CODE6 remains off.
Browser policy is HTTPS same-site, exact Origin allowlist plus Fetch Metadata;
Retry-After is CORS exposed. See `docs/invite-attempt-contexts.md` and ADR-0059.

## 12.0.0-alpha.1 — Atomic room host transfer (#879)

MAJOR: `RoomEvent.event_type` is a closed response enum and now includes
`room.host_transferred`. Consumers must tolerate that event before activation;
unknown notification kind `host_transferred` uses the existing extensible-kind
fallback. New endpoint `POST /rooms/{id}/host-transfer` requires a concrete
RoomMember ID, `expectedHostVersion` and `Idempotency-Key`; its immutable receipt
replays for 24 hours even after the issuing actor is demoted. `RoomSummary` adds
`hostMemberId` and independent `hostVersion`, from the same snapshot as roles.

All host-only writes reauthorize after the room lock; in-progress host computations
cannot persist across ownership changes (including A→B→A). Existing invites stay
valid to expiry/revoke and creators retain their ADR-0018 revoke right. Transfer
never resets selections, votes, plans, constraints, stale flags or invite usage.
Deploy schema/backfill, workers, and all guarded APIs before enabling; validate
mobile unknown-event/kind handling first. MAJOR is not CODEOWNER approval or DEV
acceptance. See ADR-0058 and `docs/room-host-transfer.md` for rollout/rollback.

The shared idempotency change (`20100c5f`) takes effect globally on API deploy,
even while host transfer is disabled. Legacy body-only request hashes no longer
replay on routes using the shared idempotency scope; their records remain until
the 24-hour TTL from claim creation expires. An identical retry of a mutation
committed before deploy whose response was lost returns non-retryable
`422 IDEMPOTENCY_KEY_REUSED` (`retryable: false`). Clients must reconcile the
original operation by refetching the resource before issuing a new key: a new
key could duplicate an already committed mutation. Expiry does not prove that
the original mutation failed.

Client recovery handling must be ready **before API deploy**, independently of
transfer activation. Old and new API instances must not serve the same keys
concurrently: use a single cutover, with old requests drained/stopped before new
instances serve traffic. DEV and production both use GoGo-Infra's
`scripts/deploy/deploy-vps.sh` and `docker compose up -d` to replace the single
API container (stop old, then start new); do not introduce rolling/canary overlap.
See [the release runbook](../docs/runbooks.md#879--global-idempotency-cutover)
for deployment and client recovery requirements.

## 11.0.0-alpha.1 — Account member seed contributions (#878)

MAJOR behavioral change: both seed routes now enforce draft/collecting and room
expiry, including host DELETE and keyed replay. POST runtime status changes from
201 to the documented 200. New additions require published catalog places within
both room area filters and the total quota of 10 distinct seeds across all
contributors. Legacy over-quota rooms retain all data and can delete/no-op.

Active account members may add and remove only their membership's contributions;
host removes any. Guests always receive 403, including guest rows with member
role. Paths/operation IDs and old request bodies remain valid. Both mutation
responses are RoomSeedPlacesResponse with constraintVersion and required
membership-only addedByMemberId, preserving position. RoomSummary uses the same
seed DTO. Typed errors document permissions, state, area/quota and replay.

Optional seed Idempotency-Key binds normalized body and concrete resources for
24h; changed body/resource is 422, unsafe legacy records are 409
IDEMPOTENCY_CONTEXT_CHANGED (reload/use new key). Replay rechecks authority/state;
DELETE replay never removes a later re-add. Missing keys have current-state
no-op semantics only. Changed sets advance the version and stale dependent data.
`11.0.0-alpha.1` remains a MAJOR bump from the rebased `10.3.0-alpha.1`.
The new `room.seed_places_changed` value expands the closed SSE response enum at
`GET /rooms/{id}/events` (`RoomEvent.event_type`), breaking strict/exhaustive
readers. Before rollout, consumers must regenerate their types and add a tolerant
unknown-event branch. Old clients must ignore unknown event payloads, invalidate
cached room/seed state and refetch the room and seed list while continuing the
stream; unknown values must not fail the stream decoder or disconnect it. Never
infer ownership or apply deltas from an unknown payload. ADR-0057 records the
BE-BFF-012 decision; `CODEOWNERS` maps the contract and exact-byte exception to
`@namnh92`, whose exact-revision sign-off is a separate gate.

New room.seed_places_changed SSE enum signals refetch after commit; delivery is
best-effort, requiring focus/reconnect/resync refetch and polling fallback. No new
push/inbox. Generate consumer types/artifacts from this spec; do not infer member
ownership when attribution is absent on an older server. See ADR-0057 for rollout
and compatible rollback; this version alone does not prove mobile compatibility.

## 10.3.0-alpha.1 — Curated place aliases (#887 / #901)

Additive MINOR: CMS place details expose curated `aliases`; PATCH can replace or
clear the set with `expectedUpdatedAt` and editorial `aliasProvenance`. Omission
preserves aliases. Merge retains alias provenance, keeps the canonical entry on
normalized collisions and rejects a union over 20 with
`409 PLACE_ALIAS_LIMIT_EXCEEDED`. Consumers must regenerate types and handle this
conflict before offering alias editing or merge. Exact alias resolution remains
subject to the existing place-QA activation gates.

## 10.2.0-alpha.1 — S3 activation of place QA (#864 / #844)

S3 accepts the already-declared paired follow-up fields and validates the latest
accessible QA source, option, state version and expiry. Branch options now emit
`id` while `assistant.place_qa.enabled` stays default-off. Both-or-neither
validation remains `400 VALIDATION_FAILED`; stale/disabled selections produce a
neutral QA response, without resuming a recommendation. No field/type/required
list/bound changes. This backward-compatible activation removes planned metadata
and changes the published behavior, so it is a MINOR contract release. Declarations
were regenerated (byte-identical); repository version pins move to `10.2.0-alpha.1`.
S4 source-bound consumers and S5 aliases remain required before enablement.

## 10.1.0-alpha.1 — Place-answer reader compatibility floor (#856 / #844 S1)

Additive MINOR: optional `AssistantFollowUpGroup.options[].id` and paired optional
send fields `replyToMessageId` + `followUpOptionId`. Both or neither: the
pairing is documented on the fields and enforced by the server (`400
VALIDATION_FAILED` when one arrives alone), not by a schema dependency keyword,
so the request schema gains no constraint. These fields are reserved
(`x-gogo-planned`): S1 specifies and generates them and the server still
refuses either field with that 400; S3 implements request validation/state and
S4 integrates the consumer before emission/enablement. Existing typed sends omit
both fields.

Documents `place_choice`, `place_confirm`, `place_topic`, atomic current-fact
rendering, replay semantics, per-fact source dates and read-error delivery. A
reader failure can emit an SSE error after a persisted producer completion;
history/CMS return localized load-error text and omit affected cards/sources/
options, never pretending the place is unavailable. Private references never
reach clients or exports. Stored export contains public ID/query labels only.

No production emitter/projection/classifier or flag enablement in S1. Once any
new reference has been written, rollback must keep S1-compatible readers. See
ADR-0055 and `docs/plans/856-place-answer-readers.md` for the versioned format,
read-port obligations, activation order and DEV checks.

## 10.0.0-alpha.1 — Free-first actual-cost credit funding (#851 / #832 D1)

MAJOR: after the configured free daily allowance, accepted sends require a
versioned whole-turn credit hold rather than exactly one credit. Positive posted
balance can be insufficient. New refusal: 409 ASSISTANT_INSUFFICIENT_CREDIT with
required typed details, retryable false; paid unavailability is 503, burst is 429.
No hardcoded daily limit; DEV is configured to 5. Legacy policy remains unchanged
until audited cutover; D1 does not bind or enable paid billing.

AssistantStatus requires reserved/available, effective policy, nullable required
hold, paid readiness and snapshot time; state includes insufficient_credit.
MyCredits reports actual holds and effective policy. Assistant messages always
carry turn credit facts; conversation projections, acceptance/replay and message
pages carry full-conversation totals. Unknown historical attribution stays null.
CMS reason is now an open string; delta is any signed nonzero safe integer,
including refunds. Tolerant consumer readers must deploy before activation.
D2 provider evidence, settlement worker/finality and privacy/export remain deferred.
Rollback disables new paid admission and preserves funded work; no hold-blind binary.

Additive within this MAJOR (owner 2026-11-11): MyCreditEntry adds optional nullable
`conversation: {id, title}` for usage entries still readable by their owner,
including D turns and legacy usage/message links. Deleted, expired, unknown,
foreign and non-usage conversations return null. Optional nullable
`eventLabels: {vi, en}` comes directly from the event grant's catalogue labels;
other entries return null. Clients group by local day and conversation. The
10-row page, stable cursor and descending ordering are unchanged.

## 9.5.1-alpha.1 — Đồng bộ rating Google trên thẻ trợ lý (#834)

PATCH: `AssistantPlaceCard.providerRating`, `providerRatingCount` và
`providerRatingSource` theo cùng quy tắc với `PlaceSummary`: có mặt khi rating
Google đã lưu là số hữu hạn, không chỉ khi có bản ghi nguồn Google. Chỉ sửa mô
tả, không đổi schema.

## 9.5.0-alpha.1 — Personal credit balance and history (#832)

MINOR: thêm `GET /me/credits` trả `balance`, `earned`, `spent`, `reserved`,
`availableBalance`, `asOf`, `policyKey`; `GET /me/credits/ledger` trả `items`
và `nextCursor`, 10 bản ghi/trang, cursor gắn với user. Mỗi bản ghi có `id`,
`createdAt`, `delta`, `direction`, `eventKey`, `source.type`, có thể có `eventId`
và `messageId` (chưa trả trong slice V). Chỉ đọc sổ cái hiện có, không tạo tài
khoản hay sửa lệch số dư; chưa có tài khoản trả số dư 0 và lịch sử rỗng.
`reserved` là 0, `policyKey` là `legacy_allowance_v1`; refund giảm `spent`,
không tăng `earned`. Không đổi cấp credit hay cách tính phí hiện có (ADR-0053).

Chỉ user đăng ký đang hoạt động; guest/staff nhận `USER_ONLY`. Flag độc lập
`assistant_credits.display_enabled` mặc định off; tắt trả 404
`CREDITS_DISPLAY_DISABLED`. `GET /me` thêm capability `assistantCredits`;
thiếu hoặc false nghĩa là chưa khả dụng. Response và lỗi dùng
`Cache-Control: private, no-store`; giới hạn 60 request/phút/actor.

## 9.4.0-alpha.1 — Non-consuming recovery verification (#845)

MINOR: thêm `POST /auth/password-recovery/verify` nhận email/challengeId/code,
204 rỗng khi proof hợp lệ, chưa dùng và còn hạn. Không tiêu mã; complete vẫn
kiểm lại và reset single-use. Mọi proof sai dùng 400 RECOVERY_INVALID, dùng
chung tối đa 5 lần sai/challenge và quota complete 10/15 phút/email,
30/15 phút/IP. Sai challenge ID cũng tính lượt trên challenge đang sống.
Không replay verify thành công; retry vẫn kiểm trạng thái hiện tại và tính quota.
Mobile#622 chỉ chuyển OTP → mật khẩu sau 204; đồng bộ types 9.4.0-alpha.1.
Request/complete giữ DTO, response và completion replay hiện có.

## 9.2.0-alpha.1 — Recovery account not found (#835, Refs #772)

MINOR theo quyết định owner 2026-11-10: request recovery thêm response 404
`RECOVERY_ACCOUNT_NOT_FOUND`, retryable false, message `Tài khoản không tồn tại`
cho mọi email không có tài khoản mật khẩu hoạt động; không phân biệt lý do.
Eligible vẫn 202 + challengeId, replay/cooldown và gửi mã như cũ. Mọi request,
kể cả 404, chịu 1/phút + 3/giờ/email và 10/phút + 50/giờ/IP. Giữ padding
250 ms, detached delivery và telemetry không email; thêm counter not_found.
Chấp nhận rủi ro dò eligibility trong ADR-0041. Mobile#620 đồng bộ contract
9.2.0-alpha.1, bỏ câu phụ đủ điều kiện, chỉ chuyển màn nhập mã sau 202;
404 hiển thị message chung, 429 giữ Retry-After.

## 9.1.1-alpha.1 — Giữ ETag mạnh qua Cloudflare (#831, PR #833)

PATCH: bổ sung `no-transform` vào Cache-Control của notification-settings
GET/PATCH/PUT, system-notifications GET/304, administrative GET/304 và CMS
verification PUT để proxy không đổi ETag mạnh khi nén. Response 200 của CMS
verification công bố const `private, no-store, no-transform` trong OpenAPI.
Giữ nguyên định dạng ETag; version contract tăng PATCH theo chính sách khi
OpenAPI thay đổi, thay cho yêu cầu giữ nguyên version trước đó.
Consumer cần đồng bộ contract và sinh lại types từ **9.1.1-alpha.1**.

## 9.1.0-alpha.1 — Nhắc lịch và giờ yên lặng (#811 PR4)

MINOR: GET/PUT/PATCH notification settings thêm `quietHours` tùy chọn trong
response; PATCH nhận enabled/timezone, giữ giá trị bị bỏ qua. Mặc định off;
bật cần timezone IANA hợp lệ đã lưu hoặc trong request (thiếu/sai trả 400
VALIDATION_FAILED). Cùng ETag/version, If-Match, idempotency và audit hiện có.
PUT cũ giữ nguyên giờ yên lặng. Export tài khoản gồm cấu hình mới.
Hai nhánh `anyOf` PATCH từ 9.0.0 giữ nguyên nội dung và thứ tự; giờ yên lặng
được thêm bằng nhánh thứ ba, hỗ trợ cả cập nhật riêng và kết hợp master/category.

Một date_reminder theo confirmed start từ room_constraints, trước 120 phút;
không start thì không nhắc. Trong cửa sổ gửi ngay một lần khi còn trước start.
Đổi/hủy lịch cập nhật job trong transaction. `room.reminder_due` ghi facts
trigger=scheduled, scheduledFor, startsAt, leadTimeSeconds=7200, scheduleRevision;
`room.status_active` vẫn lưu facts room_started cho sự kiện nghiệp vụ; PR4 ngừng
fan-out reminder từ sự kiện này để không gửi nhắc lần hai/khi thiếu start.
Payload room_started lịch sử vẫn đọc được; ledger cũ được suppress.

Opt-in 23:00–07:00 theo timezone đã lưu chỉ hoãn push, inbox lập tức. Worker
lưu deferred state và kiểm tra lại quyền, master/category, timezone và lịch khi
gửi; nhắc đã quá giờ hoặc lịch bị đổi/hủy bị suppress. DST chọn instant UTC đầu
ngoài cửa sổ giờ địa phương. Không emergency bypass, không cleanup bảy ngày.
Migration 0096; chi tiết vận hành/rollback trong docs/notification-inbox.md.

## 9.0.0-alpha.1 — Stored provider cover (#822, ADR-0052)

MAJOR: remove `GET /places/{id}/provider-photos` / `getPlaceProviderPhotos` and
withdraw the no-Google-provider guarantee on `POST /cms/places`: a request with
`googlePlaceId` implicitly acquires one Google cover when enabled. No new request
field. Other provider facts remain excluded on this door.

SubmissionResult and MyPlaceSubmission/Detail add optional `photo: PlacePhoto`;
CMS PlaceSubmissionSummary/Detail add `providerPhoto`. Google images always carry
credits. `photoUrl` retains its editorial/community semantics.
`SubmissionProviderDisplay.photo` remains declared, deprecated and never emitted.
Rejected submissions add `updateDeadline = decidedAt + 7 days`; their cover is
shown only while that deadline is in the future. No inheritance or information
purge in #822 (#824 owns those).

Deploy consumers in the same DEV window: Mobile removes the gallery call, query
and persistence rule, uses PlaceDetail.photos, renders submission `photo` plus
credits, and limits useCandidatePhoto to resolve preview. CMS regenerates its
client, renders providerPhoto and explains implicit cover acquisition; failed
CMS acquisition requires editor upload. Regenerate both clients at 9.0.0-alpha.1.
Exact-head CODEOWNER approval for migration/OpenAPI remains required; the owner
product decision in shape §16 is not that approval. The single oasdiff exception
is `BE-822-provider-photos-path-removed`; no other ERR is admitted.

## 8.1.1-alpha.1 — Provider-photo rate-limit documentation (#821)

PATCH: correct provider-photo descriptions to document 120 requests/minute per
verified actor, falling back to IP for anonymous requests. Place-detail photo
availability remains subject to rate limits. No response or schema changes.
Regenerate consumers from **8.1.1-alpha.1**.

## 8.1.0-alpha.1 — Sourced event-time notification facts (#811 PR3)

Additive MINOR: optional `payload.reminder`, `payload.planPreview` and
`payload.inviterAvatar`. Existing rows and queued events remain valid without
these fields; no historical snapshots are backfilled. Producers capture the new
facts in the business transaction. Plan previews identify the event-time plan,
version and constraints, confirmed start instant and up to three ordered stops.
Venue text needs independent field provenance (addresses follow ADR-0031).
Only approved independently uploaded GoGo place-media IDs and processed GoGo
avatar references are retained; no Google content, external image URLs, private
evidence references, account or actor IDs enter the public facts.

`room.status_active` emits `reminder.trigger=room_started`, with
`scheduledFor=null`; it means the outing started. No assumed two-hour lead time,
advance scheduler or quiet hours ship here. The client composes venue/time/countdown
copy from facts and must not treat room_started as an advance reminder.
Historical previews never establish current access: inbox reads suppress sensitive
facts after membership revocation and unavailable text/media; opening resolves the
current authorized plan. Regenerate consumers from **8.1.0-alpha.1**.
No migration beyond 0094 is needed. PR4 remains separate.

## 8.0.0-alpha.1 — Category preferences and server-side inbox kinds (#811 PR2)

**Semantic MAJOR**, owner approved **2026-11-08**; contract/migration CODEOWNER
sign-off is separate and still required. ADR-0050 supersedes the ADR-0025 guarantee
that every push kind reports the account switch: legacy GET now returns effective
registered-kind/master/category permission. Five independently remembered choices
are `invite`, `preference_reminder`, `plan_ready`, `plan_changed`, `date_reminder`;
`other` is non-configurable. Moderation gains no push producer; privacy exports
remain in-app only. No PR3 payload facts or PR4 scheduling/quiet hours are added.

GET settings adds optional `version` (decimal string), `categories`, and a strong
ETag. PATCH requires If-Match and Idempotency-Key; replay wins over stale-version
rejection. Existing PUT true enables master and all categories; PUT false retains
categories. Legacy opt-out disables master; opt-in never overrides category/master.
Clients regenerate from 8.0.0-alpha.1 and use PATCH for independent controls;
legacy clients remain callable but cannot represent mixed settings fully.

GET `/me/notifications?kinds=invite&kinds=plan_ready` filters on the server using
repeatable form/explode parameters validated against known NotificationKind values.
Unknown values return 400. Opaque cursors bind the canonical filter and the existing
sequence snapshot; changing a cursor's filter returns INVALID_NOTIFICATION_CURSOR.
Summary unreadCount remains unfiltered. Timestamp cursors belong to all kinds.

The compatibility gate adds the precise ADR-0050 semantic diagnostic even when
structural oasdiff is clean, demands a MAJOR, and consumes an exact-base/head-hash
entry in `.github/oasdiff-exceptions.json`. This records owner authorization, never
CODEOWNER approval or a waiver for unrelated structural errors. Built on **7.8.0-alpha.1 / #816** (migration 0093 system announcements);
this slice adds migration 0094 and retains both contract additions. Refresh hashes
and rerun the gate after any further base or contract edit.

## 7.8.0-alpha.1 — public system announcements (GoGo-BE#815)

Additive MINOR: anonymous `GET /system-notifications`, cursor-paged by
(publishedAt DESC, id DESC), published/unexpired rows only. Shared cache is
`public, max-age=60`; ETag/304 revalidates the current page. DTOs carry seven
public facts; title/body are CMS-authored editorial copy. Extensible response
kinds initially include maintenance/update/general. No account read state.
Ops/super admins can list, create drafts (mandatory transactional Idempotency-Key),
edit, publish and archive with append-only audits. Migration 0093 and ADR-0051.
Signed-in clients show the public section above the personal inbox; no duplicate
inbox/push rows or changes to unread counts, preferences or delivery semantics.
Regenerate clients; existing paths and schemas retain their guarantees.

## 7.7.0-alpha.1 — shared notification inbox (GoGo-BE#811 PR1, #809)

Additive MINOR: shared unread summary, signed account-bound cutoff, durable bounded
read-all and operation polling. New read-all requires Idempotency-Key; existing
single-read keeps its 201/success shape and now preserves the first readAt.
Inbox pages use opaque account/snapshot-bound (createdAt,id) cursors with a 24-hour
expiry and accept legacy timestamp cursors during transition. All existing kinds
remain extensible; preferences, dispatcher delivery and payload facts are unchanged.
Summary is private/no-store; refetch after reads. Cutoff APIs remain unavailable
until the bounded backfill and concurrent-index rollout finishes (ADR-0050).
Category semantics in a later PR require a MAJOR version, not this MINOR release.

## 7.6.0-alpha.1 — Wizard keep/drop moderation (GoGo-BE#806)

Add optional `enrichmentSelection` to CMS decide, `enrichmentItems` and
`expectedCredit {base, photoBonus, total}` to CMS detail, a read-only
`POST /cms/place-submissions/{id}/credit-preview`, and public PlaceDetail
`contributionFacts`. Existing decide oneOf branches remain byte-identical.
Explicit selection applies only kept facts and wizard photos; empty arrays drop
all. Wizard photos are public userPhotos for the review section, never gallery.
Stable fact keys and photo mediaIds are returned by the server. Old clients may
omit selection: #802 behavior is preserved (no facts, existing photo selection,
merge bonus-only). New CMS must send an explicit selection when enrichment exists.
Explicit-selection approve/merge: +50 base, +20 if at least one original menu/bill
photo is kept; venue/submission uniqueness still prevents duplicate grants.
Credit preview is conditional on pending state, contributor and ledger eligibility;
concurrent changes may require reloading. No client credit math.
Regenerate consumer clients. Deploy migration 0090 before the binary; no backfill.
See docs/place-contribution-keep-drop.md for mapping, audit and rollback.

## 7.5.0-alpha.1 — Contribution wizard and private drafts (GoGo-BE#796)

MINOR additive: add optional `enrichment` to place submission and owner/CMS detail responses;
proposal facts remain unverified and never automatically become place facts.
Add registered-user-only `/place-contribution-drafts` list and `/{id}`
GET/PUT/DELETE, version checks and 30-day retention. Taxonomy keys, price unit
and currency, 1–3 vibes, amenity yes/no, service/space ratings and chips.
Menu/bill refs capped at five including ordinary mediaIds; menu refs use #794's
private owner claim/sanitisation pipeline and explicit CMS photo selection.
Initial implementation (superseded by the final owner decision below):
Bills still return `503 SUBMISSION_EVIDENCE_BLOCKED` pending real server-side
PII masking (ADR-0048; incomplete #796 requirement). Approval credit is +50,
+20 only with server-approved original-contributor menu/bill evidence (max +70).
No old required fields change. All active taxonomy keys of each relevant kind
are accepted without fixed amenity lists or service/space prefixes.
CMS credit history `CmsAssistantCreditEntry.delta` documents +50, +70 and -1
with `x-extensible-enum`; generated clients accept integer deltas. Consumers
must tolerate unknown integer deltas. Clients generated from the previous
closed enum must regenerate before receiving +70; making the schema extensible
does not make existing closed-enum readers tolerant. Owner decision 2026-11-07:
keep MINOR and record `BE-796-credit-delta-extensible` for the exact-byte
`response-property-became-not-enum` finding; see ADR-0048. Docker-denied fallback
uses the supplied known finding; fresh oasdiff replay remains unverified.
Consumers regenerate clients; CMS/mobile integration and Astra/CODEOWNER review
remain required. ADR-0048 and migration 0089.

Final owner decision 2026-11-07 removes `visibility`: every bill/menu upload is a
public contribution after explicit moderator approval. Bill saves/submits require
`enrichment.billPhotoPublicConsent: true`, confirming public display after approval
and that the uploader removed/hid personal information themselves. No DLP or external
receipt processor. Missing/false consent with bills returns a 400 field error.
Final amendment: wizard photos become a separate read-only `PlaceDetail.userPhotos`
set, credited to the original uploader; they do not enter `photos` or the cover.
Editor/moderator promotion is tracked separately in GoGo-BE#804. Pending/rejected
images never become public; moderators can discard any photo. Rejected bills are
queued for immediate cleanup; rejected menus retain #794's seven-day retention.
Draft expiry releases retained bytes. CMS photo detail exposes optional `kind`.
Accepted menu/bill evidence grants +20 once, including on merge; approval adds +50.
Ledger deltas are extensible integers (20/50/70/-1); CMS must regenerate types.
The consent property is optional in OpenAPI, with runtime conditional validation.
Service/space ratings remain optional for generated-client consumers: omitted
ratings are not provided, and supplied ratings still require an integer from 1 to 5.
Migration 0088 atomically advances the taxonomy generation with its vocabulary seeds.
Restore both decide request `oneOf` branches byte-for-byte from `origin/re-design`;
photo publication and cleanup rules live in the operation description to avoid
oasdiff treating description edits as branch removal. Rebind the existing
`BE-796-credit-delta-extensible` exception to the final raw YAML SHA-256.
Credit-only policy replay passes; fresh oasdiff remains blocked by Docker socket
permissions. See `docs/verification/be-802-owner-visibility.md` for evidence.

## 7.4.0-alpha.1 — Facts và chi tiết đóng góp (GoGo-BE#801)

MINOR additive: list thêm `providerDisplay` từ snapshot còn mới được lưu lúc
submit, attribution, hours, rating/count và lazy reference một ảnh JSON proxy
#786. `GET /me/place-submissions/{id}` mới cho người gửi/đóng góp đã ghi nhận;
trả cùng facts, status, rejectionReason và placeId sau approved/merged.
Enrichment #796 và input chỉ trả cho chính người gửi gốc, đánh dấu unverified;
không trả moderation note hay PII/input người khác. Unknown/không có quyền cùng
404 trước billing; guest/admin 403. CMS vẫn bắt buộc rejectionReason theo #787.

LIST không gọi provider, không reserve display budget hoặc hydrate background.
Resolve ký resolution id trong token ≤1024 ký tự, giữ allowlist snapshot phía
server tới cùng expiry với token; submit đọc record và lưu cùng transaction, không ghi
đè snapshot còn mới khi dedup. Pending/rejected detail thiếu snapshot hoặc quá
30 ngày mới refresh trong budget quality hiện hữu, atomic lease 60s và cửa sổ
6s; photo timeout không làm mất facts đã nhận. Approved/merged dùng canonical
GoGo facts. Lazy photo reference dựng từ Place ID, không persist photo refs hay
bytes; proxy thực thi flag/budget/credit. Cả response no-store. 30 ngày là quy
tắc freshness nội bộ, không phải Google permission; owner chấp nhận storage risk
và yêu cầu proceed/merge ngày 2026-11-07. ADR-0048; migration
`0088_submission-display-snapshot` chạy trước API.

## 7.3.0-alpha.1 — taxonomy cache generation (GoGo-BE#799)

MINOR additive: `/taxonomies` gains `version`, optional exact `locale`, weak
ETag / If-None-Match (304), and public caching (60s + 300s stale revalidation).
New `/taxonomies/version` is a cheap revalidated singleton read; authenticated
`/cms/taxonomies/version` also exposes the last write time. CMS create/update/
synonym responses retain existing fields and add `version` and `updatedAt`.
Every successful CMS taxonomy write (including synonyms, no-op updates and
duplicate synonym adds) increments once with an atomic audit. Failed writes
roll back entirely. Consumers persist lists by locale/kinds, use offline cache,
and compare the generation or revalidate the list ETag before refetching.
See ADR-0047. CMS and Mobile implementation ship separately.

## 7.2.0-alpha.1 — Optional submission photos (GoGo-BE#793)

Owner/CODEOWNER decision 2026-11-07 on PR #794: **"Ghi exception, giữ MINOR"**.
[ADR-0046](../docs/adr/0046-place-submission-photos.md#contract-compatibility-exception-2026-11-07)
records the exact-byte exception `BE-793-submission-photos-decide-oneof` in
`.github/oasdiff-exceptions.json`: oasdiff matches inline `oneOf` subschemas by
exact equality and reports both branches removed when optional `approvedPhotoIds`
is added. Keep `7.2.0-alpha.1`. **Deploy together with
[GoGo-CMS#283](https://github.com/namnh92/GoGo-CMS/pull/283)** after CMS syncs its
contract/generated client and sends explicit photo selections. Old CMS approving
a submission with pending photos receives `409 PHOTO_REVIEW_REQUIRED`.

Additive MINOR from 7.1.0-alpha.1. `POST /place-submissions` accepts `mediaIds` (0–5 distinct ids
from the sender's `POST /uploads`, purpose `place_photo`). The upload response
now documents its existing `id`; new originals use the private one-day `tmp/`
lifecycle. JPEG/PNG/WebP are
validated against actual bytes and size, re-encoded to WebP with EXIF/GPS
removed, and retained privately. Convert HEIC before upload.

CMS submission detail adds `photos` with authenticated BFF preview URLs;
`DELETE /cms/place-submissions/{id}/photos/{photoId}` rejects one with a reason.
Approve/merge with pending photos requires explicit `approvedPhotoIds`;
omitting it yields `409 PHOTO_REVIEW_REQUIRED`, and `[]` rejects all. The older
CMS cannot accidentally publish unseen photos. Selected photos become approved
GoGo place photos with the actual uploader's `contributor` credit. Others are
unreadable immediately and scheduled for deletion after seven days. Public
photo URLs recheck approval and place visibility at every read. Original
uploads are never served. Resolve root-relative URLs against the API origin.

## 7.1.0-alpha.1 — Đóng góp địa điểm của tôi (GoGo-BE#788)

MINOR bổ sung từ 7.0.0-alpha.1: `GET /me/place-submissions` dành cho user
đăng nhập; guest/admin bị từ chối. Lọc theo người gửi đầu tiên hoặc attribution ở server, phân trang
cursor giảm dần `(createdAt, id)` với độ chính xác microsecond, `limit` 1–100
(mặc định 25), `nextCursor: null` khi hết. Response dùng `Cache-Control: no-store`.

Mỗi mục có `id`, `status`, `createdAt`, `updatedAt`; bổ sung `name`, `photoUrl`,
`decidedAt` khi có. `placeId` chỉ có cho approved/merged khi place còn tồn tại.
Rejected trả `rejectionReason` đã lưu theo taxonomy `SubmissionRejectionReason`
của #787 để client dịch; bỏ field khi dữ liệu lịch sử chưa có key. Không
trả lý do CMS dạng tự do, ghi chú hoặc định danh người khác. Chỉ dùng ảnh
catalogue editorial/community đã duyệt; không gọi provider hoặc lưu thêm dữ liệu Google.

Khi dedupe vào một proposal pending, mọi user đã đăng ký gửi đóng góp được ghi
vào `place_submission_contributors` cùng transaction với proposal. Submit lặp
vẫn tăng `submissionCount` nhưng không lặp attribution; người gửi đầu tiên vẫn
giữ vai trò moderation/credit cũ. History và polling cho phép người gửi đầu tiên
hoặc user có attribution; mỗi proposal một lần trên mỗi account. Guest giữ quyền
polling của người gửi đầu tiên. Thứ tự/cursor theo proposal, không theo lần góp.
Migration `0085_place-submission-contributors` backfill người gửi đầu tiên còn
active; không khôi phục được người từng dedupe mà trước đây không lưu. Áp migration
trước khi rollout code; chỉ coi attribution mới đầy đủ khi mọi writer đã nâng cấp.
Export thêm `placeSubmissions` chỉ gồm id, status, createdAt, decidedAt;
xóa account xóa attribution của account đó. Polling và CMS giữ taxonomy reason key
của #787; CMS vẫn bắt buộc `rejectionReason` khi từ chối.
Rollback: ngừng client gọi endpoint mới trước khi rollback API, giữ bảng attribution.
Writer cũ không ghi người góp sau; giữ bảng không khôi phục được attribution thiếu
trong rollout hỗn hợp hoặc rollback. Nếu cần gỡ schema, rollback và drain mọi
reader/writer dùng bảng trước, sao lưu attribution, rồi dùng migration roll-forward
đã kiểm tra trên snapshot để drop bảng; thao tác này mất lịch sử attribution.
Chi tiết và giới hạn trong `docs/adr/0045-my-place-submissions.md` và runbook GoGo-BE#788
ở `docs/runbooks.md`. Client sinh lại types từ phiên bản này.

## 7.0.0-alpha.1 — Required submission rejection keys (GoGo-BE#787 / PR #790)

**Breaking MAJOR** from 6.5.0-alpha.1 per BE-BFF-012, owner/CODEOWNER decision
2026-11-07 (MobileApp#482, screen 3.4). [ADR-0044](../docs/adr/0044-required-submission-rejection-reason.md) records the decision to keep
`rejectionReason` required when rejecting a submission. The single oasdiff
`request-body-wrapped-in-one-of` finding is recorded against the exact
base/revision contract bytes in `.github/oasdiff-exceptions.json`.

Optional public `rejectionReason` is added on submission polling and on CMS
queue/detail. Six fixed keys are published as
`SubmissionRejectionReason`; labels belong to client i18n. Historical rejected
submissions without a key omit it. Other statuses omit it. Public polling never
returns the internal `reason`/`decisionReason`, review draft or decision history.

CMS `POST /cms/place-submissions/{id}/decide` now requires a valid
`rejectionReason` when `decision=rejected` (400 `VALIDATION_FAILED`,
`field_errors.rejectionReason` otherwise). The internal `reason` note becomes
optional for rejection; approval and merge keep requiring it. **Request
validation intentionally tightens for rejection per the owner decision**.
**GoGo-CMS must deploy together with GoGo-BE**: sync its vendored contract,
regenerate its client and require a reason-key selection in its reject action.
Old CMS rejection requests such as `{"decision":"rejected","reason":"duplicate"}`
now return **400 `VALIDATION_FAILED`** because they lack `rejectionReason`.
Send `{"decision":"rejected","rejectionReason":"duplicate_place"}` instead;
the internal note may also be included. No compatibility fallback infers a
public key from private text. Other consumers regenerate their clients and
tolerate the optional response field being absent on historical rows. Migration
0084 and rollback instructions: `docs/submission-rejection-reasons.md`.

## 6.5.0-alpha.1 — 2026-11-07

Additive MINOR from 6.4.0-alpha.1.

- #786: optional single-photo `ResolveLinkResult.candidate.photo` BFF reference;
  public `getCandidateProviderPhoto` JSON proxy with at most one transient image,
  no-store, Google/author credits, shared flag and cost limits.
- Approved link submissions may retain one current first Google photo as approved
  provider media (ADR-0043); Place Detail and cards carry per-photo credits/source.
  Pending and rejected submissions retain no provider image data. Photo pipeline
  outages leave approval pending with retryable `SUBMISSION_PHOTO_UNAVAILABLE`.

## 6.4.0-alpha.1 — Checked-in room count (GoGo-BE#785)

Additive MINOR from 6.3.0-alpha.1. `PlaceDetail.checkedInGroupCount` counts
all-time distinct rooms with a stored check-in at the place. Multiple members,
stops and plan versions in one room count once. Plans, completed stops without
a check-in, votes, saves and reviews do not count. Check-in content moderation
is independent of the existence of the visit record.

The field is always present: `null` below five rooms (including zero), otherwise
an integer at least five. Clients hide the fact for null; no room or member
identity is exposed. Each request reads the committed population from the DB;
no aggregate or in-flight promise is cached. Deletions, cascades and merges
committed before that read are reflected immediately across API processes,
including 5→4 suppression. A concurrent read uses its own statement snapshot
and cannot supply a later request. The HTTP response remains `no-store`.
Database errors fail the request; no false zero or stale count is returned.

Migration `0082_place-checkin-counts` is required: it creates and backfills
`place_checkin_visits`, `place_checkin_rooms` and `place_checkin_counts`, with
triggers maintaining them in the source-write transaction. Apply the migration
successfully **before rolling out the API**: the new reader requires
`place_checkin_counts`. Each request reads the precomputed count by place
primary key.

Rollback the API to the uncached query at `d097b37` first, retaining the tables
and triggers; never restore the TTL-cached reader. Only after every reader has
switched back may `scripts/rollback-0082-place-checkin-counts.sql` remove the
derived schema. It preserves source records and the Drizzle journal, so a later
roll-forward must explicitly reapply migration 0082 in a transaction before
rolling out the new reader. Consumers regenerate clients as needed and tolerate
the field being absent with an older API. See [the runbook](../docs/runbooks.md#checked-in-room-count--gogo-be785)
and [ADR-0043](../docs/adr/0043-place-checked-in-group-count.md) for migration
limits, read consistency, privacy assumptions and verification.

## 6.3.0-alpha.1 — Place Detail areaSummary (GoGo-BE#784)

**Additive MINOR** from 6.2.0-alpha.1. `GET /places/{id}` returns optional
`areaSummary`, sharing `PlaceAreaSummary` with `PlaceSearchResult.areaSummary`:
`datasetVersion`, `provinceCode`, nullable `communeCode`, `label`, and `locale`.
Only VERIFIED mappings in the published dataset with an active, currently
effective unit qualify. Commune wins; otherwise province is used. Without an
eligible mapping the field is omitted. Detail uses Vietnamese labels, matching
search with its default `locale=vi`. `addressText` stays a separate postal
address; `areaKey` is still a discovery area, never an administrative fallback.

No migration or provider request. Consumers regenerate their client. Rollback:
roll back the API; consumers tolerate the optional field being absent.

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
