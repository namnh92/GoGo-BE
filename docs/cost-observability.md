# Cost observability

Requirement: `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md` (COST-OBS-EPIC-001,
workspace). Tracker: GoGo-BE#370. Provider inventory (Phase 0 audit): `docs/cost-inventory.md`. This page says what exists in `libs/modules/cost`
and how to add a provider without touching generic code.

## Pieces

| Piece                                                                                                                                                                                                                                                                                               | File                                                                                                            | Epic §                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Definitions registry — providers, services, operations, usage meters, billing SKUs                                                                                                                                                                                                                  | `domain/registry.ts`                                                                                            | §5, §4                 |
| Capability model                                                                                                                                                                                                                                                                                    | `domain/capabilities.ts`                                                                                        | §6                     |
| Pricing rules — versioned, per SKU/meter, pricing models, free allowances                                                                                                                                                                                                                           | `domain/pricing-rules.ts`                                                                                       | §13–§15                |
| Compatibility view (`PROVIDER_PRICING`, `providerOf`, `listCostMicros`…) used by the ops API, budget guard and baseline runner                                                                                                                                                                      | `domain/provider-pricing.ts`                                                                                    | —                      |
| Ports: `UsageCollector`, `ActualCostCollector`, `CostEstimator`, `QuotaCollector`, `FixedCostProvider`                                                                                                                                                                                              | `ports/collectors.port.ts`                                                                                      | §7                     |
| Adapter registry — what is wired in this process, checked against declared capabilities                                                                                                                                                                                                             | `ports/adapter-registry.ts`                                                                                     | §7                     |
| Usage ledger (metrics port → `provider_usage_daily` **and** `provider_usage_meter_daily`, one transaction)                                                                                                                                                                                          | `application/usage-ledger.ts`                                                                                   | §10, §24               |
| Budget reservation guard (`provider_budget_daily`)                                                                                                                                                                                                                                                  | `application/provider-budget.service.ts`                                                                        | §32 (daily guard)      |
| Estimated-cost report for the CMS ops surface                                                                                                                                                                                                                                                       | `application/usage-report.service.ts`                                                                           | §35 (partial)          |
| Generic estimator (meter rows × pricing rules → `provider_cost_daily` ESTIMATED; idempotent, bounded, never touches ACTUAL)                                                                                                                                                                         | `application/cost-estimator.service.ts`; worker job `gogo:worker:cost-estimate`                                 | §7, §11, §13, §15, §25 |
| Freshness model (`FRESH/STALE/UNAVAILABLE/UNKNOWN`, derived from facts against `now`; bounded backoff)                                                                                                                                                                                              | `domain/freshness.ts`; table `cost_source_freshness` (0039)                                                     | §23, §22               |
| Collector definitions — frequency, timeout, retry, `maxCallsPerDay`, environments, **declared monitoring cost**                                                                                                                                                                                     | `domain/collector.ts`                                                                                           | §19, §20               |
| Collector scheduler — due check, timeout, isolation per collector, freshness upsert, monitoring-budget pause, cost-of-cost row under `gogo.cost_observability`                                                                                                                                      | `application/collector-scheduler.service.ts`; worker job `gogo:worker:cost-collectors`                          | §19–§22, §38           |
| First collector: `ledger` (FREE, essential) — reports the ledger's freshness, `sourceAsOf` = newest ledger write                                                                                                                                                                                    | `application/ledger-freshness.collector.ts`                                                                     | §23                    |
| Test-run cost records — `cost_test_runs` + `cost_test_run_deltas` (0040), `TestCostService.start/finish/fail`, soft budgets, service scoping; baseline runner writes a row beside its frozen JSON                                                                                                   | `application/test-cost.service.ts`; `scripts/cost-baseline/runner.ts` `testCost` hook                           | §28–§30, §43, §44.17   |
| Monthly budgets + forecast — `cost_budgets` (0041), `spend()` precedence ACTUAL > ESTIMATED (never summed; FIXED/MANUAL separate), `forecastMonthMicros` = MTD average × days (null < 3 days), `BudgetService.overview`                                                                             | `domain/budget.ts`, `application/budget.service.ts`                                                             | §12, §32, §33          |
| Backfill from Prometheus (`increase()` per UTC day → `provider_usage_meter_daily` source `prometheus_backfill`, LOW, floored; ≤ 62 days; idempotent; audited `cost.backfill`) + reconciliation (estimated vs actual per service, variance null without an actual; `reconciled_at` on matched pairs) | `application/prometheus-backfill.service.ts`, `application/reconciliation.service.ts`; CLI `pnpm cost:backfill` | §10, §25, §26          |
| Manual / fixed costs — `manual_cost_items` (0042), CMS CRUD with audit `cost.manual_item.*`, materialised into `provider_cost_daily` as MANUAL rows (one per covered day ≤ today, source `manual_cost_items:<id>`); `MANUAL_COST` capability decides which services may carry one                   | `domain/manual-cost.ts`, `application/manual-cost.service.ts`; worker job `gogo:worker:cost-collectors` (daily) | §27, §44.18            |

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
costs counted once each. `forecastMonthMicros` = MTD ÷ elapsed days × days in
month, `null` (never 0) under three elapsed days or with no rows. `costBudgetStatus`
states: `ok` / `warning` (≥ 80 %) / `projected_exceed` / `exceeded`.
`BudgetService.overview(month)` returns spend, forecast, every budget's status and
a per-service split; the Cost API v2 (#381) reads it into `cards.projected` and
`cards.budget`.

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

Deprecated, kept one release: the legacy `providers[]` / `gaps[]` on `/cms/ops/costs`
and `/cms/ops/providers/{provider}` (enum `places|routes|sheets`). CMS re-vendor is
COST-CMS-009 (CMS#105).

## Manual costs (migration 0042, #382, epic §27)

`manual_cost_items` is the record an operator edits: a fee under a registry
provider + service, `amountMicros` of `currency` **per period** (`ONE_TIME |
MONTHLY | YEARLY`), an inclusive `effectiveFrom`/`effectiveTo` (null = open-ended),
a note. `environment` mirrors `cost_budgets`. Nothing reports spend from this table:
`ManualCostService.materialise()` rebuilds the item's rows in `provider_cost_daily`
— `basis = MANUAL`, `confidence = HIGH`, `source = manual_cost_items:<id>` (one
source per item, because two domains under `registrar.domain` are two costs and the
table's key has no other column to tell them apart), `metadata` naming the item —
one row per covered day, **never past today** (a month-to-date that already held
the rest of the month would not be month-to-date). MONTHLY spreads the fee over the
days of each month it covers, YEARLY over each year, ONE_TIME lands whole on
`effectiveFrom`; rounding drift is at most half a micro per day. Rows an item no
longer covers (moved service, shortened range, deleted item) are deleted in the same
pass, so the operation is idempotent and `updated_at` moves only when an amount,
currency or metadata actually changed.

When it runs: after every CMS write (the response already reflects the change), and
once per UTC day in `gogo:worker:cost-collectors` so today's share appears by itself
— free, so it ignores `COST_COLLECTORS_ENABLED`. Every reader then sees a
subscription the way it sees an invoice: `spend()` counts MANUAL once beside
ACTUAL/ESTIMATED, budgets and the forecast include it, the Cost API reports it as
`manualMicros` / `basis: MANUAL`. Per-test deltas are usage deltas and never include
it (epic §27, "excluded by default").

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
