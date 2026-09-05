# Cost observability

Requirement: `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md` (COST-OBS-EPIC-001,
workspace). Tracker: GoGo-BE#370. Provider inventory (Phase 0 audit): `docs/cost-inventory.md`. This page says what exists in `libs/modules/cost`
and how to add a provider without touching generic code.

## Pieces

| Piece                                                                                                                                                                                                                                                                                                            | File                                                                                                            | Epic §                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Definitions registry — providers, services, operations, usage meters, billing SKUs                                                                                                                                                                                                                               | `domain/registry.ts`                                                                                            | §5, §4                 |
| Capability model                                                                                                                                                                                                                                                                                                 | `domain/capabilities.ts`                                                                                        | §6                     |
| Pricing rules — versioned, per SKU/meter, pricing models, free allowances                                                                                                                                                                                                                                        | `domain/pricing-rules.ts`                                                                                       | §13–§15                |
| Compatibility view (`PROVIDER_PRICING`, `providerOf`, `listCostMicros`…) used by the ops API, budget guard and baseline runner                                                                                                                                                                                   | `domain/provider-pricing.ts`                                                                                    | —                      |
| Ports: `UsageCollector`, `ActualCostCollector`, `CostEstimator`, `QuotaCollector`, `FixedCostProvider`                                                                                                                                                                                                           | `ports/collectors.port.ts`                                                                                      | §7                     |
| Adapter registry — what is wired in this process, checked against declared capabilities                                                                                                                                                                                                                          | `ports/adapter-registry.ts`                                                                                     | §7                     |
| Usage ledger (metrics port → `provider_usage_daily` **and** `provider_usage_meter_daily`, one transaction)                                                                                                                                                                                                       | `application/usage-ledger.ts`                                                                                   | §10, §24               |
| Budget reservation guard (`provider_budget_daily`)                                                                                                                                                                                                                                                               | `application/provider-budget.service.ts`                                                                        | §32 (daily guard)      |
| Estimated-cost report for the CMS ops surface                                                                                                                                                                                                                                                                    | `application/usage-report.service.ts`                                                                           | §35 (partial)          |
| Generic estimator (meter rows × pricing rules → `provider_cost_daily` ESTIMATED; idempotent, bounded, never touches ACTUAL)                                                                                                                                                                                      | `application/cost-estimator.service.ts`; worker job `gogo:worker:cost-estimate`                                 | §7, §11, §13, §15, §25 |
| Freshness model (`FRESH/STALE/UNAVAILABLE/UNKNOWN`, derived from facts against `now`; bounded backoff)                                                                                                                                                                                                           | `domain/freshness.ts`; table `cost_source_freshness` (0039)                                                     | §23, §22               |
| Collector definitions — frequency, timeout, retry, `maxCallsPerDay`, environments, **declared monitoring cost**                                                                                                                                                                                                  | `domain/collector.ts`                                                                                           | §19, §20               |
| Collector scheduler — due check, timeout, isolation per collector, freshness upsert, monitoring-budget pause, cost-of-cost row under `gogo.cost_observability`                                                                                                                                                   | `application/collector-scheduler.service.ts`; worker job `gogo:worker:cost-collectors`                          | §19–§22, §38           |
| First collector: `ledger` (FREE, essential) — reports the ledger's freshness, `sourceAsOf` = newest ledger write                                                                                                                                                                                                 | `application/ledger-freshness.collector.ts`                                                                     | §23                    |
| Test-run cost records — `cost_test_runs` + `cost_test_run_deltas` (0040), `TestCostService.start/finish/fail`, soft budgets, service scoping; baseline runner writes a row beside its frozen JSON                                                                                                                | `application/test-cost.service.ts`; `scripts/cost-baseline/runner.ts` `testCost` hook                           | §28–§30, §43, §44.17   |
| Monthly budgets + forecast — `cost_budgets` (0041), `spend()` precedence ACTUAL > ESTIMATED (never summed; FIXED/MANUAL separate), `BudgetService.overview`                                                                                                                                                      | `domain/budget.ts`, `application/budget.service.ts`                                                             | §12, §32, §33          |
| Forecast on billing semantics (0043, ADR-0015) — `cost_kind` / `billing_cadence` / `period_amount_micros` on every cost row; `monthForecast` = month actual, end-of-month cash (usage projection + recurring billed this month + one-offs), normalised run-rate (annual ÷ 12, no one-offs)                       | `domain/forecast.ts`, `domain/budget.ts` (`usageProjectionMicros`), migration 0043                              | §33 (amended), §27     |
| Backfill from Prometheus (`increase()` per UTC day → `provider_usage_meter_daily` source `prometheus_backfill`, LOW, floored; ≤ 62 days; idempotent; audited `cost.backfill`) + reconciliation (estimated vs actual per service, variance null without an actual; `reconciled_at` on matched pairs)              | `application/prometheus-backfill.service.ts`, `application/reconciliation.service.ts`; CLI `pnpm cost:backfill` | §10, §25, §26          |
| Manual / fixed costs — `manual_cost_items` (0042), CMS CRUD with audit `cost.manual_item.*`, materialised into `provider_cost_daily` as MANUAL rows (one per **billing day** ≤ today at the full fee since 0043, source `manual_cost_items:<id>`); `MANUAL_COST` capability decides which services may carry one | `domain/manual-cost.ts`, `application/manual-cost.service.ts`; worker job `gogo:worker:cost-collectors` (daily) | §27, §44.18            |

