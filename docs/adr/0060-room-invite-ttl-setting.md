# ADR-0060: Room invite TTL setting

- **Status:** accepted (BE-A data and issuer reader; BE-B/CMS follow separately)
- **Date:** 2026-11-13
- **Deciders:** owner; #906 authoritative shape

## Context

The owner needs a freely entered duration for new invitations, administered only
by super_admin with audit. A hard-coded 24h runtime default would silently extend
invitations if a deliberately shortened setting became unavailable.

## Options considered

1. Feature flags or ranking configs: unrelated permissions, scopes and lifecycle.
2. A database singleton: one authoritative value per environment, no cache.

## Decision

Migration 0107 creates `room_invite_settings(id=1)` with positive PostgreSQL integer
`ttl_seconds`, positive bigint revision, DB update time and historical admin UUID
(no foreign key). Valid TTL is strictly a number/integer in 1..2147483647; no
coercion. Seed 86400, revision 1, null admin, and exactly one system initialization
audit in the migration transaction. Startup never resets this value. No credentials
are backfilled. The guard is a storage limit, not a business 48h/30-day ceiling.

Issuers use READ COMMITTED on the primary: room FOR UPDATE, revalidate authority/
state/epoch/suppression, singleton FOR SHARE, then a separate clock_timestamp()
statement. FOR KEY SHARE does not block a TTL update and is insufficient. The
reader only accepts the existing transaction and never caches or opens a connection.
TOKEN128 stores created_at=t and expires_at=t+TTL; share mint uses the same outer
transaction and copies that exact expiry. CODE6 stores issued_at=t and expires_at=
min(t+TTL,t+172800 seconds,room expiry), rejecting a nonpositive lifetime. Null room
expiry means no room cap. Existing grants, list/preview/join/replay and #881 pending
approval deadlines keep stored expiry; a setting change cannot revive credentials.

Missing/invalid row returns typed 503 INVITE_TTL_SETTING_UNAVAILABLE, retryable false;
DB/lock failure returns the same code with retryable true. Issuance rolls back.
No caller supplies TTL/expiry overrides. #891/#861 attempt context, CSRF, preview
ticket, replay, risk exposure, cooldown and reuse lifetimes are independent.
CODE6 remains internal and gated; exposure is reserved outside the DB transaction.

The update boundary is the setting lock and commit, not request/response arrival:
an issuer holding SHARE finishes before a writer can commit; an issuer acquiring
SHARE after a writer commits uses the new value. An issuer waiting for its room
lock may therefore use a newer setting than at request start.

## Consequences

BE-A must be deployed across the fleet before BE-B exposes mutations; CMS-C follows
the BE-B contract. This change adds no CMS endpoint, permissions or mutation path.
The additive contract is 12.2.0-alpha.1, stacked on #891 / #907 (12.1.0-alpha.1).

Telemetry: room_invite_ttl_read_total{consumer=token/code6,result=ok/missing/invalid/db_error}
and room_invite_issue_total{kind=token/code6,result=committed/rolled_back}. Outcome
observation wraps the outer transaction, including share writes. The internal CODE6
allocator has no transaction owner/public caller; future I08 must use the shared
outcome observer. Its allocation counter is never commit evidence. Error logs carry
only operation, fixed reason and request ID. No TTL, version, credential or identity
labels/gauge. Page immediately on missing/invalid reads, monitor DB errors and
rollback rate. See the alert guidance in infrastructure.md. BE-B adds update metrics
and restricted audit visibility before opening CMS mutation/read access.

## Migration & rollback

0107 uses the existing migrator transaction, 3s lock timeout and 15s statement
timeout, above 0105's watermark; 0106/1794441600106 is reserved for #891. Seed uses
ON CONFLICT DO NOTHING and audits only an actual insert. No existing room table
scan/rewrite. Test fresh install and an upgraded populated 0105 snapshot, preserve
all credential deadlines, and rehearse the physical down guard in test environments.

Before activation, the old app may be restored while the value remains default;
the table can stay. After activation, BE-A is the minimum binary floor. Never
restore a hard-coded 24h binary while the setting differs. Business rollback uses
the future CMS PUT 86400 with current ETag, new version and audit. Do not edit history.
`scripts/rollback/0107-room-invite-settings.sql` is rehearsal/pre-activation only:
stop readers/writers and verify no admin update; it refuses modified state, keeps
initialization audit and never rewinds the journal. Activated deployments roll forward.

Unit and integration specifications are distinct from external DEV execution,
fleet verification and owner acceptance; none of those is implied by local checks.
