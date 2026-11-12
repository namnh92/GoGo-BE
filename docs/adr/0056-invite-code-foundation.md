# ADR-0056: Internal invite schema and crypto foundation

- Status: I03 implementation of approved #861 solution shape rev2; activation disabled
- Date: 2026-11-12
- Refs: GoGo-BE#889, parent #861; owner TTL decision #882 (pending PR #886)
- CODEOWNER: M (schema/migration), A (authentication/permissions), mapped by CODEOWNERS
- Requirements: SRS FR-ROOM-009, FR-LINK-001/002; shape §§2, 3.1, 7.2, 8, 9 I03

## Decision and scope

This is an additive storage/internal-library contract. It registers no Nest
provider, controller, endpoint, automatic job, backfill or public response field.
No OpenAPI change. Existing room/token/share writers retain their behavior.
I04 must fence them before any revoke-all activation; I06 must enforce the
≤1% risk bound in every rolling 48 hours. Neither is established by this slice.

`room_invite_codes` holds immutable UUID generations, room/epoch, keyed lookup,
authenticated ciphertext/key version, issue/expiry/revoke/release timestamps,
reservation state/reason and the verified host membership identifier. The
membership identifier is historical (like `room_invites.created_by_member_id`),
without a restrictive member FK that would block privacy erasure. Room erasure
cascades the history. No plaintext credential is persisted.

Unique partial indexes reserve `code_lookup` and `room_id` only while OPEN.
CHECKs make OPEN incompatible with revocation/release and require CLOSED release
metadata. Deadlines are strictly after issuance and at most 48 hours later;
the allocator additionally caps them at the locked room's expiry. No time or
room-state function is in an index predicate. Late cleanup retains a reservation,
never admission rights. Closed generations remain history; future cleanup must
not delete token/share hash locators merely because they expired or were revoked.

Rooms add bigint `invitation_epoch` (initially zero), sticky
`automatic_invites_suppressed`, monotonic `legacy_invites_revoked_at` and
`code6_backfill_completed_at`. The DB rejects epoch regression, suppression
clearing and changing/clearing an existing marker. The generation trigger rejects
identity/deadline/lookup mutation and reopening a CLOSED reservation; ciphertext
and encryption version may change together during an encryption-key rotation.
Those triggers protect storage; they do not make an old admission binary safe.

`users.host_share_id` is nullable, unique, stable, independently CSPRNG-generated
128-bit canonical base64url text. `share_links.path_version` defaults to LEGACY,
with null alias; HOST_V1 requires ROOM_INVITE, a referenced invite, and a canonical
alias snapshot. Share and token grants add epoch zero defaults for old rows.
Snapshot/epoch matching at resolve and atomic invite/share minting belong to
I04/I07. Do not mutate an issued snapshot to refresh an old link.

## Internal APIs and transaction ownership

`InviteCodeCrypto` accepts a validated `InviteKeyConfig` from the process's
config/secret-manager adapter. Load it outside DB transactions using
`loadInviteCodeCrypto(config, metrics)`. There are no embedded/default keys,
secret env examples, network calls, logger calls or runtime config discovery.
Keys are 32-byte lowercase hex, independently provisioned per purpose:
lookup HMAC, response/request-replay HMAC, bucket HMAC, and each encryption key
version. Duplicate material across any purposes/versions is rejected. Private
slots prevent accidental JSON/inspection of the object from exposing keys.
The config source itself must never be logged.

The API supplies unbiased `crypto.randomInt(1_000_000)` generation including
`000000`, a purpose-separated HMAC-SHA256 lookup, replay fingerprint and bucket
digest, and AES-256-GCM encryption/decryption. A fresh 96-bit nonce is used every
time. The stored base64url envelope is nonce(12) + tag(16) + ciphertext(6), 34
bytes/46 characters, with encryption version stored separately. AAD is the
canonical JSON tuple `["gogo.room-invite.code", 1, roomId, generationId]` with
lowercase UUIDs. Moving ciphertext to another room/generation, tampering or
missing keys fails closed. Do not use replayFingerprint as encrypted replay
storage; I08 still has to implement that storage and revalidation.

`InviteCodeReservations.allocate(tx, input)` takes an already open Drizzle
transaction and room ID, signed-in actor ID, expected bigint epoch, optional
explicit reissue intent and automatic-issuance intent. It checks schema readiness,
locks only that room FOR UPDATE, reads time after acquiring the lock, checks
host/lifecycle/deadline/epoch/suppression, and rejects an existing OPEN generation.
Raw Drizzle PostgreSQL timestamp results are text; the allocator decodes the
post-lock clock and room expiry to dates before computing the bounded deadline.
Automatic allocation also refuses prior CODE6 history/completion or a history
of revoked token invites with no remaining usable token grant. It cannot clear
suppression. A host can explicitly reissue at the current epoch after suppression;
a stale queued request fails. Matching/ready may hold reservations; this API
does not grant admission in either state.

Each candidate INSERT is in a real nested Drizzle transaction/savepoint. Only
23505 for the OPEN lookup constraint retries, at most 20 times; exhausting them
returns internal `COLLISIONS_EXHAUSTED`, to be mapped to a temporary error by a
future complete use case. No conflicting room is queried or locked for cleanup.
Release/rotate/revoke orchestration is I04/I08, not a partially exposed operation.
`allocateHostAlias(tx, userId)` separately uses compare-and-set and savepoints;
same-user races return the committed alias, cross-user collisions retry boundedly.
Call alias allocation in a separate transaction before room operations to avoid
introducing user→room/room→user lock inversions. APIs require READ COMMITTED;
SERIALIZABLE callers must retry the whole transaction as a separate policy.

