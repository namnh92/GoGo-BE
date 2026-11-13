# ADR-0057: Account member seed contributions

- Status: approved solution shape; implementation awaits exact-revision Astra/CODEOWNER review.
- Date: 2026-11-12
- Related: GoGo-BE#878; FR-ROOM-008/010/011; ADR-0005; ADR-0027.
- Authority: owner's approved Astra shape and quota answer, 2026-11-12.

Account hosts and active account members may contribute seed places in draft or
collecting, before room expiry. Guests cannot add or remove, even though their
membership role is `member`. Host authority requires exactly one active host
consistent with room ownership. Removed, pending and outside actors have no
contribution authority. This does not grant constraint editing, matching, invite,
member administration, or access to another member's preferences.

Reuse `room_seed_places.created_by_member_id`; expose it as `addedByMemberId`, a
room membership identifier. A member removes only that membership's contributions;
the current host removes any. Removal/rejoin never transfers attribution. Creator
removal does not remove seeds. No schema migration or attribution backfill.

The quota is **10 distinct places per room across all contributors**. Keep legacy
over-quota rooms; duplicates remain no-ops, deletion is allowed, new IDs are
blocked until the resulting set fits 10. Normalize/deduplicate request UUIDs;
validate each new published catalog place against both the current VERIFIED
administrative scope and inclusive PostGIS radius. No VenueVerification badge
requirement, provider call, AI call, or provider snapshot is added. An unresolved
legacy scope fails closed. Creation uses the same transactional validator.
Deletion never depends on publication or current area.

Serialize on room FOR UPDATE, then active memberships FOR SHARE. This matches
matching, preference completion, removal and claim's room-first order. Lock the
published administrative dataset and catalog rows before validating/writing.
Batch mutation, authorization, replay, current constraint revision copy, version
increment, scores/plans invalidation, reminder sync, audit and outbox commit
atomically. Copy current stored constraint fields (including erased origins),
not a partial/stale DTO. Locked stops, votes and preferences survive. No-op and
replay do not advance the version or emit mutation effects.

CMS merge concurrency (Astra F-01): CMS locks the canonical and duplicate
catalog rows FOR UPDATE in normalized UUID order before rewriting seed
references. It never takes a room/member/dataset lock. POST keeps the existing
room → members → replay → published dataset → catalog rows (UUID order) path,
then re-reads the seed set after catalog validation has acquired SHARE locks.
Only validated IDs still absent in that fresh set may be inserted; quota and
positions use that set. DELETE takes a SHARE lock on its target catalog row
before reading seeds/ownership, without publication or area validation. A
merge that already owns that row therefore finishes before DELETE decides
whether anything remains to remove. Neither path locks seed rows before
catalog rows; CMS must not acquire a room lock after its catalog locks. This
avoids a room/catalog lock cycle and preserves dataset-before-catalog ordering.

INSERT uses ON CONFLICT (room_id, place_id) DO NOTHING for duplicate no-op
semantics. Both INSERT and DELETE RETURNING determine the actual delta; only
nonempty returned deltas advance revisions, invalidate dependencies or produce
audit/outbox/SSE effects. A zero-row mutation returns the current seed list and
unchanged revision, and keyed replay stores that same no-op response.

Order: guest scope/prohibition → account active membership/authority → room
state/expiry → replay → ownership of an existing DELETE target → data mutation.
Account roles outside the editable window receive ROOM_NOT_EDITABLE; guests
always receive 403. Returning from matching to collecting restores editability.
Missing DELETE is a no-op after authorization and state checks.

Seed routes opt out of generic interceptor replay using ManualIdempotency.
Optional keys remain compatible with old clients; a concrete resource record
stores the response for 24 hours. A template-key binding also detects cross-room
or cross-place reuse and old unbound records. Legacy unbound keys receive
IDEMPOTENCY_CONTEXT_CHANGED without purge/re-execution. Body/resource mismatch
is 422. Authorization/state are checked even on replay; completed DELETE replay
returns the old answer without touching a later contribution. Claims and both
completions commit with the mutation. Without a key, only current-state no-op
semantics are promised.

Every changed set emits room.seed_places_changed v1 with room-scoped actor,
operation, actual added/removed IDs and constraintVersion. No push/inbox mapping.
Append-only audits contain the membership, room, actual deltas/version and whether
the host removed another contribution, never IP, coordinates or credentials.
Metrics have bounded operation/actor_kind/role/outcome labels; auth failures log
only reason and request correlation. Role is `none` when authorization fails
before a contribution result exists.

SSE uses RoomEventBus after commit and is best-effort: Redis failure preserves
HTTP success. Outbox does **not** durably relay this signal to SSE. A crash after
commit can lose the immediate signal. Clients invalidate/refetch on the event,
focus/reconnect/resync and poll while the room is open; do not reconstruct
ownership from deltas. Active scoped guests retain read/stream access.

## Compatibility and rollout

11.0.0-alpha.1 is a MAJOR bump from the rebased 10.3.0-alpha.1 contract
(GoGo-BE#901): DELETE now enforces state, new area/quota enforcement,
POST runtime 201 becomes the documented 200, and SSE enum expands. Paths,
operation IDs and old request bodies survive; DTO adds attribution and keeps
position. Publish generated types and event artifacts together. Consumer must
pin artifact/version and gate member CTA until the full serving fleet runs these
semantics. Missing attribution means no member ownership inference. Guest CTA
checks identity/isGuest in addition to role.

### BE-BFF-012: closed SSE response enum

The owner authorized this compatibility decision in the PR #902 CI-fix brief on
2026-11-12. Keep `room.seed_places_changed` in `RoomEvent.event_type` for
`GET /rooms/{id}/events`. Expanding a closed response enum is breaking for
exhaustive or strict generated readers, even though the SSE envelope is unchanged.
Removing the value to silence oasdiff would leave a live event undocumented;
reopening the entire enum would widen this decision beyond #878. Retain the
explicit enum and declare MAJOR `11.0.0-alpha.1` under BE-BFF-012.

Consumers must regenerate their types and tolerate unknown event types before
rollout. Old clients must ignore an unknown event's payload, invalidate cached
room/seed state and refetch the room and seed list; they must keep consuming the
stream instead of failing enum validation or disconnecting. Never reconstruct
ownership from an unknown payload. Focus/reconnect/resync refetch and polling
remain necessary because delivery is best-effort.

`openapi/CHANGELOG.md` carries this migration requirement. The single
`BE-878-room-seed-places-changed` entry in `.github/oasdiff-exceptions.json`
records only oasdiff's `response-property-enum-value-added` diagnostic for the
exact base/revision raw YAML SHA-256 pair. Any later contract bytes require a new
policy evaluation. `CODEOWNERS` maps both `/openapi/` and the exception file to
`@namnh92`; the owner brief authorizes preparing this record, while exact-revision
Astra/CODEOWNER sign-off remains a separate review gate.

Astra/CODEOWNER review, CI, compatibility and deployed DEV acceptance are distinct
gates. Record tested BE revision, contract version, mobile artifact/build and
host/two-member/guest smoke with concurrency evidence. Refs #878; do not close on
merge. Invite approval, TTL, transfer-host and mobile changes are separate issues.

## Rollback

Disable member CTA and roll forward or serve a contract-compatible rollback.
Keep authorization/state/stale fixes and published attribution. Never send live
seed mutation traffic to the old binary: block those routes first if forced to
roll back; GET remains available after compatibility verification. Retain all
attribution, revisions, audit and replay records. No schema rollback is needed.
