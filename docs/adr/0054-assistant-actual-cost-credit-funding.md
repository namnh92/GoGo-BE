# ADR-0054: Free-first actual-cost assistant credit funding (#851 / #832 D1)

Date: 2026-11-11. Status: D1 implemented, activation and DEV acceptance unverified.
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
D2 owns provider capture, settlement worker/outbox/finality, erasure/export and
activation evidence; these are not implemented or accepted by D1.

Validation: deterministic unit/property tests plus named Testcontainers D01/D03/
D04/D05/D09 specs. Docker integration and live provider/consumer DEV acceptance
are separate execution gates; no deployment or paid activation is claimed.
