# ADR-0012 — Provider usage is accounted through a buffered ledger; the budget is a Postgres reservation

- **Status:** Accepted
- **Date:** 2026-09-02
- **Issues:** GoGo-BE#335 (COST-BE-002), GoGo-CMS#97
- **Source:** `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md`
  §0.2 C5–C7, §2.2, §2.3 — the plan requires this choice to be made explicitly,
  before the code, and written down
- **Relates to:** ADR-0004 (map/place provider), ADR-0006 (ingestion provider
  policy), #313/#318/#320/#321/#332 (the metric surface this builds on)

## Context

Before this change, every Google call was counted in an in-process registry
(`libs/observability/src/registry.ts`) that resets on deploy, mirrored into
Grafana Cloud Free, which keeps 14 days. Two questions had no answer:

- **"What did we spend this month?"** — a monthly free cap and a monthly
  invoice cannot be answered from a 14-day window or from a counter that
  restarts.
- **"May this job make another paid call?"** — nothing could refuse. Quota
  handling reacted to a 429 _after_ Google had already served (and billed)
  everything up to it.

The constraint that shapes the first answer is the metrics port itself:

```ts
// libs/providers/src/ports.ts
increment(name: string, labels?: …, by?: number): void;
```

`ProviderMetrics.increment` is **synchronous and returns `void`**. An adapter
cannot wait for something whose signature says it has already finished, so
there is no honest way to make a database write an awaited part of that call.
The choice is not whether to decouple; it is where the decoupling is admitted
and what it is allowed to lose.

## Options considered

|                                                            | Shape                                                                                                                            | Accounting safety                                                               | Latency coupling              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| **A. Buffered ledger behind the metrics port**             | `DbUsageLedger implements MetricsPort`; accumulate per `(day, operation)`, flush on an interval and on shutdown                  | Loses ≤ one flush window to SIGKILL; nothing to SIGTERM; a failed flush retries | None                          |
| **B. Awaited `UsageLedger.record()` at each orchestrator** | Explicit call after the provider call in `PlaceResolverService`, `PlaceImportJobService`, `TravelTimeService`, `AreasController` | Exact                                                                           | One DB upsert per Google call |
| **C. Async sink port on the adapter**                      | New optional `UsageSink` with a bounded queue and retry                                                                          | Near-exact                                                                      | None                          |

## Decision

**Option A for accounting. A separate Postgres reservation for the budget.**

### Accounting: the ledger is a third metrics sink

`DbUsageLedger` is teed onto the existing `TeeMetrics([LogMetrics, registry])`
in both `apps/api` and `apps/worker`. It reads two metrics and ignores the
rest:

- `places_provider_requests_total{method,status}` → `calls_attempted`, and
  `calls_succeeded` when the status is 2xx;
- `places_provider_cost_units{sku}` → `billable_units`, **respecting `by`**,
  because Routes increments by matrix elements and not by one.

Three things make this accounting rather than fire-and-forget, and all three
are tested:

1. **A failed flush is visible and lossless.** The counts go back into the
   buffer and `provider_usage_ledger_flush_total{outcome="error"}` rises. The
   next flush carries them.
2. **The loss window is bounded and named.** SIGKILL loses at most
   `COST_LEDGER_FLUSH_MS` (5s). SIGTERM loses nothing — the API flushes in
   `onApplicationShutdown`, the worker in its `shutdown`.
3. **It is not the safety mechanism.** Nothing decides whether to spend money
   by reading this table.

Option B was rejected: exactness is not worth a database round trip in the
critical path of every Google call, and an explicit call at each orchestrator
has to be remembered at every future call site. Teeing off the metric stream
is complete by construction — a new adapter is accounted the day it emits its
first counter. Option C adds a port and a queue to buy a fraction of a flush
window.

**Rejected outright, and never to be reintroduced:** any design that awaits a
database write _before_ the provider call on a consumer path.

#### Why "buffered" is acceptable here, in one sentence

Accounting that is five seconds behind is a reporting inaccuracy; a budget
that is five seconds behind is an invoice.

#### Reconciliation

A gap after an ungraceful stop is closed from Grafana:
`sum by (method) (increase(places_provider_requests_total{env="…"}[…]))` over
the same day, and the corrected figure is reported as `basis: ESTIMATED`. The
ledger is never edited to match a guess; the discrepancy is recorded.

