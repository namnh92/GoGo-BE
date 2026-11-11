# ADR-0054: Free-first actual-cost assistant credit funding (#851 D1 / #853 D2 / #832)

Date: 2026-11-11. Status: D1/D2 implemented locally; activation and DEV acceptance unverified.
Authority: Astra rev2 shape and owner implementation brief dated 2026-11-11.
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
Over-bound or post-final upward targets quarantine and disable new paid admission,
never create debt or collect from future grants. A runner that proves no call was
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
  answer validation subsequently fails. No prompt/header/token/payload copy is
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
  All attempts must be final before final release. SSE done/completeLedger is
  never provider finality. Free turns collect provider cost but never debit.
- The shared application service uses D1 account-locked revision primitives.
  One base debit survives refund-to-zero; later deltas are revision-unique signed
  adjustments. Ledger/account/A/H/applied revision/audit/notification marker are
  atomic. Financial counters emit after commit. Int32 refund overflow and missing
  wallet arithmetic quarantine, preserving funds instead of retrying a debit or
  creating debt. Public contracts remain 10.0.0-alpha.1; D2 adds no wire fields.
- The worker has a dedicated outbox consumer (notification fanout excludes its
  events), bounded indexed sweep, expiring per-turn CAS claims, retry/backoff and
  the existing periodic worker_leases row. Discovery holds no usage-row lock while
  waiting for an account. Recovery reads generation metadata only. A lost ACK
  replays the revision; a missed wakeup is repaired by the sweep. Financial pause
  keeps cost capture running and retains holds. Spend-off does not cancel funded
  work. Master-off fences new dispatch, while dispatched liabilities reconcile.
- Bound readiness additionally requires an environment-scoped, current, unrevoked
  versioned artifact, matching exact B, live provider/models/caps/config hash and
  explicit pricing revision. Immutable bound/finality evidence digests and complete
  attempt/abort/fee coverage are required. Digests reference reviewed evidence;
  they do not certify it themselves. No artifact is shipped by this change.
- Account erasure under the common lock clears turn/user/message/conversation
  linkage, call/provider correlations, wallet and queued payload/linkage. Late work
  rechecks identity and cannot recreate a wallet. Scrubbed financial evidence and
  safety incidents remain. Conversation deletion keeps funding. Unresolved D cost
  is excluded from the 400-day usage purge; resolved provider correlation is
  removed at that retention boundary. Self export pages own credit facts/holds
  and signed ledger entries through the existing byte budget, excluding provider
  identifiers. Existing balance export remains available.

Provider evidence limitation / activation blocker:
[OpenRouter generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
provides per-generation cost retrieval, and its
[usage-accounting reference](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/administration/usage-accounting.mdx)
distinguishes BYOK inference from OpenRouter cost. Neither reference used here
establishes a binding whole-turn cap, an ordered correction sequence, or a billing
finality guarantee. Thus response evidence is revision 1, generation retrieval
revision 2, both correctable; changed retrieval evidence at that fixed revision is
quarantined instead of inventing ordering. An ambiguous call with no returned
generation ID stays pending and requires provider-assisted attribution. No
account/monthly allocation, invented zero, TTL release or redispatch is permitted.
Trusted final receipts exercise the generic settlement path in deterministic
fixtures; they are not live provider acceptance. Real bound/finality review and
correlation/recovery acceptance remain mandatory before paid admission, including
any provider capability work that the evidence review identifies. The calibrated
0.003904 ceiling alone continues to fail readiness.

D2 validation and DEV commands: docs/plans/853-D2-validation.md. No policy switch,
remote configuration change, provider inference, integration execution or rollout
was performed during implementation.

The D2 due-work index on the existing outbox is built CONCURRENTLY in the
existing `index-assistant-credit-spend.sql` autocommit phase, with exact
valid/ready/definition checks and explicit invalid-remnant recovery. Runtime
storage readiness includes it. No existing-outbox index scan occurs inside 0100.
