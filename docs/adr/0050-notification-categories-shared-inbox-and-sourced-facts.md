**ADR-0050 — Category notification preferences, shared unread state, and sourced reminder facts**

**Date:** 2026-11-08  
**Status:** Solution shape decided by Astra; §6 product policies and the category semantic MAJOR approved by owner on 2026-11-08 (workspace `.claude/rules/execution-policy.md` §8, BE#811 entry). Four-PR implementation staging remains; product policies ship in PR4. Contract and migrations still require separate CODEOWNER approval.

**Scope:** GoGo-BE#811; shared unread capability for #809; consumer GoGo-MobileApp#539.  
**Basis:** Worktree HEAD and local `origin/develop` both `18ca7f4d1a8a27ce292488c292408dc6efe7e14c`. Both specified Stitch screens inspected through their live HTML. No files edited; no tests, builds, or installs run.

**Context and alternatives**

Choose an account-wide master gate **plus five independent category preferences**. This supersedes ADR-0025’s single-switch-only decision while retaining its distinction between account preference, device permission, subscription, and delivery.

Rejected alternatives:

- Reuse legacy per-kind rows as independent choices: ADR-0025 has overwritten them as switch mirrors; they no longer represent original category choices.
- Replace the master with five switches: cannot represent “temporarily stop all push,” including campaigns.
- Implement the issue’s example categories literally: they differ from the actual Stitch controls.

The [mobile handoff](/Users/maxnguyen/MyWorks/GoGo/dev/handoffs/g10-plan.md:1) inspected another revision. Its richer notification payloads are **not present at this review head**; Sol must not assume those fields already exist.

**1. Categories and event mapping**

The five configurable keys deliberately match the corresponding existing notification kinds.

| Exact Stitch label   | Category key          | Existing kind         | Existing producer/event                             |
| -------------------- | --------------------- | --------------------- | --------------------------------------------------- |
| Lời mời vào phòng    | `invite`              | `invite`              | `member.joined`; currently targets the host         |
| Nhắc chọn sở thích   | `preference_reminder` | `preference_reminder` | `preferences.completed`; currently targets the host |
| Kế hoạch đã sẵn sàng | `plan_ready`          | `plan_ready`          | `plan.published`; members                           |
| Kế hoạch có thay đổi | `plan_changed`        | `plan_changed`        | `plan.changed`; members                             |
| Nhắc lịch đi chơi    | `date_reminder`       | `date_reminder`       | `room.status_active`; members                       |

These mappings classify existing behavior; they **do not establish that the existing events implement Stitch’s described invitation or reminder behavior**. See [current dispatcher mapping](/Users/maxnguyen/MyWorks/GoGo/dev/worktrees/be-811/libs/modules/notifications/application/outbox-dispatcher.ts:22).

Use one additional, **non-configurable** category, `other`, to classify every remaining existing kind:

| Kind                   | Category | Delivery rule                                                                           |
| ---------------------- | -------- | --------------------------------------------------------------------------------------- |
| `campaign`             | `other`  | Existing account campaign policy follows master; unchanged device-public consent policy |
| `moderation_update`    | `other`  | No new push producer authorized by this ADR                                             |
| `privacy_export_ready` | `other`  | In-app only, always                                                                     |
| Unknown future kind    | `other`  | Preserve inbox fallback; **no push until explicitly registered**                        |

This is five switches, not six. Do not misclassify campaigns or moderation as plan changes. Do not introduce contribution or matchmaking switches.

Maintain one exhaustive registry containing kind, category, allowed channels, and producer mapping. A new known kind requires a registry decision and tests. Unknown domain events remain non-notification events unless explicitly registered.

**2. Preferences, defaults, migration, and rollback**

Keep `notification_settings` as the account master. Add:

```text
notification_category_preferences
  user_id       FK users, ON DELETE CASCADE
  category      constrained to the five configurable keys
  enabled       boolean
  updated_at    timestamptz
  PRIMARY KEY (user_id, category)

notification_settings.version
  bigint, monotonically increasing for any effective preference change
```

The shared decision is:

```text
push permitted =
  kind explicitly supports push
  AND existing recipient eligibility
  AND master.pushEnabled
  AND category.enabled             // configurable categories only
```

`other` does not bypass the master. No emergency bypass is introduced.

**Defaults and migration**

- Preserve today’s effective master, including ADR-0025’s fallback when no settings row exists.
- Default all five category preferences to `true`. Absent category rows mean `true`.
- An existing master-off account remains completely off.
- Do not reconstruct category consent from mirrored legacy rows.
- Materialize missing settings rows when first mutated, under the existing account choice lock.
- Preference changes, version increment, legacy mirrors, and audit entry commit together.
- Preserve email behavior. Export the five preferences; account deletion cascades them.

**Write semantics**

| Operation                                            | Result                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| New master off/on                                    | Changes master only; remembers category choices                                 |
| Individual category change                           | Changes that category only; never enables master                                |
| “Bật tất cả”                                         | Sets all five categories true atomically; leaves master unchanged               |
| Existing `PUT /me/notification-settings` with `true` | Preserves its global-enable meaning: master and all five categories become true |
| Existing PUT with `false`                            | Master becomes false; category choices retained                                 |
| Legacy per-kind push opt-out                         | Still disables the master                                                       |
| Legacy per-kind push opt-in                          | Never enables master or overrides a disabled category                           |

Legacy preference GET should report each kind’s **effective** permission. This changes its published semantics; see §3.

Mirror effective per-kind permission into legacy push rows, including campaign handling. Do not let legacy writes alter those mirrors independently.

**Migration execution**

The original basis ended at `0078`. On `origin/re-design`, preserve migrations
through `0090`; this slice uses `0091_notification-shared-inbox` and
`0092_notification-erasure-fence`. Separate short DDL from resumable data backfills. Build large-table indexes using the repository-supported nontransactional/concurrent mechanism. Do not put one fleet-wide backfill in a long transaction.

**Rollback boundary**

An unmodified ADR-0025 worker ignores category choices. Rolling it back with master=true would resume disabled categories.

Therefore, rollback to `18ca7f4d` requires:

1. Fence outbox producers (`--quiesce-producers`), drain/reconcile all unresolved
   mapped events and pending/attempting deliveries with the current binary and
   existing provider keys, then stop workers. Ambiguous acceptance blocks either
   binary transition; never re-key accepted work or clear terminal suppression.
   `--rollback-collapse` checks this gate, disables recipient-key dispatch and
   freezes preference mutations before collapsing any accounts.
2. For accounts with any disabled category, conservatively set master=false and all legacy push mirrors=false.
   Collapse the same way any account holding a terminally suppressed campaign
   delivery under a dispatch the old binary can still pick up or reopen
   (`scheduled`/`sending`/`failed` with its kept dispatch key): the old campaign
   worker reads only `push_sent_at` and the master, so master=false is the only
   durable form it respects. Campaign rows and ledgers are never rewritten; a
   campaign still `sending` blocks either binary transition.
3. Retain category rows, versions, read states, and additive schema.
4. Keep preference mutations frozen until a category-aware release returns.

This may suppress additional categories; it must never resume an opted-out category. Before resuming producers on an old binary, verify collapse is complete. Keep
reconciled published events and terminal delivery ledgers intact: old workers
cannot interpret recipient suppression. Roll-forward repeats the producer fence
and reconciliation using old event/locale keys for every unresolved event,
including events newer than the original cutover. On roll-forward, do not
automatically restore master=true. Normal rollback should target a category-aware revision once one exists.

**3. API and shared unread/read-all contract**

All paths below are under `/v1`; authenticated account only. Controllers delegate to notification application services.

**Preferences**

Extend GET `/me/notification-settings` with optional additive fields:

```json
{
  "pushEnabled": true,
  "source": "explicit",
  "updatedAt": "2026-11-08T10:00:00Z",
  "version": "12",
  "categories": {
    "invite": true,
    "preference_reminder": false,
    "plan_ready": true,
    "plan_changed": true,
    "date_reminder": true
  }
}
```

Return a strong ETag over this resource version. Version is a decimal string to avoid JavaScript integer precision loss.

Add PATCH `/me/notification-settings`:

```json
{
  "pushEnabled": false,
  "categories": {
    "date_reminder": false
  }
}
```

Fields are optional individually; require at least one change. Omitted categories remain unchanged. “Bật tất cả” submits all five true in one PATCH. The UI derives the configured count from these five booleans and displays master suspension separately.

New PATCH requires `If-Match` and `Idempotency-Key`. Check concurrency under the account lock. A successful replay precedes stale-version rejection and returns the original result without applying another mutation. Persist mutation and replay completion in the same transaction using the existing manual-idempotency facilities.

Do not newly require these headers on existing PUT routes.

**Unread: one implementation shared with #809**

Add GET `/me/notifications/summary`:

```json
{
  "unreadCount": 23,
  "asOf": "2026-11-08T10:00:00Z",
  "readThroughCursor": "<opaque-account-bound-token>"
}
```

- Source: account-owned `notifications` rows with `read_at IS NULL`.
- Count all inbox kinds, including in-app-only kinds; push preferences do not change the count.
- Bell, “N mới,” and #809 use this endpoint and one account-scoped client cache.
- No count from loaded pages, OneSignal analytics, or a separately maintained profile counter.
- Compute count and cutoff in one database snapshot. Use `Cache-Control: private, no-store`.
- Read operations invalidate/refetch this summary. A replayed mutation response is not a current count.

**A precise cutoff**

Add:

```text
notification_inbox_state(user_id PK/FK, last_sequence bigint)
notifications.inbox_sequence bigint
UNIQUE(user_id, inbox_sequence)
```

Every inbox producer—including campaigns and privacy exports—assigns sequence numbers under the same short per-account lock, held until its insert commits. Sequence allocation and insert are atomic; deduplication remains intact.

A plain global sequence or `created_at <= now()` does not establish commit order. The per-account serialization prevents a late commit from appearing below an already-issued cutoff.

Backfill historical rows in bounded batches while new writers assign sequences. Enable cutoff APIs only after backfill completes and old writers are drained. Sequence order defines cutoff membership; display order remains `(createdAt DESC, id DESC)`.

**Mark all read**

Add POST `/me/notifications/read-all`:

```json
{ "through": "<readThroughCursor>" }
```

Require `Idempotency-Key`. The signed token contains account, committed sequence cutoff, capture time, schema version, and expiry; proposed validity: 24 hours.

Create a durable operation:

```json
{
  "operationId": "<uuid>",
  "status": "running",
  "asOf": "2026-11-08T10:00:00Z",
  "changedCount": 500
}
```

Return `200` if completed immediately; otherwise `202` with a Location for GET `/me/notifications/read-all/{operationId}`.

- Process at most **500 rows per transaction**, with a bounded worker tick.
- Mark only unread rows at or below the fixed cutoff.
- Preserve existing `readAt`; all rows changed by this action receive its recorded action timestamp.
- New arrivals above the cutoff stay unread.
- Persist progress and affected-row counts atomically; restart after crashes.
- Concurrent single-read or bulk operations cannot double-count changes.
- Retrying the same request resumes/replays the same operation.
- Account deletion removes operation state.
- After completion, refetch summary; unread need not be zero because new notifications may have arrived.

Index unread lookup by `(user_id, inbox_sequence) WHERE read_at IS NULL`.

Keep POST `/me/notifications/{id}/read` and its existing success shape/status. Change only unread rows so retries preserve the first `readAt`. Foreign/missing IDs remain indistinguishable. **“Để sau” calls this action only; it never declines or revokes an invitation.**

**Inbox pagination**

Return opaque cursors with `(createdAt,id)` tie-breaking; accept previously issued timestamp cursors during transition. New cursors bind filter and snapshot cutoff.

Add optional server-side category filtering if shipping Stitch chips. Suggested grouping: invitations=`invite`; plans=`preference_reminder,plan_ready,plan_changed`; appointments=`date_reminder`; all includes `other`. Never present filtering of one loaded page as the complete inbox.

**Errors**

Use the standard envelope, with:

| Status    | Code                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| 400       | `VALIDATION_FAILED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_NOTIFICATION_CURSOR` |
| 401 / 403 | Existing authentication error / `USER_ONLY`                                   |
| 404       | `NOTIFICATION_READ_OPERATION_NOT_FOUND`, including foreign operations         |
| 409       | `IDEMPOTENT_REQUEST_IN_FLIGHT`                                                |
| 410       | `NOTIFICATION_CURSOR_EXPIRED`                                                 |
| 412       | `NOTIFICATION_SETTINGS_VERSION_MISMATCH`                                      |
| 422       | Existing `IDEMPOTENCY_KEY_REUSED`                                             |
| 428       | `PRECONDITION_REQUIRED`                                                       |
| 429 / 503 | Existing rate-limit/unavailability envelope                                   |

**Contract version decision**

The count, read-all, optional payload facts, and new operations are additive **MINOR** changes.

The complete preference replacement is **MAJOR under the repository’s current policy**. Existing guarantees say one switch determines every kind and legacy GET reports that value for every push kind. Independent suppression withdraws those guarantees. New paths alone do not eliminate that semantic change. See [ADR-0025](/Users/maxnguyen/MyWorks/GoGo/dev/worktrees/be-811/docs/adr/0025-single-push-notification-switch.md:40) and [contract version policy](/Users/maxnguyen/MyWorks/GoGo/dev/worktrees/be-811/openapi/CHANGELOG.md:8).

On the rebased `origin/re-design` contract (`7.6.0-alpha.1`), use
`7.7.0-alpha.1` for the additive slice. Activated category semantics require the
next available MAJOR version, subject to versions already landed. **Correct #811’s blanket MINOR assumption before publication.**

Run oasdiff later against the actual base/head artifacts. Preserve old request schemas and statuses; add optional response fields; keep extensible kinds. A clean structural diff does not prove semantic compatibility. Any required exception must identify the exact diagnostic and contract hashes with CODEOWNER approval—never a blanket waiver.

**4. Dispatcher and preference races**

Keep the existing PostgreSQL outbox/worker architecture. This head polls PostgreSQL; it does not need a new BullMQ notification queue.

- Always record the business event. Transactional inbox creation is independent of push permission.
- Apply the shared category predicate **before creating push delivery work**, then recheck immediately before each provider attempt, including retries.
- Campaign estimate and account send share the same campaign/master predicate. Preserve existing campaign audience and device-public consent behavior; do not broaden campaign inbox eligibility.
- Disabling push does not erase an existing inbox item.
- A suppressed delivery is terminal. Re-enabling a category does not replay old suppressed notifications.
- Recheck recipient eligibility, account deletion, and current room access before sending.

Use durable per-recipient delivery state and a stable provider key derived from event plus recipient. Preserve existing campaign keys. Do not reuse one event/locale key with changing recipient cohorts; that can lose or misapply retries.

Before switching existing outbox sends to recipient keys, quiesce and drain pre-cutover deliveries using their original keys. Unresolved or ambiguously accepted deliveries must not be blindly re-keyed.

**Race guarantee:** a preference change committed before the final eligibility check governs the attempt. A change after that check may race an already-starting or accepted provider request. Never claim that a saved preference can retract a push. Do not hold a database transaction across OneSignal calls.

Record bounded metrics for category, kind, suppression reason, enqueue/send outcome, retry, dead letter, and read-all progress. Distinguish provider acceptance from device delivery. Logs contain correlation/event identifiers and versions, not payloads, addresses, tokens, or raw provider errors containing sensitive data.

**5. Reminder and preview facts**

The existing `room.status_active → date_reminder` means **the outing started**, not “two hours remaining.” Keep this distinction explicit; the approved advance-reminder scheduler is implemented separately in PR4.

Add optional payload structures; historical rows remain valid without them:

```text
reminder:
  trigger: room_started | scheduled
  triggeredAt: UTC instant
  scheduledFor: UTC instant | null
  startsAt: UTC instant | null
  leadTimeSeconds?: integer
  scheduleRevision?: string

planPreview:
  planId
  planVersion
  constraintVersion
  capturedAt
  startAt?: UTC instant
  startAtSource?: room_constraints
  stopCount
  stops: bounded array, maximum 3
    position
    arriveAt?: UTC instant
    placeId
    name?: SourcedText
    addressText?: SourcedText

SourcedText:
  value
  sourceType: gogo
  originType: editorial | community | provider
  verifiedAt
  collectedAt?: UTC instant
```

`provider` requires independently evidenced, persistable **non-Google** origin; the label alone proves nothing.

- Snapshot event-time plan identifiers, schedule facts, selected stop facts, and approved place text in the originating transaction, with no provider calls.
- Use `room_constraints.start_at` as the proposed reminder schedule authority; do not interpret a date-only field as a confirmed appointment time. Stop arrival times remain separately sourced.
- Snapshot only independently sourced GoGo-owned fields. Apply existing address ownership rules from [ADR-0031](/Users/maxnguyen/MyWorks/GoGo/dev/worktrees/be-811/docs/adr/0031-gogo-owned-place-contact-fields.md:38).
- A canonical database column is not proof of ownership. Missing, unknown, or Google-derived provenance means omit the text.
- Never persist Google names, addresses, coordinates, photos, ratings, or hours in notification payloads, outbox records, delivery jobs, or replay records.
- Do not backfill historical snapshots using today’s place or plan values.
- If images are later included, snapshot approved GoGo media IDs only; resolve authorized current media availability separately.

Read current membership/access and resource availability live. Opening a historical preview resolves the current authorized plan; it does not promise the snapshot remains current. Suppress sensitive preview fields when access is revoked.

Keep private evidence references and actor identities server-side. Push contains routing identifiers and generic localized copy; place/address snapshots remain in the authenticated inbox response.

**6. Product policies — owner approved 2026-11-08; implementation in PR4**

Binding source: workspace `.claude/rules/execution-policy.md` §8, **2026-11-08 — GoGo-BE#811**. The owner approved Astra's policy recommendations and contract staging below. This records product approval; it does not replace contract/migration CODEOWNER approval or claim PR1 implements these policies.

| Policy              | Approved decision                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-hour reminder   | One reminder **120 minutes before** a confirmed start; absent start means no reminder. Reschedule/cancel on schedule changes; skip after start. Newly confirmed inside the window sends once immediately while still before start. |
| Quiet hours         | **Default off**. Opt-in **23:00–07:00** in the stored IANA timezone; defer push until the window ends, rechecking relevance and preferences. Inbox remains immediate.                                                              |
| Emergency exception | **No exception**. No quiet-hour bypass or master/category opt-out bypass.                                                                                                                                                          |
| Seven-day cleanup   | **No automatic cleanup**. Remove the seven-day cleanup claim from UI; no archive or deletion job is authorized.                                                                                                                    |
| Contract staging    | PR1 is **MINOR**; independent category semantics in PR2 require **MAJOR 8.0.0**. Owner signs CODEOWNER after review.                                                                                                               |

PR4 quiet-hour implementation must define DST handling, absent timezone behavior, expiry while deferred, and cancellation. The approved behavior defers push; replace Stitch's claim of automatically muting sound.

No retention/archive job is part of PR4. A future change needs a new owner decision, real linked invitation/expiry where relevant, and replay/dedupe retention analysis; the current `invite` emitted for `member.joined` is insufficient.

**Can proceed independently:** preference model/filtering, unread/read-all, provenance-safe payload structures, event-time snapshots, and compatibility work, subject to normal contract gates.

**Staged for PR4:** approved advance-reminder scheduler and opt-in quiet-hour delivery behavior. No emergency exception or automatic cleanup is authorized. Group 10 UI still waits for the agreed BE scope; partial BE delivery does not waive the owner’s UI gate.

**7. Verification, PR sequence, and consequences**

This is proposed verification coverage, not executed evidence.

| Layer                   | Required coverage                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                    | Exhaustive kind/category mapping; unknown-kind suppression; master/category truth table; “enable all”; legacy writes; provenance omission; fact-only payloads                                                                             |
| Contract                | Old requests still accepted; ETag and replay semantics; error statuses; optional historical payloads; extensible kinds; generated consumers; exact-base oasdiff                                                                           |
| Integration             | Migration defaults; concurrent preference writes; export/delete; all inbox producers assign sequences; equal timestamps; late commits; concurrent arrivals/reads; operations beyond 500 rows; crash/retry recovery; account-bound cursors |
| Delivery regression     | Opt-out between enqueue/send and before retries; no backlog replay on opt-in; provider timeout after acceptance; stable dedupe keys; campaigns; privacy-export never pushed; removed members/deleted accounts                             |
| Rollback                | Forward → conservative collapse → old predicates → forward; no opted-out category resumes; read markers remain preserved                                                                                                                  |
| Approved policies (PR4) | 120-minute boundary, absent start, reschedule/cancel, stale plans, late scheduling, default-off quiet hours, DST/timezone changes, expiry while quiet, no emergency bypass, no automatic cleanup                                          |

The current single-read endpoint rewrites `readAt`, and current pagination uses only timestamps; both need focused regression coverage ([controller](/Users/maxnguyen/MyWorks/GoGo/dev/worktrees/be-811/libs/modules/notifications/presentation/notifications.controller.ts:39)).

Use ordered PRs, each containing its own implementation, contract, tests, telemetry, and documentation:

1. **Shared inbox capability:** ADR, common insertion/sequence support, summary, bounded read-all, single-read/pagination corrections. Own #809’s unread requirement here.
2. **Category preferences:** schema, legacy compatibility, versioned API, delivery filtering, retry/cutover safeguards, rollback procedure. Publish the owner-approved semantic **MAJOR 8.0.0** change (PR1 stays MINOR).
3. **Sourced payload facts:** event-time reminder/plan preview facts; no assumed two-hour schedule.
4. **Approved policies:** implement the 2026-11-08 decisions: 120-minute reminders and opt-in 23:00–07:00 quiet hours (default off), no emergency exception and no automatic cleanup. No cleanup job ships.

Consequences: old clients retain callable endpoints but cannot fully represent mixed category state; category-aware clients must regenerate from the contract. Read-all adds durable operation/progress state. Preference changes govern future eligible attempts, not already accepted pushes. Missing provenance intentionally produces less preview content.

**Findings-style risks**

- **[R-01] Contract version conflict — breaks when** independent category behavior ships as MINOR while claiming ADR-0025’s single-switch guarantees remain unchanged. Record the semantic MAJOR decision and consumer coordination.
- **[R-02] Misleading event semantics — breaks when** host notifications from `member.joined` or `preferences.completed` are rendered as an incoming invitation or a request for the recipient to choose preferences. Classification alone does not implement those workflows.
- **[R-03] False advance reminder — breaks when** `room.status_active` is presented as “two hours remaining,” or delivery time is substituted for confirmed appointment time.
- **[R-04] Prohibited snapshot persistence — breaks when** existing canonical columns or provider responses are copied without field-level independent provenance. Attribution does not permit Google persistence.
- **[R-05] Rollback resumes opted-out push — breaks when** an ADR-0025 worker runs with master=true and any new category=false. Enforce the rollback collapse and write freeze.
- **[R-06] Unread corruption — breaks when** bulk read uses an unbounded update, page length as total, timestamp-only cutoff, or a sequence allocated outside commit-order serialization.
- **[R-07] Duplicate/lost delivery — breaks when** provider keys change across deploy/retry, or an event-wide key is reused for a changed recipient cohort.
- **[R-08] False dependency readiness — breaks when** Sol assumes the handoff’s #753 payload fields exist at `18ca7f4d`, or Group 10 starts UI before the agreed BE contract is ready.
- **[R-09] Retention destroys correctness — breaks when** cleanup deletes all seven-day-old notifications, removes dedupe evidence needed by retries, or treats a member-joined notice as an expired invitation.

## PR2 implementation record — 2026-11-09

Owner addition: server-side `kinds` on GET `/v1/me/notifications`, repeatable
form/explode, known NotificationKind validation (unknown => 400). Canonical filter
sets bind signed and pre-cutover fallback cursors; a different filter => 400
INVALID_NOTIFICATION_CURSOR. The sequence snapshot and microsecond/id ordering
are preserved. Summary unreadCount remains all-kinds. The filtered index is built
CONCURRENTLY by the existing inbox rollout CLI, outside transactional migration.

Contract **8.0.0-alpha.1** implements §1–4 preference behavior: five configurable
choices and non-configurable other, default-true sparse rows, strong ETag/versioned
PATCH with transactional manual idempotency, legacy PUT compatibility, effective
legacy mirrors, export/erasure, recipient-level delivery state and stable provider
keys, final attempt/retry eligibility checks, explicit old-key drain gate, terminal
suppression, and bounded rollback collapse with a durable DB write freeze.
Migration **0094** follows #815/0093: rebase **#815 first, then this PR**. No fleet
backfill is needed for default-true categories. The `notification_settings.version`
CHECK is added `NOT VALID` and validated after `db:migrate` commits
(`scripts/ops/validate-notification-settings-version.sql`), so the hot table is
never scanned under ACCESS EXCLUSIVE. Normal API changes are blocked until
the recipient-key cutover gate opens. See `docs/notification-inbox.md` for commands,
lease/crash behavior, rollback and the unavoidable provider-call race window.

The compatibility checker produces a separate exact ADR-0050 semantic diagnostic
when the structural diff cannot observe the withdrawn one-switch guarantee. It
requires a MAJOR and exact base/revision hashes in the exception file; unrelated
structural findings still fail. Owner authorization is dated 2026-11-08; it does
not assert CODEOWNER sign-off. Recompute the exception after a base/spec change.

PR4 scheduled reminders/quiet hours remain separate.
Verification evidence is reported by the implementation session; code presence
does not establish deployment or acceptance.

## PR3 implementation record — 2026-11-09

Contract **8.1.0-alpha.1** (additive MINOR) implements §5 with optional reminder,
planPreview and inviterAvatar facts; existing JSON storage needs no migration
after **0094**. Plan-version writes capture the newly written plan/stops, with
their identifiers and versions, inside the originating transaction. Publish,
edit and regenerate share that seam. Room activation captures current confirmed
start and trigger=`room_started`, scheduledFor=null; it does not schedule an
advance reminder. Join captures permitted inviter display and GoGo avatar facts.

Canonical place columns are projected only through field provenance: independent
editorial/community names require an origin reference and verifiedAt; addresses
use ADR-0031, and provider text also requires independently collected non-Google
evidence. Private references/actors never enter public SourcedText. Unproven text
is omitted. No Google place content, provider calls, or AI is added to snapshots.
Optional stop mediaId identifies approved uploaded editorial/community place
media without providerPhoto; approved Google photos are excluded even under #786.
Inviter avatar is a processed GoGo mediaKey, never an external URL or account ID.

Fan-out copies only stored new facts; legacy events/rows receive no reconstructed
preview/reminder/avatar. Inbox reads recheck current account/room membership,
inviter access, plan presence, place publication and media availability, stripping
private membership evidence and suppressing sensitive/unavailable fields without
rewriting stored JSON. Opening still resolves the current authorized plan.
Metrics contain bounded kind/fact/presence labels only. Details and rollback
boundary (retain the access-aware API when serving new snapshots) are in
`docs/notification-inbox.md`. Tests cover producer transactions, delayed dispatch,
supersede/retry, provenance omission, media/access revocation and legacy payloads.
Executed gate results belong to the implementation report, not this design record.

PR4 alone implements the approved 120-minute reminder and opt-in quiet hours.