Before invoking CODE6 allocation, I06/I08 callers MUST reserve durable exposure
capacity outside the business transaction; include audit/completion in the same
transaction as the generation. There is deliberately no caller/activation switch
here that could bypass that missing authority. Do not hold a transaction while
calling Redis or a secret provider. Future workers use persisted worker leases,
not advisory locks. No worker is added here.

Returned code/alias objects are transient. Never log them, attach them to native
errors, store them in generic idempotency JSON or emit them in events. Primitive
errors contain fixed internal codes and discard native driver parameters/causes.
Runtime catalog readiness is checked afresh on every allocation: required
columns, valid/ready/live unique/index key and predicate semantics, validated
CHECKs and enabled monotonicity triggers. Missing readiness does not disrupt
unrelated legacy token traffic, since these primitives have no production callers.

## Migration and validation

1. Keep CODE6, revoke-all, HOST_V1 and automatic jobs off. Record the database
   snapshot/backup and migration watermark. Rehearse on a masked remote snapshot.
2. Apply `0104_invite-foundation.sql` with the existing `db:migrate` runner.
   Its journal timestamp is strictly above 0103. Constant defaults use PostgreSQL
   fast-default expansion; no bulk update, alias/CODE6 backfill, table rewrite,
   populated-table index build or existing-table constraint scan is in this
   transaction. Lock acquisition is bounded at 3 seconds; each DDL statement at
   15 seconds. Locks remain until the migrator commits; schedule this successor
   separately if a deployment also has unrelated large pending migrations.
3. After commit, run `psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f
scripts/ops/prepare-invite-foundation.sql` in autocommit, never `-1`. It builds
   the host alias unique index CONCURRENTLY and validates NOT VALID CHECKs under
   weaker locks in separate statements. Validation is resumable. A five-minute
   statement deadline is a ceiling, not an expected duration or lock benchmark.
4. Run `assertInviteFoundationReady` and key readiness before any internal caller
   is added. Same-name indexes that are invalid or incompatible must be examined,
   dropped CONCURRENTLY and rebuilt using the ops script. IF NOT EXISTS does not
   repair an interrupted build. Runtime readiness rejects such indexes.
5. Rehearse forward upgrade of a populated 0103 snapshot, compare fresh/upgrade
   schemas, record elapsed/lock behavior on the real corpus, then collect fleet
   capability inventory in I04/I12. This slice alone cannot authorize activation.

The Testcontainers spec creates a real populated 0103 PostgreSQL template
snapshot, upgrades a copy, preserves existing revoked/spent grants and exact
expiries, compares a fresh install, exercises races/collision savepoints and tests
the down guard. It is synthetic snapshot proof; it is not a measured production
lock-duration rehearsal. Unit tests exercise the real Drizzle migrator's journal
watermark plus crypto, allocator refusal/retry behavior and readiness failures.

## Rotation, recovery and rollback

Encryption rotation: distribute retained old + new decrypt keys to every
compatible reader first; then switch the active encryption version for new
writes. Re-encrypt existing generation ciphertext with its original AAD and a
fresh nonce in bounded batches, changing ciphertext/version atomically. Keep old
keys until every retained ciphertext/replay that needs them is migrated/expired
under retention policy. A missing old key is unavailable, never a fallback key.
Batch tooling is deferred to the slice that owns its actual operational use.

Lookup rotation is different: one environment has exactly one active namespace,
with no `(key_version, code_lookup)` uniqueness escape. Close issuance/admission
and automatic jobs across the fleet first; close/invalidate old generations and
proofs, reconcile old exposure/attempt history without resetting the risk budget,
then coordinate a new key and fresh generations. Until complete, CODE6 stays off.
Readiness here checks local schema/material, not agreement of all fleet secrets
or rolling-budget recovery; those are mandatory later activation gates.

Primary rollback disables CODE6 lookup/issuance and jobs, retaining schema,
keys, history, suppression, expiry, privacy fence and all issued parsers/fences.
Never return a binary below the revocation fleet floor, remove HOST_V1 parsing
once links exist, or restore ROOM_INVITE attribution to Tenjin. No expired or
revoked credential is resurrected by a rollback.

`scripts/rollback/0104-invite-foundation.sql` is an executable, pre-activation-only
physical down path for a rehearsed snapshot or a deliberately approved successor
migration. It takes bounded exclusive locks and refuses if ANY generation, alias,
nonzero epoch, suppression, marker or HOST_V1 snapshot exists. Coordinate all
callers first. Do not run against activated data, rewind/delete Drizzle journal
history or drop retained keys. A deployed rollback is a new roll-forward migration,
with a new journal timestamp and the reviewed guard, rather than editing 0104.

## Telemetry and acceptance

The existing MetricsPort hooks are:

| Metric                                   | operation             | result                   |
| ---------------------------------------- | --------------------- | ------------------------ |
| `room_invite_allocation_total`           | `code6`, `host_alias` | `allocated`, `exhausted` |
| `room_invite_collision_total`            | `code6`, `host_alias` | `retry`                  |
| `room_invite_foundation_readiness_total` | `schema`, `keys`      | `ready`, `unavailable`   |

`allocated` records an accepted internal insert, not a committed/public issuance;
the outer transaction may still roll back. Labels contain no credential, digest,
room/member/device/host identity, alias, key material/version or free-text reason.
Future composition roots supply the process MetricsPort; there is no new endpoint.
Alerts/activation evidence require the later serving slices. Local logs and command
exit codes live in the requested external `dev/test-evidence/be-889` directory.
Independent review, CI, masked-snapshot lock measurements, fleet-floor evidence
and DEV integration remain separate gates; a passing unit suite is none of those.
