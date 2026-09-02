# Cost observability

Requirement: `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md` (COST-OBS-EPIC-001,
workspace). Tracker: GoGo-BE#370. This page says what exists in `libs/modules/cost`
and how to add a provider without touching generic code.

## Pieces

| Piece                                                                                                                          | File                                     | Epic §            |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------- |
| Definitions registry — providers, services, operations, usage meters, billing SKUs                                             | `domain/registry.ts`                     | §5, §4            |
| Capability model                                                                                                               | `domain/capabilities.ts`                 | §6                |
| Pricing rules — versioned, per SKU/meter, pricing models, free allowances                                                      | `domain/pricing-rules.ts`                | §13–§15           |
| Compatibility view (`PROVIDER_PRICING`, `providerOf`, `listCostMicros`…) used by the ops API, budget guard and baseline runner | `domain/provider-pricing.ts`             | —                 |
| Ports: `UsageCollector`, `ActualCostCollector`, `CostEstimator`, `QuotaCollector`, `FixedCostProvider`                         | `ports/collectors.port.ts`               | §7                |
| Adapter registry — what is wired in this process, checked against declared capabilities                                        | `ports/adapter-registry.ts`              | §7                |
| Usage ledger (metrics port → `provider_usage_daily`)                                                                           | `application/usage-ledger.ts`            | §10, §24          |
| Budget reservation guard (`provider_budget_daily`)                                                                             | `application/provider-budget.service.ts` | §32 (daily guard) |
| Estimated-cost report for the CMS ops surface                                                                                  | `application/usage-report.service.ts`    | §35 (partial)     |

Not yet built (see #370): freshness + collector scheduler + cost-of-cost (#369),
non-Google collectors, test-run tables, monthly budget/forecast, manual costs, ACTUAL
cost collectors and reconciliation, the ops API reading `provider_cost_daily`.

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
grouping and the OpenAPI enum. It is a presentation mapping over registry services
(`maps_sdk` merges the two SDK services) kept for contract stability; it retires when
the CMS cost API moves to registry ids (epic §34–§36, tracker #370).
