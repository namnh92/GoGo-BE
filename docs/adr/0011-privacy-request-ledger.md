# ADR-0011 — Privacy requests are a compliance ledger, and guest removal is not a ban

- **Status:** Accepted
- **Date:** 2026-08-31
- **Issues:** GoGo-BE#246 §5 (product decision), #254 (guests), #255 (ledger),
  #256 (secure delivery, follow-up)
- **Relates to:** ADR-0003 (sessions), DB-010 (retention jobs)

## Context

The console had no way to see guests in a room or to record a privacy request.
Export and delete existed as synchronous self-service operations that left only
an audit row behind. The product decision on #246 settled the semantics; this
record fixes them so the next person does not re-derive them from the code.

Eight decisions, each stated as the thing it prevents.

## 1. Guest removal is not a durable ban — and is never described as one

A guest has no durable identity. There is a session, tied to one room, reached
through the invite flow. Revoking that session alone is a revolving door:
whoever holds a still-valid invite joins again and receives a fresh session.

So the console action is **remove from room**: revoke the active session
(denylist included, so a token already in flight dies now) and mark the
membership row `removed_at`. The row is kept — votes, reports and moderation
history reference it, and erasing it erases the context of the removal.

The contract, the console copy and an integration test all say the same
sentence: _a removed guest can rejoin with a still-valid invite._ If that test
ever fails, the product semantics changed; update the copy and this ADR before
"fixing" the test. Preventing a return is a different action — rotating or
revoking the invite — and the removal endpoint does not pretend to include it.

There is no global guest directory. No moderation case reads one, and every
guest's display name and activity in one list is a new PII surface with no
reader.

## 2. The ledger is not a copy of the audit log

The audit log answers _who did what_. The privacy-request ledger answers _what
did we receive, where does it stand, what is the deadline, how did it end_.
Deriving the second from the first undercounts everything support recorded but
never executed, and has nowhere to put a deadline at all.

Self-service `/me/export` and `/me/delete` write to the ledger too, as
born-completed rows (`source = self_service`, every timestamp = now). No
`PENDING` is faked for something that never pended, but the row exists so the
ledger is the single source of truth for compliance counts.

`status` and `outcome` are separate columns. One enum that mixes
"acknowledged" with "no_account_found" forces every query to know which values
mean still-moving and which mean ended-and-how.

## 3. Execution links to one request, explicitly

_Same user is not same request._ One person can have an export, a delete, a
duplicate and a rejected request open at once. So:

- `POST /cms/privacy-requests/{id}/execute` runs the operation for **that**
  request and closes **that** request.
- `POST /cms/users/{id}/delete` outside the workflow does not touch the
  ledger. The user detail carries `openPrivacyRequestCount` so the console can
  warn first.

Auto-closing "all open requests for this user" on any similar action would let
the backlog report a fulfilment that never happened.

## 4. A privacy request may be the last PII about a person — on purpose

After an account is erased, its privacy request is one of the last records
that the person existed. Keeping it for the retention period is an
**intentional retention exception** for compliance evidence, not a side effect
nobody noticed. The `user_id` column therefore has no cascade.

The record carries the minimum: type, source, status, structured subject,
timestamps, delivery _metadata_, reason code, ticket reference, a 256-character
operator note. It never carries exported data, a deleted-data snapshot, review
text, a profile snapshot, or a signed URL.

## 5. Request-level rows are hard-deleted after retention

Default: **12 months after closure**, then `DELETE`. Not anonymize.

Anonymizing was rejected because timestamp combinations remain
quasi-identifiers, operator notes cannot be machine-scrubbed with confidence,
and a half-scrubbed row is liability with no product value. `retention_at` is
stamped at closure (`closed_at + policy`) so the job's predicate is a
comparison, policy changes migrate by `UPDATE`, and a hold sits visibly next to
the date it holds.

The 12-month figure is a product default and needs Legal sign-off before
production.

## 6. Long-term reporting keeps only aggregates

`privacy_metrics_monthly` — integer counters per month, bumped when events
happen, never derived from the requests table. Nothing in it joins back to a
person, which is the property that lets it live forever after the rows it
counts are gone.

## 7. Legal override is a mechanism, not a sentence

"Legal may override retention" without a mechanism becomes someone editing the
database by hand. The mechanism is a first-class **retention hold**:
`super_admin` only; reason, legal basis and a future review date all required;
audited; the retention job skips held rows; and a hold only ever _extends_
retention — release resumes the standard date, never an earlier one.

When `review_at` passes, nothing is auto-released and nothing is auto-deleted.
The row is flagged `HOLD_REVIEW_OVERDUE`, the worker warns, and a person
reviews. A lapsed review date does not mean the legal basis lapsed.

## 8. SLA values are provisional until Legal confirms them

The schema carries `ack_due_at`, `fulfillment_due_at`, `extended_due_at` from
v1 — a workflow without deadlines is a ticket list. Due dates are computed
**per request type** from `PRIVACY_SLA_JSON`; there is deliberately no single
global 72-hour rule.

The defaults in `shared/privacy-ledger.ts` are engineering placeholders.
Production values must be confirmed against the law in force — Luật
91/2025/QH15 and Nghị định 356/2025/NĐ-CP — before they are locked.

## Consequences

- Retention is a job (`PrivacyJobs`, DB-010 pattern), idempotent, reporting
  `privacyRequestsPurged` and `privacyHoldReviewsOverdue`, never logging row
  contents.
- `delivery_method = secure_download` exists in the enum from v1 but has no
  artifact lifecycle behind it yet — GoGo-BE#256. Until then the runbook
  forbids raw exports over ordinary email.
- Two new environment knobs: `PRIVACY_SLA_JSON`, `PRIVACY_RETENTION_MONTHS`.

## Rollback

The ledger is additive. Removing it is dropping two tables and the routes;
self-service export/delete keep working, because they never depended on the
ledger row succeeding.
