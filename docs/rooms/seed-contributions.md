# Seed contribution traceability — Refs #878

The workspace SRS remains outside this worktree's writable scope. This decision
record implements the owner's 2026-11-12 amendment without altering unrelated
workspace work. Reconcile these FR descriptions into the workspace SRS when
integrating the PR:

| Requirement | Approved behavior                                                                                                                                                                 | Evidence                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| FR-ROOM-008 | Account member may contribute seeds; shared constraints and member administration stay host-only.                                                                                 | room-seed-places.int.spec.ts; existing rooms.int.spec.ts host-only constraints/status/invites |
| FR-ROOM-010 | Host/account members contribute published seeds in current room area, total distinct quota 10. Member removes only own membership's seeds; host removes all; guest cannot mutate. | seed-contribution.spec.ts; room-seed-places.int.spec.ts; room-administrative.int.spec.ts      |
| FR-ROOM-011 | Creation seeds use the same validator and get host membership attribution.                                                                                                        | room-seed-places.int.spec.ts                                                                  |
| Core rule 6 | One current constraint revision increment and stale scores/plans per changed set.                                                                                                 | room-seed-places.int.spec.ts; suggestion-plan.int.spec.ts                                     |
| Core rule 7 | Locked stops, votes and private preferences survive seed edits.                                                                                                                   | room-seed-places.int.spec.ts; suggestion-plan.int.spec.ts                                     |
| ADR-0005    | Typed 200 seed responses, attribution, errors, major version and generated artifacts.                                                                                             | room-seeds.contract.spec.ts; rooms.contract.spec.ts; scripts/artifacts.spec.ts                |
| ADR-0027    | Scoped seed change refresh signal, opaque reconnect/resync unchanged; best-effort post-commit publish.                                                                            | seed-mutation.spec.ts; room-event-bus-redis.int.spec.ts; room-events-reconnect.int.spec.ts    |

See ADR-0057 for policy, replay/locking, privacy, deployment and rollback.
`seed-readiness.sql` is a read-only pre-deploy inspection; it reports anomalies
without trimming data or changing creator identities. Run against the target DEV
revision and retain the output with release evidence. No database access from
this implementation session is implied.

Astra F-01 regressions: `rooms/infrastructure/seed-mutation.spec.ts` covers
post-validation re-read, unique duplicate no-op, zero-row DELETE and partial
batch effects. The `#878 F-01` cases in `room-seed-places.int.spec.ts` use real
CMS merge and seed services behind PostgreSQL advisory/row-lock barriers,
including unchanged revisions, invalidation, audit/outbox, SSE and replay on
merge-first POST/DELETE no-ops. Run on a DEV workstation with Docker:

```bash
pnpm test:integration apps/api/test/room-seed-places.int.spec.ts
```
