# ADR-0054: Free-first actual-cost assistant credit funding (#851 D1 / #853 D2 / #832)

Date: 2026-11-11. Status: D1/D2 implemented locally; activation and DEV acceptance unverified.
Authority: Astra rev2 shape, implementation brief and owner decision 2026-11-11
“phương án A” (`dev/policy/decisions-log.md`), which supersedes rev2 §3
for inline finality and post-final upward losses.
Supersedes pricing passages of ADR-0040/0036; extends ADR-0053 visibility.

The daily free limit is ASSISTANT_USER_DAILY_MAX_MESSAGES (DEV configured to 5),
never a literal product constant. Count daily-funded accepted sends in the VN day,
including legacy same-day rows; failed free sends remain consumed and free forever.
Replay resolves original messages and current accounting facts before readiness.
Credits never refill at midnight. Burst, master switch, provider/BYOK and global
budget protections apply to both funding sources.

Migration 0099 preserves 0098 and historical data. Spend control starts at
legacy_allowance_v1 / epoch 0, retaining daily-then-one-credit admission exactly.
The audited ops-only switch changes new admissions to free_then_actual_cost_v1;
no flag silently rewrites frozen policy. Control FOR SHARE -> account advisory
lock -> global budget -> active user/conversation -> usage/turn rows. Provider I/O
always follows commit. Grants and erasure retain the shared account lock.

Paid funding requires both spend and settlement switches, a positive exact-decimal
ASSISTANT_CREDIT_BOUND_USD and matching ASSISTANT_CREDIT_BOUND_VERSION installed
as control.bound_version by an audited billing-readiness operation. The existing
calibrated turn ceiling is not evidence. D1's activation script leaves bound_version
NULL, so it cannot enable paid admission. D2 must supply recoverable per-call
cost attribution, finality and whole-turn bound/config/pricing evidence before
binding it. Flags alone or an arbitrary configured number do not prove readiness.

A verified bound B reserves R=max(1,ceil(B/0.00001 USD)). Only balance-sum(H) can
fund a reservation. Insufficient funding refuses before acceptance with typed
409 details; unready paid billing refuses 503. Free sends require no wallet,
ledger row or hold. Holds have one source: assistant_credit_turns.

Exact decimal components are summed before ceiling. Unconstrained numeric per-call
storage preserves precision. Checked int32 writes and safe JSON integers prevent
overflow. Complete authoritative revisions apply aggregate targets under the
account lock; first debit is message_spent, later signed differences are
assistant_usage_adjustment. Refunds reduce spent, never increase earned.
Before finality H+A=R; finality releases residual H without a positive ledger row.
Revisions are deduplicated; zero differences still advance the applied revision.
Over-bound targets before finality quarantine and disable new paid admission,
never create debt or collect from future grants. Post-final upward corrections are
GoGo losses, recorded for Cost Center without another user debit. A runner that proves no call was
attempted fences all later dispatch before releasing the hold. Unknown dispatch
or cost never becomes zero by TTL, SSE completion, or orphan recovery.

Contract 10.0.0-alpha.1 is MAJOR: variable paid price, holds, positive-but-insufficient
balance, new 409, required status/conversation facts and open CMS reasons withdraw
published guarantees. Unknown historical attribution stays null/unavailable;
202/replay/page totals cover the full conversation in one accounting snapshot.
This MAJOR covers D1 only. S3 must reclassify any later breaking changes against
this shipped contract; it cannot reuse a release number for unshipped changes.

Owner addition 2026-11-11 (credit history by day and conversation): within this
MAJOR, MyCreditEntry adds optional nullable conversation {id,title} and
eventLabels {vi,en}. Usage resolves through the D turn's conversation_id, or
for legacy usage through usage_ledger_id -> usage.message_id -> message ->
conversation. Every link is owner-scoped; deleted, expired (the existing 90-day
read rule), foreign or unknown conversations return null. A known D turn never
falls back to a legacy link. Non-usage rows return null. Event grant labels
come from credit_events.labels, not composed text. Page selection remains 11
ledger rows for a 10-row response with the existing ordering/cursor; only then
do primary-key joins enrich the page, requiring no new indexes. Clients group
the UTC facts by their local day and conversation.

Ops sequence: apply DDL; run index-assistant-credit-spend.sql in autocommit;
validate-assistant-credit-spend.sql; deploy compatible fleet and tolerant readers;
fence/drain old writers; review release/evidence manifest; execute audited policy
switch. Never execute cutover as an automatic migration. Paid flag defaults false;
settlement flag defaults true. Pausing settlement also blocks new paid admissions.
Metric assistant_credit_admission_total uses only bounded funding/outcome labels.