Not yet built (see #370): non-Google collectors (each registers a `CollectorDefinition`),
ACTUAL cost collectors, Maps SDK telemetry, alerts.

## Tables (migration 0038)

| Table                         | One row per                                                                          | Notes                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_usage_daily` (0035) | day × environment × operation                                                        | Google-shaped legacy table; still what the ops API and budget guard read                                                                                                                                                                                                        |
| `provider_usage_meter_daily`  | day × environment × provider × service × operation? × meter × SKU? × source          | epic §9. `usage_metric_id` is the meter's short metric (`calls`, `requests`, `billable_elements`, `commands`); `quantity` is an integer; `source` names the collector. Unique key uses `COALESCE(operation_id,'')` / `COALESCE(billing_sku_id,'')`                              |
| `provider_cost_daily`         | day × environment × provider × service × operation? × meter? × SKU? × source × basis | epic §11. `amount_micros` in original `currency`; `basis` ∈ ACTUAL/ESTIMATED/FIXED/MANUAL; `confidence`; `pricing_version` for estimates; `reconciled_at` for ACTUAL↔ESTIMATED pairs. **Unknown cost = no row.** Readers apply ACTUAL > ESTIMATED > UNKNOWN and never sum bases |

The ledger writes `calls` (attempted, not billed) and the operation's billable meter
(`requests` for Places, `billable_elements` for Routes) as `source = 'ledger'`,
`confidence = 'HIGH'`. The estimator job (`COST_ESTIMATE_POLL_MS`, default 15 min;
`COST_ESTIMATE_ENABLED=false` to stop) recomputes this month and last month every
tick: delete own rows in range, re-insert — so a pricing-rule change re-prices
history under the new `pricing_version` on the next tick (epic §25 backfill, bounded
to two months; a wider backfill is a manual `recompute({from,to})`).

## Collectors and freshness (migration 0039)

A collector is a `CollectorDefinition` registered on `CollectorSchedulerService` at
worker boot. Registration is refused unless the definitions registry knows the
provider and it declares the collector's capability. Each tick:

1. Sum the declared `monitoringCost` of enabled collectors; over the environment
   budget (`COST_MONITORING_BUDGET_MICROS`, default $1 DEV / $5 PROD per month) →
   non-essential collectors are paused and marked STALE; `cost_monitoring_over_budget_total`
   increments. Any collector above $1/month is listed as `needsApproval`.
2. For each collector: due? (`last_attempt_at + frequency × 2^failures`, capped ×8) →
   `maxCallsPerDay` left? → run with timeout → upsert `cost_source_freshness`.
   One collector failing marks only its own row (`UNAVAILABLE`, `last_error_code`)
   and backs off; the others run.
3. Write today's cost-of-cost row: `provider_cost_daily` `gogo` / `gogo.cost_observability`,
   `basis = FIXED`, `source = 'monitoring_cost_model'`, amount = known monthly ÷ days in month;
   confidence LOW and `metadata.unknownCollectors` when any collector's cost is UNKNOWN.

Status is derived by readers from the stored facts (`freshnessStatus`), so a row
reads FRESH in the morning and STALE at night without a write. **Measured zero ≠
not measured**: a stale source keeps its numbers; only the label changes.

## Test-run cost (migration 0040)

`TestCostService.start(name, {environment, gitSha?, services?, budget?})` sums
`provider_usage_meter_daily` per meter key (all days, all sources — sums only grow
while a test runs) and opens a `cost_test_runs` row; `finish(id)` snapshots again,
writes one `cost_test_run_deltas` row per changed meter priced at **list** under the
rule in force that day (no free-cap adjustment on a test), checks the optional
budget (`maxProviderCalls`, `maxProviderUsage` keyed `<service>/<metric>`,
`maxEstimatedCostMicros`) and sets `status = ok | over_budget` — soft, never a
throw (epic §29). `services` scopes the deltas (§30). Unknown price ⇒
`estimated_cost_delta` null, basis UNKNOWN. Manual/fixed costs are not usage and
never enter a delta. Run id and git sha live in the row, never in a metric label.

## Budgets and forecast (migration 0041)

`cost_budgets` holds one amount per (environment, scope) — scope TOTAL, PROVIDER
`<providerId>` or SERVICE `<serviceId>`; the id must exist in the registry. It is
reported against, never enforced: `provider_budget_daily` remains the hard guard.

`spend(rows)` applies epic §12 over `provider_cost_daily`: for the same day and
meter key, ACTUAL beats ESTIMATED and the two are never added (the shadowed
estimate is kept as `shadowedEstimatedMicros` for reconciliation); among several
rows of the winning basis the most confident wins; FIXED and MANUAL are separate
costs counted once each. The result is also split `byKind` (below).
`costBudgetStatus` states: `ok` / `warning` (≥ 80 %) / `projected_exceed` /
`exceeded`, projected against the scope's **end-of-month cash forecast** (a
committed floor above the budget is `projected_exceed` even while the usage half
cannot be projected). `BudgetService.overview(month)` returns spend, the forecast,
every budget's status and a per-service split; the Cost API v2 (#381) reads it
into `cards.forecast` and `cards.budget`.

## Forecast on billing semantics (migration 0043, #415, ADR-0015)

Epic §33 as amended: **nothing is derived from the month-to-date total.** Every
`provider_cost_daily` row carries `cost_kind` (`USAGE | RECURRING | ONE_TIME`, NOT
NULL, no default — a writer must say how a charge is billed), `billing_cadence`
(`MONTHLY | ANNUAL`, present exactly when RECURRING) and `period_amount_micros`
(the period's full charge, required when RECURRING), under check constraints.
Producers: the estimator stamps USAGE (RECURRING for a `FIXED_MONTHLY` /
`FIXED_ANNUAL` rule, `classifyRule`), the AWS / GitHub collectors USAGE, the
monitoring cost model RECURRING MONTHLY with `knownMonthlyMicros` as the period
amount, the manual-cost materialiser from the item's period (`classifyPeriod`).
`upsertCostSamples` defaults a RECURRING sample's cadence to MONTHLY and its period
amount to the sample amount when a collector omits them.

`monthForecast()` (`domain/forecast.ts`, pure) takes the month's rows and the
manual items' **schedule** (`manualSchedule`: the charges billed in the month and
the recurring items active in it) and returns three numbers kept apart:

| Number    | Formula                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `actual`  | `spend()` over the month's rows, by kind                                              |
| `cash`    | `usage.projectedMicros` + `recurring.committedMicros` + one-time (landed + scheduled) |
| `runRate` | `usage.projectedMicros` + active MONTHLY fees + active ANNUAL fees ÷ 12               |

`usage.projectedMicros` = USAGE MTD ÷ elapsed days × days in month
(`usageProjectionMicros`), `null` under three elapsed days
(`INSUFFICIENT_HISTORY`) or with no usage rows (`NO_USAGE_ROWS`); a scope nothing
in which can produce usage (`BudgetService.usageExpected`, from the registry) has
a known zero usage half (`NOT_APPLICABLE`). While the usage half is null, `cash.micros`
is null, `cash.partial` is true and `cash.floorMicros` (recurring committed +
one-time) is the honest floor. `recurring.scheduledMicros` is, per commitment,
`max(0, period amount − landed)`: for a manual item the commitment is its charge
in the schedule; for a recurring source with no item (the monitoring model) it is
the latest row's `period_amount_micros`. A manual row whose item bills nothing
this month (a moved anchor, a pre-0043 daily share) counts as landed only.
`scheduled[]` lists what has not landed, soonest first. One-time charges never
enter the run-rate; an annual fee enters `cash` only in its renewal month and the
run-rate always, as a twelfth. Mixed currencies null the totals and keep the parts.

## Backfill and reconciliation

`pnpm cost:backfill --env dev --from 2026-09-01 --to 2026-09-02` reads
`sum by (method,status)(increase(places_provider_requests_total{env}[1d]))` and the
`places_provider_cost_units{sku}` twin per UTC day, floors the values (epic §10 —
extrapolated is not counted), maps them through the same `meterRowsFor` the ledger
uses, and upserts `provider_usage_meter_daily` under `source = 'prometheus_backfill'`,
`confidence = 'LOW'`. A re-run replaces the day. The ledger's rows and every cost row
are untouched; the estimator prices the backfilled view on its next tick as its own
source, and `spend()` never adds the two views. Bounded to 62 days per call, audited
as `cost.backfill`. Known use: DEV 2026-09-01/02 Routes calls that predate the ledger.

`pnpm cost:backfill --env dev --reconcile 2026-09 [--mark]` prints, per service,
estimated vs actual with `variance = actual − estimated` and
`variancePct = variance / actual` — `null` wherever there is no ACTUAL row (nothing is
invented). `--mark` stamps `reconciled_at` on ESTIMATED/ACTUAL pairs that share a day
and meter key; amounts never change.

## Cost API v2 (#381, epic §34–§36)

Registry-keyed, under the existing namespace — never `/costs/google`. All routes
`@RequireRole('ops_admin', 'super_admin')`; `window` ∈ `today | 7d | 30d | mtd`
(default `mtd`; the daily tables cannot answer `1h`):

| Route                                                             | Returns                                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/cms/ops/costs?window=`                                   | legacy #335 payload (deprecated fields, one release) **+** `cards`, `providerRows`, `range`, `month`, `generatedAt`, `unattributed` |
| `GET /v1/cms/ops/costs/providers`                                 | one `ProviderCostRow` per registry provider, registry order, services nested                                                        |
| `GET /v1/cms/ops/costs/providers/:providerId`                     | one provider row; unknown id → 404 `COST_PROVIDER_NOT_FOUND`                                                                        |
| `GET /v1/cms/ops/costs/providers/:providerId/services/:serviceId` | service row + `operations[]` (meters per operation, unregistered labels flagged); wrong provider → 404                              |
| `GET /v1/cms/ops/costs/test-runs?limit=`                          | `TestCostService.list` — newest runs first                                                                                          |
| `GET /v1/cms/ops/costs/test-runs/:id`                             | `TestCostService.get` — run + deltas + `estimatedCostMicros` + `unpriced`; open run → totals `null`                                 |

`CostCenterService` (`cost/application/cost-center.service.ts`) is a plain class over
`CostRegistry` + `Db`; the Nest `CmsCostCenterService` builds it from config and turns
`null` into 404. Row rules, all tested (`cost-center.service.spec.ts`,
`cost-center.int.spec.ts`):

- **Money** goes through `spend()` / `winningRows()`: `spendMicros` after §12
  precedence, `estimatedMicros` (best estimate per key, shadowed or not),
  `actualMicros`, `fixedMicros`, `manualMicros`, `shadowedEstimatedMicros`, `basis`
  (`ACTUAL|ESTIMATED|FIXED|MANUAL|MIXED|UNKNOWN`), lowest `confidence`, `currency`,
  `mixedCurrency`.
- **`costStatus`**: `KNOWN` (a cost row exists) / `MEASURED_ZERO` (no cost row, no usage,
  an `instrumented: true` operation, and a FRESH-or-STALE source covering the provider;
  `spendMicros: 0`) / `UNKNOWN` (`spendMicros: null`, never 0 — the CMS renders "—",
  "Chưa có nguồn chi phí").
- **Usage lines** per meter: for one (day, meter) the most confident source wins
  (ledger over `prometheus_backfill`), winners summed over the window. Two sources never
  add. `meterId` is the registry id or `null` when unregistered.
- **Freshness per row** from `cost_source_freshness`, recomputed against now: a source
  covers a service when it names it or names only the provider; the row takes the worst
  status (FRESH < STALE < UNKNOWN < UNAVAILABLE), newest `sourceAsOf`; no source →
  `UNKNOWN`.
- **`quota: null`** until a QUOTA collector exists.
- **Cards** are month-shaped whatever the window: `today`, `monthToDate`, `projected`
  (`BudgetService.overview`, `null` under three elapsed days), `budget` (TOTAL status +
  every budget), `unknown` (providers/services with `costStatus: UNKNOWN`),
  `costOfMonitoring` (MTD spend over registry services with `category: 'internal'` — no
  id literal in generic code).
- **§44.2**: a provider added to `COST_REGISTRY_DATA` is a row with no API/CMS change
  (`cost-center.int.spec.ts` builds a registry with a fake `acme` and reads it back).
  Ids the registry does not know are listed in `unattributed`, not dropped.
- **Four dimensions per row (ADR-0014, #416)**, never derived from one another:
  `status` (`active | planned` — integration lifecycle only; `manual` is retired),
  `runtime` (`coverage` `FULL | PARTIAL | NOT_INSTRUMENTED | N/A` from each service's
  declared `runtime` surface `in_process | client_sdk | none` and its operations'
  `instrumented`, with `services` / `operations` counts on the provider and `surface`
  on the service), `cost.kind` (`AUTO | MANUAL | NONE` from capabilities) and
  `cost.freshness` (`FRESH | STALE | ERROR | UNKNOWN | null` — the §23 roll-up for
  AUTO, UNAVAILABLE → `ERROR`, never attempted → `UNKNOWN`; the materialised rows for
  MANUAL). `ERROR` is reserved for an attempt that failed. Google today is
  `PARTIAL` (3 of 5 runtime services measured); Upstash Redis and Neon Postgres
  are `FULL` (#414, below); Cloudflare is `N/A` — R2 is only _signed for_ in this
  process and Workers run at the edge. Pure functions: `domain/runtime-coverage.ts`,
  `domain/cost-source.ts`.
- **No money on `/monitoring` (ADR-0014 amendment 2026-09-05, #420).**
  `/cms/ops/summary|providers|providers/{provider}` state no amount: `costModel`,
  `estimatedCost*`, `costComplete`, `unpricedOperations` and `measurementGaps` are
  gone and the ops domain no longer reads the price list to make a number (it
  still names the SKU behind `billableUnits`). Each provider / operation row
  carries `costCenter { providerId, serviceId | null }` — registry ids — and the
  CMS links to that `/costs` row where the estimate used to be. `/cms/ops/costs`
  is the only surface for actual, estimated, forecast, free-tier and manual
  money. The legacy `gaps[]` on `/cms/ops/costs` (Cost API v1) is untouched.
- **Infrastructure runtime telemetry (#414).** The Redis stores (rate limit,
  session revocation, room event bus) and every Postgres statement emit
  `provider_requests_total{provider, service, operation, status}` and
  `provider_request_duration_seconds{…}` through `meterRuntimeCall` /
  `createDb({ runtime })`. The three ids are the registry's — declared once in
  `domain/runtime-operations.ts`, used by the registry (`instrumented: true`) and
  by the adapters — so a `/monitoring` row and a Prometheus series name the same
  operation; `status` is `ok | error`. They go to the `RUNTIME_METRICS` sink (the
  Prometheus registry alone, never the log sink: a metric per statement is a
  series, not a log line) and never to the usage ledger — runtime telemetry is
  not a cost meter (§8); Upstash's command count and Neon's compute hours stay the
  collectors' to read. Not measured, on purpose: the `/health` Redis ping and the
  CMS queue-stats probe (ops paths, not request paths) and R2 (no request leaves
  the process).

Deprecated, kept one release: the legacy `providers[]` / `gaps[]` on `/cms/ops/costs`
and `/cms/ops/providers/{provider}` (enum `places|routes|sheets`). CMS re-vendor is
COST-CMS-009 (CMS#105).

## Manual costs (migration 0042, #382, epic §27)

`manual_cost_items` is the record an operator edits: a fee under a registry
provider + service, `amountMicros` of `currency` **per period** (`ONE_TIME |
MONTHLY | YEARLY` — the operator's word for `costKind` / `billingCadence`,
`classifyPeriod`), an inclusive `effectiveFrom`/`effectiveTo` (null = open-ended),
a note. `environment` mirrors `cost_budgets`. Nothing reports spend from this table:
`ManualCostService.materialise()` rebuilds the item's rows in `provider_cost_daily`
— `basis = MANUAL`, `confidence = HIGH`, `source = manual_cost_items:<id>` (one
source per item, because two domains under `registrar.domain` are two costs and the
table's key has no other column to tell them apart), `cost_kind` /
`billing_cadence` / `period_amount_micros` from the period, `metadata` naming the
item and its `chargeDay` — **one row per billing day at the full amount**
(ADR-0015), **never past today**. A MONTHLY item bills on the day-of-month of
`effectiveFrom` each month (clamped to shorter months, `anchorDayInMonth`), a
YEARLY item on its month-day each year (Feb 29 → Feb 28), a ONE_TIME item once
(`chargeDays`). Nothing is spread per day: a daily share of an annual fee would put
money into a month that never invoices it. Rows on any other day, or under another
service (moved anchor, moved service, shortened range, deleted item, a pre-0043
daily share), are deleted in the same pass, so the operation is idempotent and
`updated_at` moves only when an amount, currency, classification or metadata
actually changed. The item DTO also carries `nextChargeDay` (`nextChargeDay()`,
the first billing day on or after today).

When it runs: after every CMS write (the response already reflects the change), and
once per UTC day in `gogo:worker:cost-collectors` so a charge that falls due today
lands by itself — free, so it ignores `COST_COLLECTORS_ENABLED`. Every reader then
sees a subscription the way it sees an invoice: `spend()` counts MANUAL once beside
ACTUAL/ESTIMATED and budgets include it, the Cost API reports it as `manualMicros`
/ `basis: MANUAL`, and what the item still bills this month is the forecast's
schedule (`manualSchedule`). Per-test deltas are usage deltas and never include it
(epic §27, "excluded by default").

Who may carry one is the registry's answer: `serviceHasCapability(id, 'MANUAL_COST')`
— `apple.*`, `hosting.*`, `registrar.*` (provider-wide) and `google.play_console`
(service-only; `google` itself does not declare it, so `google.places` is refused).
`servicesWith('MANUAL_COST')` is what the CMS form lists (`eligibleServices`): a new
manual provider in `COST_REGISTRY_DATA` appears with no code change.

| Route (all `ops_admin` / `super_admin`)     | Does                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /v1/cms/ops/costs/manual-items`        | `{ items, eligibleServices }`                                                                         |
| `POST /v1/cms/ops/costs/manual-items`       | create → 201 `{ item }`; `Idempotency-Key` replays; audited `cost.manual_item.created`                |
| `GET /v1/cms/ops/costs/manual-items/:id`    | one item; unknown → 404 `COST_MANUAL_ITEM_NOT_FOUND`                                                  |
| `PATCH /v1/cms/ops/costs/manual-items/:id`  | partial; merged item validated whole; audited `cost.manual_item.updated` with the changed fields only |
| `DELETE /v1/cms/ops/costs/manual-items/:id` | `{ deleted: true }`; rows gone before the response; audited `cost.manual_item.deleted`                |

A refused write is a 400 `COST_MANUAL_ITEM_INVALID` with one field error
(`unknown_provider`, `unknown_service`, `manual_cost_not_supported`,
`invalid_range`, `invalid_currency`, …). CMS counterpart: COST-CMS-010 (CMS#106).

## Cloudflare collectors (#383, epic §41-P2, §42.8–.9)

Two `CollectorDefinition`s built by `cloudflareCollectors(db, client, options)`
(`cost/application/cloudflare.collector.ts`) and registered at worker boot **only
when** `cloudflareAnalyticsFromEnv(process.env)` returns a client — i.e. both
`CLOUDFLARE_ANALYTICS_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (INF-060, Infra#114) are
set. Absent, nothing registers, nothing errors, and the provider row reads freshness
`UNKNOWN` / cost `UNKNOWN`: the truthful state, not a zero.

| Collector            | Service              | Source dataset(s)                                       | Meters written                           |
| -------------------- | -------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `cloudflare_r2`      | `cloudflare.r2`      | `r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups` | `class_a`, `class_b`, `storage_gb_month` |
| `cloudflare_workers` | `cloudflare.workers` | `workersInvocationsAdaptive`                            | `requests`                               |

- Settings (issue #383): every 6h, timeout 15s, one attempt per tick, `maxCallsPerDay`
  8, `staleAfter` 24h, FREE (the GraphQL Analytics API has no per-query price),
  non-essential. Two POSTs per run: **yesterday and today**, because adaptive
  analytics settle after midnight.
- Rows go to `provider_usage_meter_daily` with `source = 'cloudflare_api'`,
  confidence HIGH, and **replace** semantics (`quantity = excluded.quantity`): the
  dataset is the day's total, unlike the ledger which increments per call. A quiet
  day is written as `0` — measured zero, never an absent row.
- Class A / Class B come from the R2 pricing page's action lists
  (`R2_CLASS_A_ACTIONS` / `R2_CLASS_B_ACTIONS` in the providers adapter). An action
  the page does not list is counted in `metadata.unclassified`, the two operation
  rows drop to MEDIUM, and nothing is guessed into a class.
- `storage_gb_month` is the day's **peak** payload+metadata bytes, ceil to decimal
  GB. A `gb_month` meter is sampled daily; the month's GB-month is the mean of its
  days (Cloudflare's own definition), so `estimateMicros(rule, qty, prior, day)`
  prices a `PER_GB_MONTH` row at 1/D of the monthly price and the 10 GB-month
  allowance as 10 × D GB-days. Without a `day` the old whole-GB-month meaning holds.
- Declared, **not** collected: `egress_gb` (R2 egress is free; the dataset has no
  egress bytes) and `cpu_ms` (only CPU-time quantiles exist, and a quantile × count
  is an extrapolation, epic §44.8). Both stay non-billable until a source exists.
- Scope: `CLOUDFLARE_R2_BUCKETS` / `CLOUDFLARE_WORKER_SCRIPTS` (comma lists) narrow
  the account-wide datasets to this environment's resources (Terraform names them
  `<prefix>-assets`, `<prefix>-share-link`). Unset → whole account, and
  `metadata.scope = 'account'` says so. The R2 free tier is per account either way,
  which is why the estimate stays MEDIUM.
- Pricing (`cloudflare-*-2026-09-01-v1`, reviewed 2026-09-03): Class A $4.50/M with
  1M/month free, Class B $0.36/M with 10M/month free, storage $0.015/GB-month with
  10 GB-month free, Workers `FREE` with the Free plan's 100k requests/day recorded as
  a daily allowance — a cap, not a price; the rule switches to `PER_MILLION_REQUESTS`
  the day the plan does.
- Registry: `cloudflare` is `active` with `USAGE_COLLECTOR` + `ESTIMATED_COST` (the
  registry invariant is _planned ⇒ no capabilities_, so an implemented-but-
  unconfigured provider is `active` with `UNKNOWN` freshness, not `planned`).
- Tests: `cloudflare-analytics.adapter.spec.ts` (GraphQL fixtures, error codes,
  env gate), `cloudflare.collector.spec.ts` (rows, definitions, day pairing),
  `cost-cloudflare.int.spec.ts` (replace-upsert, freshness, failure isolation,
  estimator free tier + proration, Cost Center read-back).

## Upstash Redis collector (#384, epic §41-P2, §42.7)

One `CollectorDefinition` built by `upstashRedisCollector(db, client, options)`
(`cost/application/upstash.collector.ts`) and registered at worker boot **only
when** `upstashDeveloperApiFromEnv(process.env)` returns a client — i.e. all of
`UPSTASH_API_EMAIL`, `UPSTASH_API_KEY`, `UPSTASH_DATABASE_ID` (INF-060, Infra#114)
are set. Absent, nothing registers, nothing errors, and the provider row reads
freshness `UNKNOWN` / cost `UNKNOWN`: the truthful state, not a zero.

| Collector       | Service         | Source                                           | Meters written                                 |
| --------------- | --------------- | ------------------------------------------------ | ---------------------------------------------- |
| `upstash_redis` | `upstash.redis` | Developer API `GET /v2/redis/stats/{databaseId}` | `commands`, `bandwidth_bytes`, `storage_bytes` |

- Settings (issue #384): every 6h, timeout 15s, one attempt per tick, `maxCallsPerDay`
  8, `staleAfter` 24h, FREE (the Developer API has no per-request charge),
  non-essential. **One GET per run**: the answer carries the daily charts, so
  yesterday and today are both written from it, and yesterday is re-read because
  the last run of a day happens before midnight.
- Rows go to `provider_usage_meter_daily` with `source = 'upstash_api'` and
  **replace** semantics (`quantity = excluded.quantity`): the endpoint reports the
  day's total, unlike the ledger which increments per call.
- `commands` is the day's `dailyrequests` point (today falls back to the live
  `daily_net_commands`): HIGH, or MEDIUM when today's two figures disagree —
  `metadata.dailyNetCommands` keeps the other one. A day inside the charts' window
  (`days.length`, `metadata.windowDays`) with no point is a measured `0`; a day
  outside the window gets **no row** — absent is not zero (epic §44.6, §44.10).
- `bandwidth_bytes` is today's `dailybandwidth` (HIGH, "Total daily bandwidth
  usage in bytes"); other days come from the `bandwidths` point at MEDIUM, because
  the docs' example disagrees with the scalar and the series' unit is unverified
  until a live run compares today's two (`metadata.seriesBandwidthBytes`).
- `storage_bytes` is the peak of the day's `diskusage` samples plus `current_storage`
  for today — MEDIUM, `metadata.definition = 'peak of point-in-time samples'`. No
  sample on the day, no row.
- Only `commands` is billed (`redis.commands`). Storage and bandwidth are collected
  in bytes and non-billable: Upstash prices both per GB beyond a free tier, and a
  byte meter is priced by a GB rule with an explicit conversion, never by assumption.
- Pricing (`upstash-redis.commands-2026-09-01-v1`, reviewed 2026-09-03):
  `PER_1K_REQUESTS` at 2,000 micros ($0.2 per 100K commands) with 500K commands a
  month free (scope SKU). **Deviation from the issue text:** #384 and epic §41-P2
  say "10k commands/day, scope DAILY" — the pre-2024 Free tier. The pricing page
  fetched 2026-09-03 states 500K/month and publishes no daily figure (the cap behind
  "ERR max daily request limit exceeded" is unlisted), so the monthly allowance is
  what is recorded; a verified daily cap becomes a new rule version, not an edit.
  The meter is the day's request total, so the estimate is a ceiling on the
  billable count (operational commands such as PING and INFO are not charged).
- Registry: `upstash` is `active` with `USAGE_COLLECTOR` + `ESTIMATED_COST`;
  `upstash.redis` gains `bandwidth_bytes`. Credentials absent ⇒ `active` with
  `UNKNOWN` freshness, same as Cloudflare.
- First live run, watch: the freshness row `upstash_redis` for `NOT_FOUND` (wrong
  database id) or `AUTH_FAILED`; that `metadata.windowDays` ≥ 2 so yesterday is
  covered; and today's `bandwidth_bytes` against `metadata.seriesBandwidthBytes`.
- Tests: `upstash-developer-api.adapter.spec.ts` (documented example body, Go
  timestamps, error codes, env gate), `upstash.collector.spec.ts` (rows per day,
  window rule, definition), `cost-upstash.int.spec.ts` (replace-upsert, freshness,
  failure, estimator free tier in date order, Cost Center read-back).

## Neon Postgres collector (#385, epic §41-P2)

One `CollectorDefinition` built by `neonPostgresCollector(db, client, options)`
(`cost/application/neon.collector.ts`) and registered at worker boot **only
when** `neonApiFromEnv(process.env)` returns a client — i.e. both `NEON_API_KEY`
(SSM `neon/api-key`, INF-008 Infra#8) and `NEON_PROJECT_ID` (`neon/project-id`,
INF-060 Infra#114) are set. Absent, nothing registers, nothing errors, and the
provider row reads freshness `UNKNOWN` / cost `UNKNOWN`.

| Collector       | Service         | Source                                                                      | Meters written                                                                              |
| --------------- | --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `neon_postgres` | `neon.postgres` | `GET /consumption_history/projects` (daily) **and/or** `GET /projects/{id}` | `compute_hours`, `written_data_gb`, `data_transfer_gb`, `storage_bytes`, `storage_gb_month` |

- Settings (issue #385): every 6h, timeout 15s, one attempt per tick,
  `maxCallsPerDay` 8, `staleAfter` 24h, FREE (neither endpoint is charged or wakes
  a compute), non-essential. **Up to two GETs per run.**
- **Two sources, chosen by the plan.** The history endpoint (the issue's source,
  one entry per UTC day) answers only on Launch, Scale, Agent and Enterprise —
  `api-docs.neon.tech` fetched 2026-09-03 says 403 "not available" elsewhere, and
  `gogo-dev` is on **Free**. The adapter reports that 403 as `PLAN_NOT_SUPPORTED`
  and the collector falls back to the project endpoint, which every plan has and
  which carries the same counters as **period-to-date totals** (they reset at
  `consumption_period_start`) plus `data_transfer_bytes` — a field the history
  endpoint does not list — and the live `synthetic_storage_size`. The probe is
  once per UTC day: after a 403 the rest of the day's runs skip history, so Free
  costs one GET per run and an upgrade is noticed the next day.
- **History path** (`metadata.from = 'consumption_history'`, HIGH): yesterday
  and today are **replaced** on every run (`source = 'neon_api'`); a day the
  answer does not carry gets **no row** — absent is not zero. `compute_hours` is
  round(`compute_time_seconds` / 3600) — CPU-seconds are active seconds × compute
  size, so this is Neon's own CU-hour; `written_data_gb` is round(bytes / 1e9);
  `data_transfer_gb` is written from history only when a body carries the field.
- **Snapshot path** (`metadata.from = 'project'`, MEDIUM): today's row is the
  **difference between two measured counters** — this run's total and the total at
  the last run of an earlier day (the baseline) — `floor(now / unit) − floor(baseline
/ unit)`, so a month's rows telescope to the exact period total while each day
  rounds to a whole unit; the exact second/byte deltas ride in `metadata.exact`.
  Attribution across midnight drifts by at most one run interval, hence MEDIUM.
  The baseline is read back from the `data_transfer_gb` row (today's row carries
  the baseline the day started from in `metadata.baseline`; an earlier day's row
  carries its last totals in `metadata.cumulative`). No row on record → the
  baseline is this snapshot and today reads `0` from here on
  (`metadata.firstRun`) — the period's earlier usage was never observed daily
  and is not attributed. A new `consumption_period_start`, or a counter below
  its baseline, resets the baseline to zero (`metadata.periodRollover`). On the
  history path only `data_transfer_gb` takes this route
  (`metadata.historyStatus = 'not_listed'`); on Free all three counters do
  (`'PLAN_NOT_SUPPORTED'`).
- `storage_bytes` is the peak `synthetic_storage_size` seen on the day (the history
  entry's gauge, the live project figure, and today's row so far — a replace
  never loses an earlier peak); `storage_gb_month` is ceil(bytes / 1e9), decimal
  GB as R2, prorated by the estimator. A whole-GB row on a 0.5 GB cap reads `1`;
  the byte row is the exact figure.
- Billed: `compute_hours` (`postgres.compute`), `storage_gb_month`
  (`postgres.storage`), `data_transfer_gb` (`postgres.data_transfer`).
  `written_data_gb` is non-billable — Neon's page prices no written-data line.
- Pricing (`neon-postgres.{compute,storage,data_transfer}-2026-09-01-v1`,
  reviewed 2026-09-03, `neon.com/pricing`): the plan in force is **Free**, so
  all three are `FREE` with the caps on record as allowances — 100 CU-hours,
  0.5 GB-month, 5 GB transfer, per project per month (scope PROJECT). The
  usage-based list prices the issue asks to record are in each rule's
  `sourceReference` and become the v2 rules the day the plan changes: Launch
  $0.106/CU-hour (`PER_OPERATION`, 106,000 micros), $0.35/GB-month
  (`PER_GB_MONTH`, 350,000), $0.10/GB beyond 500 GB included (`PER_GB`,
  100,000); Scale compute $0.222/CU-hour. **Deviation from the issue text:**
  #385 lists `data_transfer_gb` among the history endpoint's outputs; the
  reference lists no such metric there, so transfer comes from the project
  endpoint. The `~191.9 compute-hours` figure in `check-quotas.sh` and the
  inventory is the pre-2025 Free tier; the page now says 100 CU-hours/project.
- Registry: `neon` is `active` with `USAGE_COLLECTOR` + `ESTIMATED_COST`;
  `neon.postgres` gains `written_data_gb` and `storage_bytes`. Credentials absent
  ⇒ `active` with `UNKNOWN` freshness, same as Cloudflare and Upstash.
- First live run, watch: the freshness row `neon_postgres` for `AUTH_FAILED`
  (key) or `NOT_FOUND` (project id — the console id, not the name); that today's
  rows say `metadata.historyStatus = 'PLAN_NOT_SUPPORTED'` and `firstRun` on
  Free; and, should the plan ever be usage-based, that history rows land for
  both yesterday and today (`to = now` is rounded by the API — the request
  window is not stored, so compare `metadata.timeframeStart/End`).
- Tests: `neon-api.adapter.spec.ts` (documented bodies, plan-gated 403, pagination,
  error codes, env gate), `neon.collector.spec.ts` (history rows, delta rows,
  baseline/rollover, probe-once-a-day), `cost-neon.int.spec.ts` (replace-upsert,
  baseline read-back across runs and days, period rollover, freshness, failure,
  Free-plan pricing, Cost Center read-back).

## AWS Cost Explorer + GitHub Actions collectors (#386, epic §41-P2, §20–§22, §26)

Two collectors, one paid and one free, registered at worker boot only when
their own credentials are present.

| Collector           | Capability              | Service                 | Source                                         | Writes                                       |
| ------------------- | ----------------------- | ----------------------- | ---------------------------------------------- | -------------------------------------------- |
| `aws_cost_explorer` | `ACTUAL_COST_COLLECTOR` | `aws.aggregate_billing` | `GetCostAndUsage`, daily, grouped by `SERVICE` | `provider_cost_daily` `basis = ACTUAL`       |
| `github_actions`    | `USAGE_COLLECTOR`       | `github.actions`        | billing usage report                           | `minutes` meter **and** an `ACTUAL` cost row |

### AWS — the first collector that costs money

`GetCostAndUsage` is **$0.01 per request** (epic §20). Everything about the
collector is shaped by that:

- `maxCallsPerDay: 1`, enforced by the scheduler against `cost_source_freshness`
  — a table, so the cap survives a worker restart, which an in-process counter
  would not. There is an integration test for exactly that.
- `frequencyMs` 24h, `monitoringCost.model = 'PER_REQUEST'`,
  `estimatedMonthlyMicros` 300,000 (~$0.30/month at ~30 calls). Under the epic's
  $1-per-collector approval line, inside the $1 DEV budget, and visible in the
  internal provider's "cost of tracking" row (`gogo.cost_observability`).
- `essential: false`, so the budget guard can pause it. The scheduler already
  refuses `essential` on anything that is not FREE, and there is a test for that.
- Credentials are a **dedicated key pair** (`AWS_COST_EXPLORER_ACCESS_KEY_ID` /
  `_SECRET_ACCESS_KEY`, IAM `ce:GetCostAndUsage` only). The ambient
  `AWS_ACCESS_KEY_ID` pair is deliberately not a fallback: inheriting whatever
  identity the worker runs under would make both the spend and the blast radius
  accidental.

**One call covers several days.** With `Granularity: DAILY` a single request
returns one entry per day, so each run re-reads the last `lookbackDays` (7)
days. That is not redundancy — Cost Explorer marks recent days
`Estimated: true` and restates them, and a day read once would keep a figure
AWS has since corrected. Re-reading costs nothing extra (the price is per
request) and rows are replaced, not added.

- `TimePeriod.End` is exclusive in the API; the port takes an inclusive `to`
  and converts. Amounts arrive as decimal **strings** and are converted to
  integer micros without going through a float.
- **Service mapping is by the registry, not by a literal** (epic §44.3):
  `awsServiceRoute` sends anything matching "systems manager"/"ssm" to
  `aws.ssm` and everything else to `aws.aggregate_billing`, keeping the AWS
  names in `metadata.awsServices`. Several AWS services merging into one
  registry service are summed, and a row that hid which ones it summed would be
  unauditable.
- Confidence follows AWS's own flag: a day AWS may still restate is MEDIUM, a
  settled day HIGH. The **basis stays ACTUAL** either way — it is the provider's
  figure, not ours. (Minor deviation: the issue says HIGH unconditionally.)
- After writing, the collector stamps `reconciled_at` on every ESTIMATED row
  that now has an ACTUAL twin for the same day and meter key
  (`ReconciliationService`, COST-BE-021, epic §26), for the months it wrote
  into. It records that an estimate has been checked against a bill; it computes
  no variance there.
- `aws` is `active` with `ACTUAL_COST_COLLECTOR` **only** — no usage meter is
  written and no pricing rule exists, because the money comes from the bill
  rather than from usage × price.

### GitHub — the issue's endpoint no longer exists

`GET /users/{owner}/settings/billing/actions` was **shut down on 2025-09-26**
when GitHub moved billing to the enhanced billing platform. The replacement is
`GET /{users|organizations}/{account}/settings/billing/usage`, which returns
line items instead of minute counters. It is strictly better here:

- every item carries its own `date`, so the day's minutes are a **measured
  daily figure** — the issue's "month-to-date counter differenced across runs"
  is unnecessary and would be less accurate;
- every item carries `netAmount`, GitHub's own money for the day, so the same
  call yields an `ACTUAL` cost row beside the usage meter.

- Yesterday and today are written each run, replace semantics, `source =
'github_api'`. One report covers both days except across a month boundary,
  where two are fetched.
- Only items whose `product` is `actions` count; other products are named in
  `metadata.otherProducts` and left to their own collectors. Minutes are summed
  across SKUs (Linux, Windows, macOS) because the meter is minutes, with the
  per-SKU split in `metadata.skus` — the OS decides the price, and one blended
  figure would hide that. An Actions line reported in another unit is recorded
  in `metadata.otherUnits`, never converted.
- Today is MEDIUM (the report is final only once the day is over), yesterday
  HIGH. A day the report does not mention gets **no row** — absent is not zero.
- The ACTUAL row carries `usageMetricId: 'minutes'`, the **same meter key the
  estimator writes**. Epic §12 groups precedence on (day, provider, service,
  operation, meter, sku); an ACTUAL row that left the key null would not shadow
  its own estimate and the Cost Center would add the two, doubling the spend.
  There is an integration test asserting `basis: ACTUAL` and a single amount.
- Pricing (`github-actions.minutes-2026-09-01-v1`, reviewed 2026-09-03):
  `PER_OPERATION` at 6,000 micros/minute with 2,000 minutes a month free (scope
  ACCOUNT). GoGo's five repositories are **private**, so their minutes are
  billed; public-repository minutes are free and never appear. **Deviation from
  the issue text:** #386 says "$0.008/phút Linux"; the page fetched 2026-09-03
  says Linux 2-core $0.006 (Windows $0.010, macOS $0.062) and publishes no
  $0.008 rate, so the page's figure is recorded. Priced at the Linux rate
  because CI runs on `ubuntu-latest`; should another OS become routine the
  honest fix is a per-SKU meter and a rule each, not an averaged price.
- `github` is `active` with `USAGE_COLLECTOR` + `ESTIMATED_COST` +
  `ACTUAL_COST_COLLECTOR` — all three from one endpoint.

### Watch on the first live run (both inert until Infra#114)

- `aws_cost_explorer` freshness row: `ACCESS_DENIED` (the IAM policy lacks
  `ce:GetCostAndUsage`, or Cost Explorer is not enabled on the account),
  `AUTH_FAILED` (key or clock skew — SigV4 signs the timestamp),
  `DATA_UNAVAILABLE` (the window predates the account's Cost Explorer data).
  Then check `calls_count` is 1 for the day and that `metadata.awsServices`
  names services you recognise.
- `github_actions` freshness row: `NOT_FOUND` is the interesting one — it is
  what both a wrong account login **and** an account outside the enhanced
  billing platform return; `FORBIDDEN` means the token lacks the billing
  permission. Then check `metadata.skus` for a non-Linux SKU, which would make
  the single-rate pricing rule an under-estimate.
- Tests: `aws-cost-explorer.adapter.spec.ts`, `github-billing.adapter.spec.ts`
  (documented bodies, SigV4 shape, error codes, env gates),
  `aws.collector.spec.ts`, `github.collector.spec.ts` (routing, merging, day
  rules, definitions), `cost-aws-github.int.spec.ts` (replace-upsert, the calls
  cap across a restart, reconciliation variance, estimator/ACTUAL precedence,
  the monitoring-cost row).

## Ids

- **Provider** `google`, `cloudflare`, … — epic §5 list, immutable once persisted.
- **Service** `<provider>.<service>` — `google.places`, `google.maps_sdk_ios`.
- **Operation** — the adapter's own `method` label, verbatim: `google.details.core`.
- **Usage meter** `<operation or service>/<metric>` — `google.routeMatrix/billable_elements`.
  The short `metric` (`calls`, `billable_elements`, `commands`) is what the canonical
  tables persist as `usage_metric_id`.
- **Billing SKU** — GoGo's stable key for the provider's SKU: `places.details.enterprise`,
  `routes.computeRouteMatrix`. The Routes id is also the metric label the adapter
  emits; do not rename it.
- **Cost source** — who wrote a `provider_cost_daily` row: `estimator`,
  `monitoring_cost_model`, `gcp_billing_export`…, and the family
  `manual_cost_items:<item uuid>` (`isManualCostSource`).

Operation, SKU and unit are three things (epic §4): one Routes call is one
`calls` request and N `billable_elements`; only the second is priced.

## Rules that tests enforce

- An unknown price is `unitPriceMicros: null`; `FREE` is a verified zero. Nothing turns
  `null` into 0 (`pricing-rules.spec.ts`, `provider-pricing.spec.ts`).
- A day is priced with the rule in force on that day; a price change is a new rule
  with a new `effectiveFrom` and `version`, and `PRICING_VERSION` equals the newest
  `effectiveFrom` (`provider-pricing.spec.ts` version guard).
- Every billable meter has a rule (`registry.spec.ts`); every operation an adapter
  emits has a rule and a service (`provider-pricing.spec.ts` label audit).
- Generic code asks `COST_REGISTRY.hasCapability(...)` / `providersWith(...)`; it never
  compares a provider id to a literal. Attribution of an unregistered label uses the
  service's declared `operationPrefixes` — data, not a switch.
- The free allowance is reporting only. The budget guard deducts none of it
  (ADR-0012).

## Adding a provider (epic §40)

1. Add the provider, its services, operations and meters to `COST_REGISTRY_DATA`
   (`domain/registry.ts`). Declare only capabilities that are implemented.
2. Add billing SKUs (display names) and `PricingRule`s in `domain/pricing-rules.ts`.
   Price unknown → `unitPriceMicros: null`, never 0.
3. Implement the port(s) the provider supports and register them on the
   `CostAdapterRegistry` at boot (collector scheduling arrives with #369).
4. Tests: registry invariants and the label audit already cover the data; add a spec
   for the adapter.

No migration, no CMS change, no budget-engine change. The `registry.spec.ts`
"adding a provider" case does exactly this with a fake provider.

## Compatibility note

`OPS_PROVIDERS` (`places | routes | sheets | maps_sdk`) is the CMS ops console's
legacy grouping and the OpenAPI enum on the #335/#315 surfaces. It is a presentation
mapping over registry services (`maps_sdk` merges the two SDK services) kept one
release for the deployed dashboard; the Cost API v2 (#381) uses registry ids and
`OPS_PROVIDERS` is no longer a source for it. It retires with COST-CMS-009.
