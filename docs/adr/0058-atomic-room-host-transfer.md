# ADR-0058: Atomic room host transfer

Date: 2026-11-12. Status: approved solution shape supplied by owner for implementation;
implementation CODEOWNER/Astra review and DEV acceptance remain separate.
Refs #879. Base: `re-design`.

Room ownership has two representations: `rooms.host_user_id` and active host
membership. Updating one without the other, or trusting a host read before
provider computation, permits conflicting ownership or old-host writes.

Transfer uses a required RoomMember ID and expected ownership term, a concrete
room-scoped idempotency key, sorted account locks followed by user rows, room
and sorted membership locks. It rechecks active user membership, role and host
pointer under the room lock. Only draft/collecting/matching/ready before room
expiry qualify; pending selection is eligible, pending admission is not a member.
Guest claims are judged from committed identity, with rediscovery after rollback
if the identity changed while account locks were acquired. No new account lock
may be acquired under a room lock.

The transaction demotes A, promotes B, increments independent `host_version`,
and writes the domain event, audit and immutable receipt together. A completed
receipt replays before host/state/term checks, still behind authentication. A→B→A
requires a new term; membership identity alone is insufficient. A bounded lock
wait returns retryable in-flight, and rollback leaves no orphaned claim.

An active-host partial unique index prevents multiple hosts. Deferred triggers
require one active user host matching the pointer at commit and allow temporary
zero hosts within the transaction or cascade deletion of a room. All ownership
writers serialize on the room. These constraints do not replace authorization.
Creator is immutable and distinct from current host, including mixed-version
creation; CMS historical room counts use creator with a pre-backfill fallback.

Every host-only write rechecks authority and term after the room lock, including
status no-op, invite/share issuance, ranking persistence, finalize,
plan edit/regenerate and stop locks. Automatic match authority is explicit and
restricted to match decisions. Provider calls stay outside transactions. Transfer
preserves preferences, votes, constraints, plans, locks and their versions/stale
flags, all existing membership IDs, and historical attribution.

Member seed contributions retain ADR-0057 semantics: seed mutations lock the
room before reading current membership roles, so only the new host can remove
other members' contributions. The old host remains a member and may manage
their own contributions. Transfer does not rewrite created_by_member_id or
change the total quota of 10.

The owner answered the invite question: old invitations stay valid until their
own expiry/revoke, with original issuer and usage. Original link creators retain
ADR-0018 revoke rights; all other host-only management moves. No revoke-all, code
rotation, epoch change, CODE6, approval queue or TTL change is included.

The outbox event uses pseudonymous actor and member IDs only. Notifications target
`newHostMemberId`, including retries/deferred drain, rather than the current host.
Kind `host_transferred` belongs to category `other`, honors master opt-out and
quiet hours and never grants guest push. API replay creates no new notification.
SSE is post-commit best effort; it may be lost on process failure. Clients converge
by snapshot/polling and must not overwrite newer `hostVersion` with old events or
receipts. No durable SSE relay is added.

Contract 12.0.0-alpha.1 intentionally expands the closed `RoomEvent.event_type`
response enum. The MAJOR bump records a breaking consumer change; it does not
waive the compatibility gate or mapped CODEOWNER approval. Generate declarations
and event artifacts with repository scripts. Consumers pin published artifacts.

Schema expands first, followed by bounded creator backfill and concurrent index
ops. Full preflight aborts activation on invalid ownership; it never selects a
replacement. Deploy workers before any producer, all API guards before activation,
and verify pinned mobile enum/kind handling. The default-off rollout fence requires
fleet, worker, client and DB readiness. See [runbook](../room-host-transfer.md).

Rollback disables new transfers and drains/reconciles pending deliveries. Preserve
roles/pointer already transferred, creator, term, receipt and audit. Never revert
to a host-blind binary, reset ownership, drop the notification enum value, or
remove the constraints while an unfenced transfer writer may run. A deep rollback
requires a reviewed compatibility patch and ADR-0002 procedure after producers
are fenced and data verified; no destructive down migration is automatic.
