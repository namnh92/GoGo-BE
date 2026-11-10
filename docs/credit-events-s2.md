# Credit events S2 — catalogue, ledger and paused evaluator

Authority: [829-slices.md §S2](plans/829-slices.md) and
`dev/handoffs/sa-shape-credit-events.fable.md`, including Astra-CE-01/02/03.
S1 is migration 0097. S2 is **0098_credit-events-catalogue.sql**.
Public OpenAPI and generated clients remain **9.1.0-alpha.1**.
S3 owns the MAJOR, catalogue endpoints, public event-key history and previews.

The synchronous writer now awards separate **50 + 10** components. The existing
preview object retains `base`, `photoBonus`, `total`, with the new +10 amount.
Until S3, CMS credit history projects internal `submission_evidence` to the
existing public `submission_approved` reason and keeps the same fields. Deltas
remain extensible integers. Evidence ledger rows retain submission/venue refs;
entitlement keys are internal. No new public enum value or endpoint ships here.

Migration 0098 creates catalogue, entitlements, evaluations, ledger references,
NOT VALID shape and composite event/reason constraints, and the three seeded
rules. Stable rule IDs are `82900000-0000-4000-8000-000000000001` (+50),
`…0002` (+10), and `…0003` (+5). Code and SQL share these identities and complete
immutable definitions. The migration has a five-second lock timeout, performs
no historical scan, and does not touch cutover ownership or flag values.

Deployment preparation (operator actions, **not executed by this implementation**):

```sh
pnpm db:migrate
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/index-credit-events.sql
```

The index script requires autocommit. Never pass it to the transactional
migration runner or wrap it in BEGIN. An interrupted concurrent build can leave
an invalid index: IF NOT EXISTS does not repair it. Inspect pg_index, drop that
invalid index CONCURRENTLY and retry. API readiness and the sync mutation entry
check the seed ID/key/trigger/version/condition/audience/scope/amount, schema,
and required valid indexes including uniqueness, column order and predicates.
Worker startup also checks readiness before scheduling jobs. NOT VALID
constraints enforce new rows immediately; their historical validation comes
later. The original submission/venue/spend unique indexes remain in force.

The legacy attribution operation is separate from the optional S1 review-audit
stamp reconciliation in `scripts/ops/backfill-credit-events.sql`:

```sh
pnpm exec tsx scripts/ops/attribute-legacy-credit-events.ts
```

Each invocation commits one batch of at most 1000 legacy rows (override with
CREDIT_ATTRIBUTION_BATCH_SIZE in 1..1000), with five-second lock and 30-second
statement timeouts. It returns updated/remaining. Repeat through remaining=0,
then rescan after every old mutation writer has drained. The partial pending
index keeps subsequent batches from walking attributed history. No review
eligibility is backfilled. The application never changes historical deltas:

| Historical delta | Base entitlement                                    | Evidence entitlement         | New balance credit during attribution |
| ---------------- | --------------------------------------------------- | ---------------------------- | ------------------------------------- |
| 50               | `venue:<venue_identity>`                            | none                         | 0                                     |
| 70               | `venue:<venue_identity>`                            | `submission:<submission_id>` | 0                                     |
| 20               | venue slot tombstone using `venue:<venue_identity>` | `submission:<submission_id>` | 0                                     |

Stored venue_identity already includes `google:`; never add that prefix twice.
The historical ledger row is attributed to the base seed, while its evidence
entitlement points to the same historical ledger row. Historical budget usage
is recorded by actual paid components (50 base and/or 20 evidence); caps count
entitlements joined to their ledger owner, so legacy evidence counts too.
New synchronous grants reconcile every conflicting legacy row before either
component is paid. A late old-writer unique conflict rolls the transaction back
and retries discovery before acquiring any additional account lock.

After reconciliation, constraint validation is another committed operation:

```sh
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f scripts/ops/validate-credit-events.sql
```

All grant paths acquire cutover (producers only) → sorted rule rows → sorted,
deduplicated account locks → domain rows → entitlement/ledger/balance/outbox/ack
writes. Backfill and evaluator discover candidates without row locks and
re-read after account locks. Erasure takes accounts, never rule locks. Sync
finalization acquires no new rule/account lock after its submission lock.
Existing S1 review and completion discovery/revalidation remain intact.

The evaluator is registered as `gogo:worker:credit-evaluator` every 60 seconds,
under the existing renewable worker_leases mechanism. `credit_events.enabled`
is only its pause switch and defaults off. Cutover remains sync. Do not activate
or resume S2: S3/S4 compatibility and acceptance gates are outstanding. There is
no activation endpoint or ownership migration in this slice.

Consumption uses an ordered anti-join on evaluation state, independent of
notification published/failed/retry state or event creation time. All supported
payload versions have independent decoders; missing/invalid decoders or invalid
rules quarantine without a terminal ack, and are retried on subsequent ticks.
Nullable or scrubbed recipients are valid no-subject events. Predicates use
only canonical payload facts plus the pseudonymous subject key; the only live
subject check is account activity under its account lock. Unsupported audiences,
scopes, facts, operators, nesting and leaf counts are rejected. Group budgets
reserve all eligible members or none, after dedup and caps; one group_grant_id
identifies the atomic grant. The additional source-only `group_source_key`
(`room:<id>`) keeps per-room group caps correct after event pruning and subject
erasure, including per_occurrence rules.

Reservation, all grants, balances, audits and terminal ack commit together.
An unexpected entitlement conflict rolls all of them back. Audit resources are
ledger IDs, never subject keys. A retention trigger refuses to prune any of the
four allowlisted events until its terminal evaluated ack exists; paused and
quarantined work therefore survives retention. Closing a rule never claws back.
Quarantine emits `credit_events.quarantined`, a structured error and Sentry
capture; insufficient group budget emits `credit_events.budget_insufficient`.

Before eventual evaluator enablement, provision the dedicated **non-rotating**
SSM secret `/gogo/<env>/backend/credits/subject-key` as
CREDITS_SUBJECT_KEY_SECRET (at least 32 characters). Missing secret refuses
resumption; it has no fallback to another application secret. HMAC-SHA256 keys
are truncated to 128 bits. Rotation requires a product entitlement-epoch
migration and is not an operational recovery step.

Erasure selects every subject-scoped entitlement and ledger key before clearing
ledger ownership. One random old-key→erased-UUID map rewrites both copies.
Source/venue-only keys and group_source_key remain for business dedup/caps.
S1 continues to scrub all allowlisted recipients, including quarantined events.
No claim of full contribution anonymity is made; retained content follows ADR-0023.

Rollback before S4 keeps the additive schema and compatible sync binary with
the evaluator paused. Do not drop entitlements or ledger history. Old writers
may overlap only while sync ownership is retained; they require final
reconciliation. After the S4 fence, an unfenced old binary must never return.
No migration timing, deployed readiness, migration-forward execution,
Testcontainers result, independent review or activation acceptance is claimed.
Verification and exact Claude commands: [829-s2-verification.md](plans/829-s2-verification.md).
