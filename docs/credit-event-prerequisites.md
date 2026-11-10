# Credit events — S1 internal producer protocol

Scope: GoGo-BE#829 S1. Authority and later slices:
[829-slices.md](plans/829-slices.md). Public OpenAPI stays **9.1.0-alpha.1**.
These are additive internal outbox facts, not new mobile/CMS response DTOs.

Migration **0097** adds the cutover singleton and two nullable review columns.
It performs no ledger or review scan. Initial state is `sync`, epoch `0`,
`first_activated_at = null`. Existing review epochs stay null. Creation stamps
the held cutover epoch only after first activation; updates never change it.
Publication stamps the first observed publication atomically with moderation,
audit and event. A pre-activation review remains ineligible even when its
historical publication audit is missing. Republishing cannot reopen eligibility.

`writeOutbox.payloadSchemaVersion` defaults to 1 for existing callers. All four
credit trigger payloads below use **2**; `eventVersion` stays independent.

| Event                                | Required facts                                                                                                                                  | Optional facts                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `place.submission_decided`           | `submissionId`, `googlePlaceId`, `venueIdentity`, `decision`, `variant`, `recipientUserId: uuid \| null`, `approvedEvidenceCount`, `grantOwner` | `placeId`, `existingPlaceId`, `rejectionReason`, `updateDeadline`; retained v1 `resultPlaceId` |
| `place.submission_evidence_approved` | `submissionId`, `venueIdentity`, `decision`, `recipientUserId: uuid \| null`, `approvedEvidenceCount`, `grantOwner`                             | —                                                                                              |
| `review.published`                   | `reviewId`, `userId: uuid \| null`, `target: place \| plan`, `firstPublication`, `grantOwner`                                                   | `placeId`                                                                                      |
| `room.completed`                     | `roomId`, DB `triggeredAt`, `room: {type, participantCount}`, `plan: {stopsCompleted}`, `subjects: [{userId, memberId, role}]`, `grantOwner`    | —                                                                                              |

Evidence is the count of server-approved original contributor menu/bill media
selected from the submission enrichment. Evidence events accompany both approval
and merge when that count is positive. S1 has no merge-created review producer:
#824 will use the same review protocol for its future review rows. `reviewId`
and #824's final-rejection variants are not fabricated in S1.

`venueIdentity` is already prefixed (`google:<id>`). The future entitlement key
adds `venue:` once. No provider name, address, coordinates, photo or free text is
stored in these new facts. The moderation note remains in its existing audit.

All producers lock cutover FOR SHARE before accounts, then domain rows. Account
IDs are deduplicated and sorted; status is read under those advisory locks.
Publication discovers and revalidates author/target. Completion discovers
accounts before locking the room FOR UPDATE, re-reads members/facts under that
room lock and rolls back/retries if another account appeared. Removed members
and guests are excluded from subjects; inactive accounts are excluded under
their held locks. `participantCount` counts all non-removed members, including
guests; `stopsCompleted` counts completed stops of the current plan.
Joins, removal and guest claim take the room FOR SHARE before membership writes.
After five conflicting discoveries the mutation returns retryable 503.

Erasure uses its existing account lock and removes the new individual recipient
fields and matching cohort entries from every stored allowlisted event, whether
published or not. Retained review/member identity follows ADR-0023. S2 extends
this to entitlement and ledger subject-key tombstones.

The registered `credit_events.enabled` flag defaults **off** and is solely a
future evaluator pause switch. S1 installs no evaluator or activation endpoint.
The synchronous grant path and existing **50 / 20 / 70** formula remain intact;
S2 changes it to catalogue components and +10 evidence. S1 submission mutation
refuses evaluator ownership before acquiring domain locks: operators must not
manually activate an S1 fleet. Reviews/groups in sync carry owner `none`;
submission decisions carry `sync`. No owner is selected by the pause flag.

Optional historical stamp reconciliation:

```sh
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/backfill-credit-events.sql
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/validate-credit-event-prerequisites.sql
```

Each backfill invocation commits at most 1000 rows, uses a 5-second lock timeout
and 30-second statement timeout, and skips locked rows. Repeat until updated=0,
then reconcile after old writers drain. It stamps only positively audited
historical publications, never review epochs or reviews with missing evidence.
It is optional for S1 correctness; no historical review can earn credit either
way. Ledger attribution/entitlements await S2 DDL and stable seeded rules.

Rollback: keep the additive schema and all stamps. Stay in sync with the
evaluator paused. Before S4 activation, an older binary can overlap only in
sync; final reconciliation must include its writes. After S4's writer fence,
an unfenced pre-platform binary must never return. Do not drop history or
reset review epochs as a rollback operation.

Verification evidence and Claude's required integration runs are recorded in
[829-s1-verification.md](plans/829-s1-verification.md).
