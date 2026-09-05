# ADR-0014: `/monitoring` reads four independent dimensions per provider

- **Status:** accepted
- **Date:** 2026-09-05
- **Deciders:** product owner + BE + CMS
- **Relates to** GoGo-BE#416 (COST-BE-033), GoGo-CMS#116 (COST-CMS-013),
  GoGo-CMS#112 (COST-CMS-012, the table this replaces), GoGo-BE#414 (the
  telemetry this precedes), GoGo-BE#370 (tracker), ADR-0012, ADR-0013
- **Requirement authority:** `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md`
  (COST-OBS-EPIC-001) §5, §6, §8, §23, §35, §44.2, §44.3, §44.5, §44.6

## Context

The owner made `/monitoring` the runtime surface for the whole provider
registry on 2026-09-05 (GoGo-CMS#112): one row per provider, none dropped for
lacking telemetry. The CMS derived a per-provider telemetry state on its own —
`INSTRUMENTED / NOT_INSTRUMENTED / NO_TELEMETRY / NA` — from three registry
facts that describe different things: the registry `status`, the declared
cost _capabilities_, and the collector _freshness_ sources.

Three problems surfaced as soon as the table existed, and all of them are
semantic, not visual:

1. **`NO_TELEMETRY` is ambiguous.** It was assigned to `planned` providers
   and read as "no telemetry exists", which is also true of `NOT_INSTRUMENTED`
   and of `N/A`. Nobody could say from the word alone whether something was
   missing, not yet wired, or not applicable.
2. **The registry `status` carried a cost-ingestion concept.** `manual` sat
   beside `active` and `planned` as if "how the money gets in" were a stage of
   integration. It is a capability (`MANUAL_COST`, epic §6), and encoding it as
   a status forced the CMS to branch on status to decide a telemetry question.
3. **A binary provider state hid the actual coverage.** Google reads
   "instrumented" while two of its five runtime services (Maps SDK iOS and
   Android) emit nothing. "Instrumented" was true of _some_ of Google, and the
   word does not say how much.

GoGo-BE#414 is about to add runtime telemetry for Redis, Postgres and R2. If
the semantics are not fixed first, every new metric would be reported through
the same conflated state and the table would get harder to read as it got
more complete. Epic §8 ("usage and cost must be separate") and §44.5 already
insist that runtime telemetry and cost usage are different things; this ADR
applies the same separation to what the console _shows_.

## Options considered

1. **Keep deriving in the CMS, rename `NO_TELEMETRY`.** Cheapest. Leaves the
   derivation spread across three unrelated facts and leaves `manual` in the
   status enum; every new provider or capability re-opens the question of what
   the CMS should infer. Rejected — it treats a naming problem as if it were the
   whole problem.
2. **Compute four independent dimensions in GoGo-BE and have the CMS render
   them.** Registry status, runtime coverage, cost-source kind and cost-data
   freshness each answer one question from one set of facts; the CMS shows
   what it is told and infers nothing. Costs a contract change and a
   registry-data addition (each service must declare whether it has a runtime
   surface). **Chosen.**
3. **Model runtime telemetry as a capability (`RUNTIME_TELEMETRY`) in the epic
   §6 list.** Would reuse the capability machinery, but the §6 list is closed
   by the epic ("adding a capability is an epic change"), and a capability says
   what the Cost Center can _do_, not whether a process _calls_ something.
   Rejected; runtime surface is a separate declaration on the service.

## Decision

Every provider row and service row of the Cost API v2 (`/v1/cms/ops/costs*`)
carries four fields that never derive from one another:

| Dimension           | Field              | Values                                       | Computed from                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry status     | `status`           | `active`, `planned`                          | `ProviderDefinition.status`. Integration lifecycle only. `manual` is retired; manual-only providers are `active` because the manual-item form (#382) _is_ their implementation.                                                                                                                                 |
| Runtime coverage    | `runtime.coverage` | `FULL`, `PARTIAL`, `NOT_INSTRUMENTED`, `N/A` | A new `ServiceDefinition.runtime` surface (`in_process`, `client_sdk`, `none`) and `OperationDefinition.instrumented`. Nothing else.                                                                                                                                                                            |
| Cost source         | `cost.kind`        | `AUTO`, `MANUAL`, `NONE`                     | Capabilities: `USAGE_COLLECTOR` / `ACTUAL_COST_COLLECTOR` / `FIXED_COST` → `AUTO`; `MANUAL_COST` → `MANUAL`; else `NONE`. A service's own declarations win over what it inherits.                                                                                                                               |
| Cost-data freshness | `cost.freshness`   | `FRESH`, `STALE`, `ERROR`, `null`            | `AUTO`: the epic §23 roll-up over covering sources — `UNAVAILABLE` and `UNKNOWN` both read `ERROR`; with no covering source, the cost rows decide (today → `FRESH`, older → `STALE`, none → `ERROR`). `MANUAL`: the materialised rows alone (today → `FRESH`, older → `STALE`, none → `null`). `NONE` → `null`. |

Runtime coverage rules, per service: `none` surface → `N/A`; a surface with no
instrumented operation (including none registered) → `NOT_INSTRUMENTED`; all
instrumented → `FULL`; otherwise `PARTIAL`. Per provider, over services with a
surface: all `FULL` → `FULL`; all `NOT_INSTRUMENTED` → `NOT_INSTRUMENTED`;
none surfaced → `N/A`; otherwise `PARTIAL`. The provider row also carries the
counts (`services: {full, partial, notInstrumented}`,
`operations: {instrumented, total}`) and each service row its own
`runtime`, so the console drills down instead of reading one word.

Applied to today's registry: **Google is `PARTIAL`** (Places, Routes, Sheets
`FULL`; both Maps SDKs `NOT_INSTRUMENTED`), Upstash / Neon / Cloudflare are
`NOT_INSTRUMENTED` (this process calls Redis, Postgres and R2 and measures
none of it — the #414 gap, stated as one), AWS / GitHub / the internal
provider / the fees / the planned providers are `N/A`.

The per-source §23 detail (`freshness.sources[]`, four statuses) stays on the
row untouched: `cost.freshness` is the operator's roll-up, not a replacement
for the audit trail.

Two registry invariants back this: a service with `runtime: 'none'` may not
declare an instrumented operation, and `status` accepts only the two
lifecycle values.

## Consequences

- The CMS `/monitoring` registry table renders the four fields and derives
  nothing (`telemetryState()` and its capability allowlist are deleted).
  `NO_TELEMETRY` disappears; `planned` shows as `N/A` at runtime with `NONE`
  for cost, which is what it is.
- GoGo-BE#414 becomes a data change on the registry (add the operations, flip
  `instrumented`) plus the metrics; the row semantics do not move.
- `status: manual` is a **breaking removal** on the Cost API v2 contract. The
  only consumer is GoGo-CMS, updated in lockstep (COST-CMS-013). No release
  ships between the two, so no compatibility shim is kept.
- `instrumented` on service rows is kept as `runtime.coverage ∈ {FULL, PARTIAL}`
  for the first contract's readers; nothing new should read it.
- A future provider must declare a runtime surface for every service or the
  registry does not typecheck — the one place the question is asked.

## Migration & rollback

Adopt: merge GoGo-BE#416 (registry data + row fields + OpenAPI), then
GoGo-CMS#116 (re-vendored contract + table). Deploy BE first; the CMS build
before #116 tolerates the added fields and fails only on a `manual` status,
which no longer exists.

Roll back: revert both PRs together. The registry data change is additive and
the tables are untouched, so there is no data migration to reverse.