Rollback disables new paid reservations, preserves real free allowance and reads,
and drains accepted financial liabilities with compatible code. A settlement
incident pauses financial application/release while retaining evidence and holds.
Never restore a hold-blind -1 writer, shrink constraints or drop financial tables.
D1 supplied the funding primitives; D2 supplies the evidence, settlement, recovery
and privacy lifecycle below. Paid activation evidence remains a separate gate.

Validation: deterministic unit/property tests plus named Testcontainers D01/D03/
D04/D05/D09 specs. Docker integration and live provider/consumer DEV acceptance
are separate execution gates; no deployment or paid activation is claimed.

D2 (#853) implementation decisions:

- Migration 0100 succeeds 0099, without modifying it, switching policy, certifying
  a bound, or enabling flags. The receipt journal preserves all valid decimal
  components, including conflicting evidence. Scrubbed billing incidents survive
  erasure and keep new paid admission blocked until audited resolution.
- Existing Jev/Haiku adapters receive one billing observer per accepted turn.
  Before each actual attempt, it commits an intent, then a dispatch claim under
  account → usage locks. The claim checks the active subject, master/provider
  safeguards, terminal-message fence and live generation lease. A claim can be
  ambiguous across a crash; recovery never repeats inference. Provider generation
  identity is persisted as soon as a chunk/response supplies it, even if text or
  answer validation subsequently fails. Each streaming attempt remembers IDs
  only after successful persistence; repeated chunk IDs add no database work.
  A new attempt has its own ID set. No prompt/header/token/payload copy is
  admitted to billing storage. The correlation UUID is metadata, not a token.
- Numeric JSON cost lexemes use Node >=22 source context, before Number rounding.
  Exact per-call decimals remain unconstrained numeric. Direct Jev uses its
  reported charge once. BYOK composition uses upstream inference plus OpenRouter
  fee; shared-capacity composition counts direct OpenRouter cost once and does
  not add its already-included upstream projection.
- Receipt ingestion deduplicates by attempt, authoritative revision and canonical
  component fingerprint. Stale evidence cannot move the current revision. A
  correction back to a previous amount remains a new revision. Same-revision
  conflicts quarantine and retain both pieces of evidence. The usage revision,
  turn received revision and cost-reconcile outbox event commit together.
- A terminal message permits durable dispatch closure. Unclaimed intents become
  proven-zero final attempts; dispatched attempts without cost stay unknown.
  Every aggregate must be complete and dispatch-closed before financial posting.
  All attempts must be final before final release. Valid inline receipts become
  final at ingestion with `finality_policy=inline_receipt_v1` (GoGo policy, not a
  provider SLA); dispatch closure is still required. Recovered missing cost uses
  `recovered_receipt_v1`. Pre-policy complete receipts are promoted per usage
  with `recorded_receipt_v1`, without GET. Free turns capture inline costs and
  normal-path corrections but never debit, recover via GET or reschedule hourly.
- The shared application service uses D1 account-locked revision primitives.
  Full latest provider components and every receipt remain Cost Center evidence.
  At call finality `billable_cost_usd` freezes the billable total; later evidence
  may only lower it. This also prevents a correction that arrives before the
  first financial application from increasing the final inline amount.
  Post-final upward differences emit `assistant_credit_post_final_cost_absorbed_total`
  and `assistant.post_final_cost_absorbed` audit records, without ledger debit.
  Normal-path authoritative downward corrections may refund; no polling seeks
  either correction. Finality never reopens on a non-final correction receipt.
  One base debit survives refund-to-zero; later deltas are revision-unique signed
  adjustments. Ledger/account/A/H/applied revision/audit/notification marker are
  atomic. Financial counters emit after commit. Hold-release credits and
  accepted-to-final latency emit only on the first transition to financial
  finality; a later downward correction emits refund credits without another
  hold release or latency sample. Int32 refund overflow and missing
  wallet arithmetic quarantine, preserving funds instead of retrying a debit or
  creating debt. Public contracts remain 10.0.0-alpha.1; D2 adds no wire fields.
- Migration 0101 adds durable per-usage `recovery_attempts/recovery_next_at`,
  call `finality_policy/billable_cost_usd`, and `receipt_missing` incidents.
  0099/0100 remain unchanged. Existing complete calls are upgraded per usage,
  avoiding a table-wide historical UPDATE. Apply DDL before compatible writers;
  validate deferred CHECKs in the existing ops phase. Rollback disables paid
  admission and retains these additive columns, receipts, holds and incidents;
  drain with compatible code, never reset recovery counters or restore polling.
- The worker has a dedicated outbox consumer (notification fanout excludes its
  events), bounded indexed sweep, expiring per-turn CAS claims, retry/backoff and
  the existing periodic worker_leases row. Discovery holds no usage-row lock while
  waiting for an account. Completion/ACK takes account → turn → outbox locks,
  matching erasure; identity is discovered before waiting and rechecked after
  acquiring the account lock. The sweep uses separate existing
  `(state,next_reconcile_at)` index ranges: pending/reconciling NULLs discover
  initial reservations, while settled turns require a non-NULL due marker.
  Ingestion sets that marker atomically with the revision and wakeup; completion
  checks for an unapplied intervening revision under the same account lock.
  Settled NULL history is excluded before usage checks (the sweep needs none).
  Recovery reads generation metadata only. A lost ACK
  replays the revision; a missed wakeup is repaired by the sweep. Financial pause
  keeps inline cost capture and bounded missing-cost recovery running and retains holds.
  Only unknown paid calls with generation identity can GET. The budget is **five
  GET claims total per usage**, shared across all calls, stricter than five per
  call. `RECEIPT_RECOVERY_MAX_GETS`, `RECEIPT_RECOVERY_BACKOFF_SECONDS` and
  `RECEIPT_RECOVERY_WINDOW_SECONDS` own the policy: first attempt at acceptance
  +5m, then delays of 15m, 1h, 4h and 12h after the preceding claim, all before
  acceptance +24h. Late ticks never catch up in a burst. Claim commits under the
  account lock before I/O; failures, aborts and crashes consume an attempt.
  Exhausted budgets wait for the 24h deadline. Still-unknown paid cost, including
  missing generation identity, quarantines with the hold intact, a durable
  `receipt_missing` incident, bound-violation metric and static Sentry error alert.
  Existing incident semantics block new paid admissions. No missing-as-zero or
  TTL-to-free conversion. Finished/free/quarantined work has no scheduled retry.
  Ordinary financial pause retries remain bounded by their existing backoff. Spend-off does not cancel funded
  work. Master-off fences new dispatch, while dispatched liabilities reconcile.
- Bound readiness additionally requires an environment-scoped, current, unrevoked
  versioned artifact, matching exact B, live provider/models/caps/config hash and
  explicit pricing revision. Immutable bound/finality evidence digests and complete
  attempt/abort/fee coverage are required. Digests reference reviewed evidence;
  they do not certify it themselves. No artifact is shipped by this change.
- Account erasure under the common lock clears turn/user/message/conversation
  linkage, call/provider correlations, wallet and queued payload/linkage. It
  captures usage IDs while clearing the turns, before scrubbing their outbox
  records. Late work rechecks identity and cannot recreate a wallet. Scrubbed financial evidence and
  safety incidents remain. Conversation deletion keeps funding. Unresolved D cost
  is excluded from the 400-day usage purge, including a settled paid turn with
  an unapplied received revision. Retention discovers candidates without locks,
  then rechecks identity, age, incidents, finality and applied revisions under
  the ingestion account lock in a transaction per candidate. Correlation scrub
  and usage deletion commit together. Resolved provider correlation is removed
  at that retention boundary. Self export pages own credit facts/holds
  and signed ledger entries through the existing byte budget, excluding provider
  identifiers. Existing balance export remains available.

Provider evidence limitation / activation blocker:
[OpenRouter generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
provides per-generation cost retrieval, and its
[usage-accounting reference](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/administration/usage-accounting.mdx)
distinguishes BYOK inference from OpenRouter cost. Neither reference used here
establishes a binding whole-turn cap, an ordered correction sequence, or a billing
finality guarantee. Response evidence remains revision 1 and generation
retrieval revision 2; GoGo policy A now supplies economic finality and accepts
post-final upward losses. This replaces the prior “no provider finality means
reconciling forever” default. Same-revision conflicts still retain both receipts and quarantine instead of
inventing correction ordering, except post-final upward observations: those
update Cost Center evidence and emit the loss signal without changing billing. Unknown evidence stops
recovery at the budget/window and quarantines at 24h, never zeroes. Real reviewed
whole-turn bound/config/pricing and correlation/recovery acceptance remain
mandatory before paid admission. The calibrated 0.003904 ceiling alone continues
to fail readiness. No bound is certified by this finality policy.

D2 validation and DEV commands: docs/plans/853-D2-validation.md. No policy switch,
remote configuration change, provider inference, integration execution or rollout
was performed during implementation.

The D2 due-work index on the existing outbox is built CONCURRENTLY in the
existing `index-assistant-credit-spend.sql` autocommit phase, with exact
valid/ready/definition checks and explicit invalid-remnant recovery. Runtime
storage readiness includes it. No existing-outbox index scan occurs inside 0100.
