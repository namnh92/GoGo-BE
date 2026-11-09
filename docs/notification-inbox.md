# Notification inbox, category preferences and sourced facts — #811 PR1–3 / #809

ADR-0050 defines the four-PR shape. Contract **8.1.0-alpha.1** includes shared inbox
storage/read APIs, category preferences, server-side kinds filtering and optional
event-time payload facts. Owner decisions dated **2026-11-08** are recorded in
workspace `.claude/rules/execution-policy.md` §8 (BE#811) and ADR-0050 §6:
one reminder **120 minutes** before confirmed start (no start, no reminder;
reschedule/cancel on changes; newly confirmed inside the window sends once
immediately before start); quiet hours **default off**, opt-in **23:00–07:00**
in the stored timezone, defer push while inbox stays immediate; **no emergency
exception**; **no automatic cleanup**, including no seven-day deletion.
Replace Stitch's automatic sound-muting and seven-day cleanup claims.

The four PRs remain ordered: (1) shared inbox, **MINOR**; (2) category preferences
and filtering, semantic contract **MAJOR 8.0.0**; (3) sourced payload facts;
(4) approved scheduling and quiet-hour policies, with no emergency bypass or
cleanup job. These product policies are implemented in **PR4**, not this release.
Contract/migration CODEOWNER approval remains separate and required.

## Dữ kiện tại thời điểm sự kiện — PR3

Producer chụp `notificationFacts` trong cùng transaction ghi nghiệp vụ/outbox:
`PlansRepository.createPlanVersion` cho publish/edit/regenerate, `RoomsRepository`
cho lần chuyển sang active và lần thành viên mới tham gia bằng lời mời.
Dispatcher chỉ chuyển các cấu trúc mới đã chụp sang inbox; retry không lấy kế hoạch,
địa điểm hay người mời hiện tại để bù cấu trúc thiếu. Dữ kiện cũ vẫn đọc được,
không backfill hàng lịch sử. Các trường cũ như route và roomName giữ hành vi cũ.

- `planPreview`: ID/version của **kế hoạch vừa ghi**, constraintVersion,
  capturedAt, stopCount toàn kế hoạch và tối đa ba stop đầu theo position.
  startAt/startAtSource chỉ có khi `room_constraints` phiên bản hiện tại có
  start_at và khớp constraintVersion của plan. arriveAt của stop là dữ kiện riêng;
  scheduledDate không phải giờ hẹn đã xác nhận.
- `reminder`: room.status_active ghi trigger=`room_started`, triggeredAt,
  scheduledFor=`null`, startsAt từ constraints hiện tại hoặc `null`.
  Không ghi leadTimeSeconds hay scheduleRevision cho sự kiện này. Không thể
  suy ra “còn 2 tiếng”; scheduler 120 phút và quiet hours thuộc PR4.
- name/addressText có SourcedText: value, sourceType=`gogo`, originType,
  verifiedAt và collectedAt nếu có. Mỗi trường cần nguồn độc lập; address theo
  contactOwnership/ADR-0031. Provider cần tham chiếu nguồn không phải Google và
  thời điểm thu thập độc lập. Nhãn provider hoặc canonical column không đủ.
  Thiếu/không rõ/Google-derived thì bỏ trường. Không có provider call hay AI.
- Ảnh kế hoạch dùng `stops[].mediaId`: place_media đã approved, nguồn editorial
  hoặc community, có mediaUploadId và không có providerPhoto. Không chụp byte,
  URL, attribution hay ảnh Google (kể cả ảnh đã được ngoại lệ #786 cho lưu).
  Client lấy media hiện còn được phép qua place/member API hiện tại.
- inviterName được chụp lúc join; inviterAvatar chỉ gồm sourceType=`gogo` và
  mediaKey trong namespace avatar đã xử lý của GoGo. Không có avatar thì bỏ.
  Tham chiếu membership nội bộ chỉ dùng kiểm tra quyền; không trả actor/user ID
  hoặc tham chiếu bằng chứng riêng trong response.

GET inbox kiểm tra membership/account/room hiện tại trước khi trả preview;
mất quyền thì bỏ dữ kiện nhạy cảm. Plan đã xóa bị bỏ preview; place không còn
published bị bỏ text; ảnh bị gỡ/từ chối, avatar bị thay/xóa hoặc inviter không
còn truy cập được thì bỏ tham chiếu tương ứng. Không thay bằng dữ liệu mới,
không sửa snapshot đã lưu. Kiểm tra theo trang tối đa 20 hàng; không gọi provider.
Mở hàng lịch sử luôn resolve kế hoạch hiện tại có quyền truy cập; preview không
cam kết kế hoạch còn mới. Client tự ghép câu, giờ và countdown từ các dữ kiện.
Push vẫn chỉ có routing ID và copy chung; không gửi venue/address/avatar snapshot.

Metric `notification_event_facts_total{kind,fact,present}` đếm theo lần fan-out,
gồm retry, với fact giới hạn reminder/planPreview/inviterAvatar. Không có payload,
tên, địa chỉ, media key hoặc actor trong label/log. Không cần migration sau 0094.
Rollback binary giữ nguyên JSON tùy chọn; worker cũ bỏ qua cấu trúc mới. API cũ
không có kiểm tra quyền preview mới, nên phải giữ API có mapper kiểm tra quyền
cho tới khi ngừng trả các trường này; không rollback API cũ để phục vụ snapshot.

Kiểm chứng: `notification-event-facts.spec.ts`, `notification-payload.spec.ts`,
`inbox-preview-access.spec.ts` và `notification-event-facts.int.spec.ts` kiểm tra
producer → outbox → inbox, retry/supersede, provenance, media, quyền bị thu hồi,
giờ bắt đầu không có hoặc nhiều phiên bản constraints, hàng cũ và rollback transaction.

`GET /v1/me/notifications/summary` is the shared source for every unread badge,
including #809. It counts all account-owned unread inbox rows, regardless of push
settings or kind. Use one account-scoped client cache, clear it on account change,
and invalidate/refetch after single-read or completed read-all. Responses are
`Cache-Control: private, no-store`. A replayed mutation is never a current count.

## Thông báo hệ thống công khai — #815

Từ contract **7.8.0-alpha.1**, `GET /v1/system-notifications` dùng được khi chưa
đăng nhập. Client hiển thị phần công khai này **phía trên hộp thư cá nhân** sau
khi đăng nhập. Không sao chép thông báo hệ thống vào `notifications`, không gửi
push và không cộng vào `/me/notifications/summary`. Không thêm trạng thái đã đọc
cho thông báo công khai trong PR này. Xem [system-notifications.md](system-notifications.md).
Các quy tắc hộp thư tài khoản và lộ trình ADR-0050 vẫn giữ nguyên.

## Storage and cutover

Migration **0091_notification-shared-inbox** is short transactional DDL. It adds
nullable historical sequences, account counters, a rollout gate and durable read
operations. The common `BEFORE INSERT` trigger allocates every notification's
sequence under the account counter row lock, held until the outer insert commits.
It covers raw SQL, campaigns, privacy exports and old worker binaries without
changing delivery behavior. Supplied sequence values are overwritten. Existing
unique dedupe constraints still decide whether a row exists; safe sequence gaps
are expected on dedupe retries. Multi-account transactional writers must acquire
account locks in sorted user-id order (current producers insert one account at a
time, except privacy publication, which inserts one row in its transaction).
Migration **0092_notification-erasure-fence** drains in-flight inserts before
replacing the allocator function under the same five-second lock timeout. It
retains the guard on binary rollback; a lock timeout rolls back the migration
and requires draining contention before retry.

1. Apply `pnpm db:migrate`. DDL waits for old insertion transactions before the
   trigger is installed, so old insert work is drained at this boundary. Schedule
   the DDL in a short-lock window. Migration 0091 enforces **SET LOCAL
   lock_timeout = '5s'** for its DDL, then restores the default. On PostgreSQL
   **55P03** (lock timeout), the transactional runner rolls back 0091, leaving
   it unapplied. Identify/drain the blocking transaction, then rerun the same
   migrate command; do not mark it applied or increase the timeout to force
   hot-table access. No data backfill or notifications index build runs in the
   migration transaction.
2. Deploy this release's API and worker together. Before backfill completes,
   the existing list stays available using full-precision `(createdAt,id)` fallback
   cursors, including historical rows with null sequences. Only summary/read-all
   return standard 503 until the gate is ready.
3. Run **one** operator process: `pnpm inbox:backfill` with the deployment's
   `DATABASE_URL`. First it repairs inbox remnants belonging to already-deleted
   accounts, including NULL-sequence rows recreated by old workers before 0091.
   Each repair commit removes at most 500 rows for one deleted account: read
   operations first, then notifications (with or without sequences), then its
   counter after both are empty. Accounts with only operations or a counter are
   also repaired. Each batch commits independently; interruption resumes from
   the remaining rows. Active accounts are excluded from erasure repair.
   This is rollout-time erasure repair, not an age-based retention policy.
   After repair, each commit assigns at most 500 historical rows for one
   account using the same account lock. New inserts continue. Kill/restart is
   safe: assigned rows are not selected again. Existing readAt, payload and
   dedupe markers stay unchanged. This command builds the unique, unread and
   page indexes with `CREATE INDEX CONCURRENTLY`, repairs invalid indexes left
   by interruption, then enables the cutoff gate only when no null sequences
   remain. Do not run simultaneous rollout CLI instances. Once ready, new list pages issue
   signed sequence-snapshot cursors; previously issued fallback tuple and legacy
   timestamp cursors still work through cutover.
   Sequence assignment is already active before APIs can issue cutoffs. A
   summary statement reads count and committed sequence in one MVCC snapshot;
   an uncommitted insert cannot enter its cutoff. Display ordering stays
   `(created_at DESC, id DESC)` and uses full database microsecond precision.
4. Verify summary, read-all >500 rows and status polling. Run the Testcontainers
   suite `apps/api/test/notification-inbox.int.spec.ts` in CI/Claude's environment.

### Exact deployed-image invocation

The operator entrypoint lives in `apps/worker/src/backfill-notification-inbox.ts`,
which the shared api/worker Docker image packages under `COPY apps`. It uses the
image's existing TypeScript loader; no checkout, bind mount, build output, or
`scripts/` directory is required. To run inside the **currently deployed api
container**, from the deployment repository root (DEV example):

```sh
ENV_FILE=.env.dev docker compose -f docker/docker-compose.prod.yml \
  --env-file .env.dev exec -T api pnpm inbox:backfill
```

Alternatively run the **same deployed image digest** as a one-off container on
the deployment network, with the deployment runtime env file (`DATABASE_URL`
must be reachable from that network):

```sh
docker run --rm --network "$DEPLOY_NETWORK" --env-file .env.dev \
  -e PROCESS=inbox-backfill "$DEPLOYED_API_IMAGE"
```

Both commands exit 0 only after backfill/index creation and gate enablement.
On interruption/failure, resolve contention/connectivity and rerun exactly one
operator process. Image-only packaging smoke: `bash scripts/ci/docker-inbox-backfill.test.sh`.

Indexes built outside the transactional migration runner:

- `notifications_user_sequence_unique`: UNIQUE (user_id, inbox_sequence).
- `notifications_unread_sequence_idx`: (user_id, inbox_sequence) WHERE read_at IS NULL.
- `notifications_inbox_page_idx`: (user_id, created_at DESC, id DESC).

## Read and cursor behavior

Read-through and page tokens are signed with a domain-separated key derived from
`AUTH_JWT_SECRET` (at least 32 characters). An unavailable key fails closed with
503; rotation invalidates existing tokens and clients should refetch. Tokens bind
account, purpose, schema version, canonical kinds filter (all for read-through), committed sequence cutoff,
capture time and a 24-hour expiry. Page tokens also carry `(createdAt,id)`.
Before cutover, the list requires no signing key and returns unsigned, strictly
validated `before:<full-precision UTC timestamp>:<UUID>` tuple cursors. These retain
their tuple boundary and include historical rows regardless of gate activation;
they carry no sequence snapshot. Legacy ISO timestamp cursors retain their old
exclusive timestamp boundary and remain accepted after cutover. Once enabled, new arrivals above a page snapshot stay out of its
later pages, even with a backdated createdAt. Never log cursor values.

POST read-all requires `Idempotency-Key` and `{ through: readThroughCursor }`.
The idempotency claim, durable operation, first batch and stored response commit
in one transaction. Failure before commit leaves none of them. A completed replay
precedes token validation/expiry and returns the original 200/202 response for
the existing 24-hour idempotency lifetime. A changed body returns 422. Replayed
202 responses retain Location; poll it for current progress.

The first transaction and each worker transaction change at most 500 unread
rows at/below the cutoff. The worker polls every second, at most ten transactions
per tick, using locked durable operations; crashes resume from committed state.
Changed counts and progress commit with read markers. Concurrent reads lock rows
in sequence order and count only their own updates. All rows changed by one
operation receive its fixed action timestamp. Existing readAt never changes.
Missing and foreign single-read IDs return the existing `{ read: true }`/201;
foreign and missing operation IDs both return 404. No read action changes room
membership or invitation state. Self-service and CMS account erasure explicitly
delete inbox rows, counters and operations in their shared transaction; accounts
are soft-deleted, so FK cascades alone do not erase these records. Migration 0092
fences every notification insert with a user row SHARE lock before allocating a
sequence, suppressing deleted recipients for campaigns, privacy exports, raw SQL
and old workers as well. Backfill and read-all operation creation take the same
user-first lock; read-all rejects an already-erased account before claiming
idempotency. Erasure either
waits for insertion and removes it, or commits first and prevents recreation. No automatic
retention cleanup is introduced.

Metrics have bounded labels only: `notification_inbox_summary_total`,
`notification_read_all_requests_total{status=200|202}`,
`notification_read_all_batches_total{status=running|completed}` and
`notification_read_all_changed_total`. Batch/change metrics describe committed initial and resumed
batches; request metrics include replays. Monitor tick failures through the
existing periodic-worker error reporting; never add account, operation or cursor
labels. Provider acceptance/delivery metrics are unchanged.

## Rollback

Disable new cutoff traffic and stop read-all worker ticks before rolling back the
binary. Retain additive tables, the allocation trigger, indexes and all read
markers; old binaries continue inserting safely. Running operations remain
resumable on roll-forward. Do not reverse readAt or resequence rows. A physical
schema removal needs a later maintenance migration after clients and operations
have drained. This PR does not activate category policies or ADR-0050's later
category rollback procedure.

## Category preferences — PR2

Five configurable categories default true: `invite`, `preference_reminder`,
`plan_ready`, `plan_changed`, `date_reminder`. Absent rows mean true. Migration
0094 preserves master/default consent and does not reconstruct choices from legacy
mirrors. `other` covers campaign/moderation/privacy/unknown kinds and has no switch.
Campaign follows master; moderation gains no push producer; privacy and unknown
kinds never push. The exhaustive notification registry owns channel/event decisions.
Email and inbox remain independent of push preferences.

| Operation                       | Master              | Five choices              |
| ------------------------------- | ------------------- | ------------------------- |
| PATCH master false/true         | Set requested value | Retained                  |
| PATCH one category              | Retained            | Only supplied keys change |
| Enable all: PATCH all five true | Retained            | All true atomically       |
| Existing PUT true               | True                | All true atomically       |
| Existing PUT false              | False               | Retained                  |
| Legacy push opt-out             | False               | Retained                  |
| Legacy push opt-in              | Retained            | Retained                  |

GET `/v1/me/notification-settings` returns `version` as a decimal string,
`categories`, and strong `ETag: "notification-settings-12"`; private/no-store.
PATCH accepts optional `pushEnabled` and partial `categories`, requiring at least
one change, `If-Match` and `Idempotency-Key`. Never send `other`. A successful replay
returns the original result and ETag before stale-version rejection. A new stale
write returns 412 NOTIFICATION_SETTINGS_VERSION_MISMATCH; absent If-Match returns
428 PRECONDITION_REQUIRED. Reusing a key with a different body returns 422.
Refetch after replay to obtain current state. Existing PUT routes gain no header
requirements. Account lock, version, effective legacy mirrors, audit and replay
completion share one transaction. No-op explicit writes preserve version/time.
Export includes configured categories/version; hard deletion cascades, and soft
account erasure explicitly removes preferences and delivery state.

## Kinds filtering

Use `/v1/me/notifications?kinds=invite&kinds=plan_ready` (repeatable query parameter,
form/explode). Filtering happens in SQL before the page limit. Unknown/empty/comma-
joined values return 400 VALIDATION_FAILED. Omission selects all kinds; order and
duplicates have no effect. Cursors bind the canonical set: a different set, including
all versus filtered, returns 400 INVALID_NOTIFICATION_CURSOR. Existing signed page
cursors remain all-kinds. Legacy timestamps and old unsigned tuple cursors belong
to all kinds. Before inbox cutover, filtered tuple fallback cursors retain their
filter and no-snapshot continuation semantics across cutover. Filtered signed pages
retain the same committed sequence cutoff and microsecond/id ordering as all-kinds
pages. Summary and read-through tokens remain unfiltered. Use the existing
`pnpm inbox:backfill` rollout CLI to build/repair
`notifications_inbox_kind_page_idx(user_id,kind,created_at DESC,id DESC)` concurrently;
0094 contains no concurrent index DDL or fleet-wide data backfill.

## Category rollout and conservative rollback

**Rebase/merge #815 (0093) first, then this PR (0094).** Refresh exact contract
hashes after rebasing. CODEOWNER contract/migration review remains separate.

1. Apply 0094 after 0093 (#816). Its additive DDL uses a 5s lock timeout;
   retry after contention clears. The `notification_settings.version` CHECK is
   added `NOT VALID` so nothing is scanned under ACCESS EXCLUSIVE; after
   `db:migrate` returns, run `scripts/ops/validate-notification-settings-version.sql`
   (SHARE UPDATE EXCLUSIVE, retry-safe) to validate existing rows. Existing GET
   remains available. Category-aware preference mutations and outbox dispatch fail
   closed until the key gate opens.
2. Before **every worker binary transition**, stop API/jobs that produce outbox
   events and run `pnpm notifications:categories --quiesce-producers`. This durable
   database fence rejects **all outbox inserts**, including from old binaries;
   the command waits for in-flight producer transactions to commit. Keep producers
   stopped/fenced throughout draining and switching. Plan a maintenance window for
   all outbox-producing business operations; the fence rolls back their transaction.
3. Drain/reconcile **all** unresolved mapped events (dead letters included) with
   the currently running binary and its **existing provider keys**. Initial
   cutover/roll-forward from old workers uses event/locale keys; category-aware
   workers use recipient keys. Reconcile ambiguous provider acceptance using the
   original request/cohort/locale and key; if the result cannot be established,
   **abort the switch and keep the fence**. Never re-key, delete delivery state,
   clear terminal suppression, or mark work published merely to open a gate.
   Once reconciled, stop all old workers and confirm no calls remain in flight.
   Run `pnpm inbox:backfill`, then
   `pnpm notifications:categories --enable-recipient-keys`. The gate requires the
   producer fence and zero unpublished mapped events **regardless of age**, plus
   zero pending/attempting recipient deliveries even on published events. Only then
   deploy/start category-aware API/workers and run
   `pnpm notifications:categories --resume-producers`. Verify gates and the new API.
   Both gates also refuse while any campaign is `sending`: the binary that started
   walking its recipients finishes it.
4. Recipient delivery state is durable (pending/attempting/sent/suppressed/failed/no_target).
   Every cohort is preference-gated before pending work, then eligibility is
   rechecked immediately before every provider call/retry. Each attempt resolves
   **every ledger row of the event**, not only today's members: a recipient staged
   by an earlier attempt who has since left the room or been erased fails the final
   check and ends `suppressed`; an event publishes only when no row is left
   pending/attempting, otherwise it backs off and retries. Per-recipient stable UUID
   keys survive retries and changing locales/cohorts. A 2-minute claim lease allows
   crash recovery; provider idempotency handles acceptance before a DB failure.
   Suppression is terminal and opt-in never replays it. Campaign provider keys and
   public-device consent stay unchanged; account campaigns recheck live audience
   and master before each send and persist terminal suppression. Composer previews
   require a live account/subscription and master consent, but ignore campaign
   room/platform targeting.
5. A preference commit before the final check governs the attempt. A later commit
   can race a provider request already starting/accepted. No transaction spans a
   provider call; a saved preference cannot retract a push. Metrics distinguish
   enqueue, suppression, acceptance/no-target, retry and dead-letter outcomes;
   account/event identifiers and payloads are never metric labels.

For rollback to a pre-category binary, **quiesce/fence producers first** with
`--quiesce-producers`, while leaving the current category-aware workers running to
finish delivery. Drain/reconcile using the current recipient keys: after partial
acceptance retry only unresolved recipients with those same keys; keep sent and
terminally suppressed recipients terminal. Ambiguous acceptance blocks rollback.
Stop the category-aware workers only after reconciliation, then run
`pnpm notifications:categories --rollback-collapse`. This repeats the full delivery
gate, commits the preference write freeze and **disables recipient-key dispatch**,
then collapses at most one account per subsequent transaction. Any disabled category
becomes master=false and all legacy push mirrors=false. The same collapse applies to
an account holding a **terminally suppressed campaign delivery an old binary could
still resume** — a `campaign:<dispatch_key>:<user>` inbox row with `push_sent_at`
null and `push_suppressed_at` set, whose campaign is `scheduled`/`sending`/`failed`
with that dispatch key (`failed → scheduled` keeps the key). The old campaign worker
reads only `push_sent_at` and the master, so master=false is the only form it
respects; `sent` dispatches (no outgoing transition) and cancelled ones (key cleared)
collapse nobody. Such an account rolls back to push off even if it had re-enabled
everything, and roll-forward does not restore it. Category rows, versions,
inbox/read markers, published events, campaign rows and delivery ledgers remain intact.
The operator-only transaction-local `gogo.notification_rollback` bypass is used by
this command; APIs never set it. Database triggers reject INSERT/UPDATE from old
binaries while frozen; deletes remain possible for erasure. New APIs report
503 NOTIFICATION_PREFERENCES_FROZEN. Keep mutation routes unavailable on old binaries
(their DB error may map to 500). Verify collapse reaches zero, switch to old workers,
then run `--resume-producers`; it refuses an incomplete collapse. Re-running is safe.
Do not reopen reconciled published events: old workers do not understand recipient
terminal suppression, and their event/locale keys differ from recipient keys.

On roll-forward, **repeat the producer fence and full drain with the old workers
and their event/locale keys**. Events created after the original cutover timestamp
are included. Stop old workers, run `--enable-recipient-keys`, restore/start the
category-aware binary, then `--unfreeze` and `--resume-producers`. Unfreeze requires
the cutover gate and **never restores master=true automatically**. Normally roll
back to a category-aware revision instead. Do not drop additive tables/columns on
binary rollback.
