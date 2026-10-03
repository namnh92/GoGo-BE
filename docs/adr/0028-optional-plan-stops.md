# ADR-0028: Optional plan stops (`isOptional`)

- **Status:** accepted — shape decided by SA review (Astra) on 2026-10-02 under the owner's delegation on GoGo-BE#228; CODEOWNER approval of the contract/migration diff still required before merge
- **Date:** 2026-10-02
- **Deciders:** SA (shape), backend (implementation), CODEOWNER (contract + migration + optimizer)
- **Consumers:** GoGo-MobileApp APP-028 (GoGo-MobileApp#81); `GOGO_MOBILE_FIGMA_UI_IMPROVEMENT_SPEC.md` §20

## Context

`PlanStop` had `isLocked` and progress `status` only. The timeline needs
Locked / Optional / Required, and `PlanTotals` had no way to say which spend is
a commitment. Two existing defects surfaced while shaping it:

- `buildItinerary` marked **every** anchor locked (`optimizer.ts`, the anchor
  map), so a host edit that sent `isLocked: false` stored a locked stop.
- Regenerate kept a locked stop's place/duration/cost but recomputed its
  schedule, and the edit/regenerate publication did not recheck what the
  computation had read — a constraint change or a lock landing meanwhile could
  be overwritten by a plan built from older state, published as not stale.

## Options considered

1. **A dedicated optionality endpoint per stop** — a second write path that
   has to keep totals consistent with the stop list. Rejected.
2. **Extend `PATCH /v1/plans/{id}` stop entries with `isOptional`** — one
   versioned full-list write; the stop list and recalculated totals change
   atomically. Chosen.
3. **Redefine `costMin`/`costMax` as required-only** — silently changes what
   every existing consumer renders. Rejected in favour of additive fields.
4. **Let the optimizer/AI demote stops to optional under budget pressure** —
   would conceal a budget violation. Rejected.

## Decision

**Authority.** Only the host sets `isOptional` (existing `requireHost`);
members and guests read it through room membership. Generated and replacement
stops are always required.

**States.** Edits need the current plan, not stale, in a pre-active room:
`active`/`completed` → `409 ROOM_ACTIVE`, `cancelled`/`expired` →
`409 ROOM_NOT_EDITABLE`, stale → `409 PLAN_STALE` (regenerate first; an edit
never clears staleness). A non-empty all-optional plan is allowed.

**Edit semantics.** `isOptional` omitted keeps the retained place's value; a
new place starts `false`; explicit `false` clears it. A `placeId` may appear
once (`400 DUPLICATE_STOP_PLACE`). `expectedVersion` and `Idempotency-Key`
replay are unchanged.

**Locks.** `isOptional`, `isLocked` and `status` are independent; all four
optional/locked combinations are valid and lock/unlock never touches
optionality. The optimizer now carries each anchor's `isLocked` as given; the
finalize winner anchor states `isLocked: true` explicitly, so the stored
behaviour of a finalized plan is unchanged. Regenerate keeps every locked
stop's place, relative order, duration, cost, optionality **and stored
schedule**; travel around it is recalculated. A locked stop that can no longer
be reached at its stored time — or whose stored interval is inverted or falls
outside the room's current window — fails the build with `409 PLAN_TIME_CONFLICT`,
before anything is written. Unavailable locked stops stay (with their existing
warning); exclusions, budget pressure and a reduced stop limit never drop them.

**Totals.** `costMin`/`costMax` stay the sums over all stops. New required
fields `requiredCostMin`, `requiredCostMax`, `optionalCostMin`,
`optionalCostMax` split them (`costMin = requiredCostMin + optionalCostMin`).
Integer minor units, `costScope: per_person`, budget via the shared
`budgetPerPerson` N-member conversion. `overBudget` compares
`requiredCostMax` only, and the greedy fill budgets against required anchors
only. `WITHIN_BUDGET` is emitted only when the all-stop upper bound fits and no
price is uncertain — unknown is not free. Duration, distance, legs and
schedule include every stop. One aggregation (`suggestions/domain/plan-costs.ts`)
serves the optimizer and legacy reads.

**Concurrency.** Changing optionality versions the plan; it does not touch
room constraints or candidate scores. Publication (`createPlanVersion` with a
`guard`) takes the room row `FOR UPDATE` and rechecks: room status, room
`constraint_version` equals the snapshot's, the current plan is the source
plan at the read version (and not stale, for edits), and every source stop's
`isLocked`/`isOptional` is as read. Any mismatch is `409`
(`PLAN_VERSION_CONFLICT` / `PLAN_STALE` / `ROOM_*`). Stop locks take the same
room lock and refuse a superseded plan with `409 PLAN_NOT_CURRENT`. Provider
calls stay outside the transaction.

**Events.** No new event type: transactional `plan.changed` (payload gains a
bounded `optionalStopCount`) and the versioned `plan.updated` invalidation;
consumers refetch.

## Consequences

- Contract `1.0.0-alpha.61`: request `isOptional`; response
  `PlanStop.isOptional` and four `PlanTotals` fields, all required. Additive.
- `overBudget: false` no longer covers optional stops. Clients must compare
  `costMax` (or show the optional breakdown) before saying the whole plan fits.
- Behaviour changes visible to existing clients: an edit's `isLocked: false`
  now sticks (it was silently `true`); editing a stale plan or a
  cancelled/expired room is refused; locking a stop on a superseded plan is
  refused; `WITHIN_BUDGET` is no longer emitted for uncertain prices.
- Regenerate after the origin or start time moved can now answer
  `PLAN_TIME_CONFLICT` for a locked stop; the host unlocks it or edits the plan.

## Migration

`0068_plan-stops-optional.sql`: `ALTER TABLE plan_stops ADD COLUMN is_optional
boolean NOT NULL DEFAULT false` — catalogue-only on Postgres 11+, no rewrite.
Every historical stop is required. Stored `totals` JSON is not rewritten;
totals without the split read as required = totals, optional = 0.

The ACCESS EXCLUSIVE lock wait is bounded with `SET LOCAL lock_timeout = '5s'`
(reset right after). If a long transaction holds `plan_stops`, the deploy's
migration run fails with SQLSTATE `55P03` and — the migrator runs all pending
files in one transaction — changes nothing. Abort the deploy, find the holder
(`pg_locks` / `pg_stat_activity` on `plan_stops`), let it finish or end it, and
retry the deploy. Covered by an integration test that holds a conflicting lock.

## Rollback

An API build older than this change inserts `plan_stops` without
`is_optional`. Unguarded, every plan version it writes — edit, regenerate,
including the locked stops regenerate keeps — would silently turn optional
stops back into required ones. The rollback therefore blocks those lossy writes
at the database before the older build runs:

1. **Install the guard** — `scripts/rollback/0068-plan-stops-optional-guard.install.sql`.
   It drops the column default and adds a `BEFORE INSERT` trigger: an insert
   that omits `is_optional` gets `false` only when the room's previous plan
   version has no optional stop (nothing to lose, e.g. a first finalize);
   otherwise it fails with SQLSTATE `GG228` and the writer's transaction rolls
   back, so the plan in place keeps its optional stops. The current build
   writes the column explicitly and is unaffected (integration-tested).
2. **Deploy the older API.** Hosts of rooms whose plan has optional stops get a
   server error on edit/regenerate for as long as the older build runs; reads,
   locks, check-ins and rooms without optional stops work. That is the
   accepted cost of not losing host decisions.
3. **Keep the column.** Dropping it loses host decisions.
4. **Roll forward**, then remove the guard —
   `scripts/rollback/0068-plan-stops-optional-guard.remove.sql` restores the
   default and drops the trigger.
5. Rehearsal-only down: `ALTER TABLE plan_stops DROP COLUMN is_optional;`.