#### Measurement

The latency question Option A exists to avoid does not arise for it: the write
is not on the provider call path at all, and `increment` remains a map update.
What was measured is the flush itself — one multi-row upsert per interval per
process, one row per `(day, operation)` touched, which is at most a dozen rows.
**A DEV run against live Google has not been performed in this change** (no
Google credentials are bound in this environment); the plan's §2.3 asks for one
before the boundary is considered validated, and it is listed as follow-up on
#335 rather than reported as done.

### Budget: an atomic Postgres reservation, not a counter

`provider_budget_daily` is a separate table from `provider_usage_daily`,
because they have different failure modes: usage says what happened, budget
says what is allowed. Reserving happens **before** the call, inside one
transaction, and is **never refunded** — a failed call still burned Google
quota and may still have been billed.

Three ceilings, per scope, all checked together:

1. absolute **calls/day**, which holds even if the price list is wrong;
2. **units per operation**, so one expensive tier cannot eat the allowance;
3. worst-case **list-price cost**, because "1,000 calls" is $0 of IDs-Only
   liveness or $20 of Enterprise Details and a calls-only ceiling cannot tell
   those apart.

Two rules keep it conservative:

- **No free-tier or volume-discount deduction in the guard.** Google
  aggregates free caps per billing account per SKU per month across every
  linked project; GoGo cannot see that. A wrong "we still have free tier"
  estimate must never authorise a paid call. Free-cap arithmetic belongs to
  reporting.
- **An unknown price refuses** (`price_unknown`). A ceiling in dollars cannot
  bound a price nobody has verified.

And **default deny**: a scope with no configured ceiling reserves nothing. An
unset environment variable is the most likely way this guard goes missing in
production, and a guard that defaults open is not a guard.

#### Why a transaction-scoped advisory lock, not `FOR UPDATE`

The plan's §2.2 sketch used `SELECT … FOR UPDATE` inside the aggregate CTE.
That cannot work, for two independent reasons: Postgres refuses `FOR UPDATE`
in a query containing aggregates, and — more importantly — row locks are blind
to the row a concurrent reserver is about to _insert_, which is exactly the
phantom the ceiling has to exclude. `pg_advisory_xact_lock` on `(day, scope)`
serialises reservations for that scope and releases on commit, rollback, crash
or disconnect.

#### Roles, unchanged

| Postgres reservation | hard internal guard |
| Google per-day quota (INF-015) | external safety net, set slightly above |
| Cloud Billing budget | alert only |
| Prometheus / Grafana | observability only |
| Redis / in-memory | rejected |

## Consequences

- `/cms/ops/summary|providers|providers/:provider` report `costModel.kind =
'estimated'` with `basis: ESTIMATED`, `confidence: MEDIUM`, a
  `pricingVersion`, and `freeCapApplied: false` — the window is 1h–30d and a
  free cap is monthly.
- `/cms/ops/costs` reports today and month-to-date from the ledger, with the
  free cap consumed in date order per SKU. It no longer returns an empty list:
  with the ledger on, a zero is a measured zero.
- **Unknown never becomes zero.** An operation with no verified price is
  excluded from the money and named in `gaps` as `price_unknown` (Routes, per
  matrix element). An operation nothing measures is named as
  `not_instrumented` (`google.maps_sdk_ios`, `google.maps_sdk_android` — the
  SDK renders on the handset). `maps_sdk` is a listed provider precisely so
  the console can say "chưa đo" against a name.
- The pricing registry is the audit of operation labels, kept true by a test
  that scans the adapters: every operation an adapter emits must have a row.
- `google.expand` is instrumented for the first time. It is free — an
  unauthenticated HEAD to a URL shortener — but free and unmeasured are
  different facts, and the PR3 baseline counts it.
- PR7's refresh job is the first caller of the reservation. It exists now,
  unwired, because PR3's baseline and PR7's job both need it to already be
  correct.

## Migration & rollback

- Migration `0035_provider-cost-accounting.sql` adds two tables. Additive:
  nothing else reads or writes them.
- API fields are additive; the CMS tolerates their absence.
- `COST_LEDGER_ENABLED=false` stops every write and returns
  `/cms/ops/costs` to `sourcesConfigured: false` with an empty list, which is
  exactly its behaviour before this change.
- Rolling back is dropping the two tables; no other table references them.

## Amendment (#336, PR3) — `flush()` is not a drain

The BEFORE baseline (#336) found a real loss window that this ADR's "SIGTERM
loses nothing" claim did not survive.

`flush()` returns the flush **already in flight** when there is one, and
`flushOnce` clears the buffer _before_ it awaits the write. So a count that
arrives while a write is in flight lands in a fresh buffer that the joined
promise knows nothing about — and `stop()` awaited exactly that promise. On
SIGTERM those counts were dropped silently.

It surfaced as a measurement artefact before it surfaced as a bug: a
scenario's provider calls kept landing in the _next_ scenario's ledger window
while the in-process metric registry showed them in the right one. That
disagreement is only visible because the baseline reports the ledger and the
scrape side by side instead of reconciling them into one number.

`DbUsageLedger.drain(maxPasses = 5)` flushes until the buffer is empty;
`stop()` calls it. Bounded rather than `while`, because a database refusing
every write must not turn a shutdown into a spin — the last error propagates,
exactly as `flush()` already did. Tested in `usage-ledger.spec.ts`
("writes counts that arrive while a flush is already in flight").

The SIGKILL window is unchanged: at most one `COST_LEDGER_FLUSH_MS` interval.

## POST-MERGE VALIDATION REQUIRED — DEV flush measurement

**Status: still not passed** (unchanged by #336 — that PR measured call shape
with a pinned transport and no Google credentials, which is precisely what
this section says is _not_ a substitute for a DEV measurement). Plan §2.3 requires the accounting boundary to be
settled _by measurement on DEV_, and that measurement has not been taken —
no Google credentials are bound in the environment this was built in. The
decision above is therefore **provisional**, and this section stays open until
the numbers exist. It is recorded as a required validation rather than a
follow-up wish so that "we never measured it" cannot quietly become "we
decided it was fine".

Option A puts no awaited work on any request path, so there is no per-call
latency to measure. What is unmeasured is the ledger's own behaviour:

1. **Flush duration** with a realistic spread of operations in the buffer.
2. **Freshness lag** — how far behind the counters the table runs.
3. **Whether `COST_LEDGER_FLUSH_MS=5000` is right.** Longer widens the
   `SIGKILL` loss window; shorter multiplies writes for no accuracy gain,
   since the table is keyed per day.

Run on DEV with `COST_LEDGER_ENABLED=true` and real traffic flowing:

```sql
-- Freshness: how stale is the ledger right now?
select operation, updated_at, now() - updated_at as lag
  from provider_usage_daily
 where environment = 'dev' and day = (now() at time zone 'utc')::date
 order by updated_at desc;
```

```sql
-- Today's ledger totals, for the agreement check below.
select operation, calls_attempted, calls_succeeded, billable_units
  from provider_usage_daily
 where environment = 'dev' and day = (now() at time zone 'utc')::date
 order by operation;
```

Compare `calls_attempted` against Grafana
`increase(places_provider_requests_total{env="dev"}[24h])` over the same
window. #335's DEV verification asks these to agree within ±1; a wider gap
means either a lost flush window or a counted-but-unwritten path, and both are
findable from `provider_usage_ledger_flush_total{outcome="error"}`.

Record the three numbers and the agreement result here, then mark this section
passed. Until then, treat the `estimatedCost` figures as measured units priced
by an unvalidated write path.

## Migration numbering — re-check immediately before merge

The invariant is **uniqueness, not contiguity**. Drizzle applies journal
entries in array order and does not require consecutive `idx` values, and the
integration suite migrates a container from scratch through this journal on
every run — so a gap is proven harmless rather than assumed.

Parallel work on this program has already produced a duplicate journal `idx`
once, and nothing catches it automatically. Re-run this immediately before
merging, because another migration can land in between:

```bash
git fetch origin
git ls-tree -r --name-only origin/develop -- migrations | grep '\.sql$' | tail -3
python3 -c "import json;j=json.load(open('migrations/meta/_journal.json'));i=[e['idx'] for e in j['entries']];print('dupes',[x for x in set(i) if i.count(x)>1]);print('ordered',i==sorted(i))"
```

On a collision: rename the file, update its `_journal.json` tag, and re-run
`pnpm test:integration` — the migration is exercised for real there, so a bad
rename fails loudly instead of at deploy. A CI guard for this belongs in its
own change.
