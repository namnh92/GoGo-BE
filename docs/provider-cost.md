# Provider cost: measuring it, and capping it

COST-BE-002 (#335). Source: `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` §2.2, §2.3.

## What existed before

One in-memory counter per process (`libs/observability/src/registry.ts`), reset
on every deploy, shipped to a Grafana Cloud free tier that keeps 14 days. Enough
to watch a graph. Not enough to answer "what did last month cost", and unable to
stop anything: the only backpressure on a runaway job was Google returning 429.

`/cms/ops/*` reported `costModel.kind = 'units_only'` with `estimatedCost: null`,
which was the honest answer while no price table existed.

## Two tables, because they are two different promises

|                                         | `provider_usage_daily`         | `provider_budget_daily`         |
| --------------------------------------- | ------------------------------ | ------------------------------- |
| Question                                | what did we spend              | what may we still spend         |
| Written                                 | after the call, on an interval | **before** the call, atomically |
| Wrong-in-the-optimistic-direction costs | a wrong graph                  | an unbudgeted invoice           |
| Free tier deducted                      | yes, in reporting              | **never**                       |

Merging them would impose one of those contracts on the other. The ledger is
allowed to lag; the budget is not allowed to be generous.

## The accounting boundary (§2.3) — decision

`ProviderMetrics.increment` is synchronous and sits on the hot path of every
Google call. Three options were on the table:

| Option                                 | Shape                                                                                              | Latency coupling                | Accounting safety                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------- |
| **A — buffer behind the metrics port** | `DbUsageLedger implements MetricsPort`, accumulate in memory, flush on an interval and on shutdown | none                            | loses ≤ one flush window on `SIGKILL` |
| B — await a write at each orchestrator | `UsageLedger.record()` awaited after each provider call                                            | one awaited round trip per call | exact                                 |
| C — async sink port on the adapter     | new `UsageSink`, fire-and-forget with a bounded queue                                              | none                            | near-exact                            |

**Chosen: A.** The reasoning is about what this data is _for_. Usage is
accounting and trend — it answers "what did last month cost", where a few
seconds of lag is irrelevant and a bounded gap after a hard kill is
reconcilable. The number that must never be optimistic is the _reservation_,
and that is a separate, awaited, atomic write that happens before the call.
Exactness is bought where it protects money, not where it protects a graph.

B was rejected for spreading the obligation across every current and future
call site with nothing enforcing it, and for putting a database round trip next
to every Google call. C was rejected for adding a port to `libs/providers`,
which deliberately depends on no `@gogo/*` package, to buy a guarantee A
already provides for this data.

Being a decorator on the metrics port rather than a second call site is what
makes every adapter accounted for without any adapter knowing, and what makes a
future adapter accounted for by construction rather than by someone remembering.

**The rule that outranks the choice:** nothing awaits a database write _before_
the provider call on a consumer path. A user waiting on a place lookup must not
also wait on our bookkeeping.

**The choice is provisional until measured.** §2.3 requires it to be settled by
measurement on DEV, and that has not happened — see the open merge gate at the
end of this document. Nothing here is filled with invented numbers.

### Reconciliation

A gap appears only on `SIGKILL`/OOM — a graceful stop flushes, in the API via
the Nest shutdown hook and in the worker before the pool closes. When one is
suspected, Grafana's `increase(places_provider_requests_total[…])` over the same
window is the reference, and the corrected figure is reported as
`basis: ESTIMATED`. The ledger never silently back-fills: a number that repaired
itself without saying so is worse than a visible gap.

## Pricing

`libs/modules/cost/domain/provider-pricing.ts`. Effective-dated rows in code,
not in a table: a price is a fact about the outside world on a date, reviewed
and rolled back with the deploy that introduced it. `PRICING_VERSION` travels in
every priced response so a figure in a screenshot can be traced to the table
that produced it.

Money is integer USD micros end to end, converted to minor units once at the
API boundary. `$17 / 1,000` is `17,000` micros per unit and divides exactly.

Three distinct states, and conflating any two of them is a bug:

- **a price** — `google.details.quality`, $20/1k
- **a measured zero** — Sheets is free, and says so with `0`
- **no price** — `google.maps_sdk_ios`, `usdPer1000Micros: null`

The Maps SDK rows exist precisely so a billed-but-uninstrumented surface reports
UNKNOWN instead of vanishing. Deleting the row would remove a real cost from the
report; pricing it `0` would claim it is free. Both are false; `null` is the
fact, and `unpricedOperations` in the response names it.

## The budget guard

`ProviderBudgetService.reserve()`. Three ceilings, checked together:

1. calls per day, per scope
2. units per day, per scope **and** operation
3. worst-case list cost per day, per scope

Reservation precedes the call and is **not refunded on failure**. That is
deliberate: refunding lets a broken retry loop spin forever inside its own
ceiling, which is the failure mode a hard budget exists to prevent.

### Why an advisory lock rather than the sketched `FOR UPDATE`

The plan sketches one statement aggregating the scope's rows `FOR UPDATE`.
Postgres rejects that outright — row locking cannot be combined with aggregation
(`0A000`, `CheckSelectLocking`). Locking rows in a CTE and aggregating over it
does parse, but it locks only rows that already exist, so the first two
reservations of a day contend on nothing and both pass the same empty read.
That is exactly the window a budget must not have.

`pg_advisory_xact_lock(hashtextextended(day|scope, 0))` has no such gap: it
exists whether or not a row does, is held to the end of the transaction, and is
keyed narrowly enough that two scopes never wait on each other. The integration
test fires twenty concurrent reservations at a ceiling of ten and asserts
exactly ten are granted.

### Free tier is never deducted here

Google pools free caps and volume discounts per billing account per SKU per
month, across every linked project. GoGo has no authoritative view of that pool.
A wrong "you still have free calls left" estimate must never be able to
authorise a paid call, so the guard prices everything as if nothing were free.
Free-cap arithmetic lives in reporting, where being optimistic costs nothing and
is labelled `ESTIMATED` / `MEDIUM`.

### Roles

```text
Postgres reservation      hard internal guard — the only thing that blocks
Google per-day quota      external safety net (INF-015), set below the ceiling
Cloud Billing budget      alert only; it notifies, it never blocks
Prometheus / Grafana      observability only
```

Redis and in-memory counters were rejected: a ceiling that resets on deploy, or
that each replica keeps its own copy of, is not a ceiling.

## Rollback

`COST_LEDGER_ENABLED=false` stops the writes; the ops API then reports units
with no amount, which is exactly the pre-#335 behaviour. Both tables are
additive and every new API field is optional, so nothing needs reverting to go
back — the flag is the rollback, not the migration.

## Merge gates

### 1. OPEN — DEV flush latency and freshness, not yet measured

The plan (§2.3) requires the accounting boundary to be chosen _by measurement on
DEV_, and that measurement has not been taken. It is **not waived and not
deferred silently**: #351 must not merge until the numbers below exist and are
recorded here.

What option A still has to prove, given it adds no awaited work to any request
path (so there is no per-call latency to measure):

1. **Flush duration under real traffic** — how long one `flush()` takes when the
   buffer holds a realistic spread of operations. Read from
   `provider_usage_ledger_flush_total{result="ok"}` rate against wall time, or
   time the call directly in a one-off script.
2. **Freshness lag** — how far behind the counters the table runs.
   `max(updated_at)` on `provider_usage_daily` versus `now()`, sampled while
   traffic is flowing. Should sit inside `COST_LEDGER_FLUSH_MS` plus write time.
3. **Whether 5 s is the right window.** Too long widens the `SIGKILL` gap; too
   short multiplies writes for no accuracy gain, since the table is per-day.

Procedure on DEV, with `COST_LEDGER_ENABLED=true`:

```sql
-- Freshness: how stale is the ledger right now?
select operation, updated_at, now() - updated_at as lag
  from provider_usage_daily
 where environment = 'dev' and day = (now() at time zone 'utc')::date
 order by updated_at desc;
```

```text
-- Agreement: the ledger against the counter it decorates, same window.
--   ledger:  sum(calls_attempted) for the day, from the query above
--   grafana: increase(places_provider_requests_total[24h])
-- #335's DEV verification asks these to agree within ±1.
```

Record the three numbers in this section and tick the gate. If DEV cannot be
reached before this PR is otherwise ready, the gate stays open and the PR stays
open with it — an unmeasured boundary is not a measured one.

### 2. Migration number, re-checked immediately before merge

The invariant is **uniqueness, not contiguity**. This branch carries `0035`
while `develop`'s highest is `0033`, because #349 holds `0034` in an open PR.
The gap is deliberate and harmless: drizzle applies journal entries in array
order and does not require them to be consecutive, and the integration suite
migrates a container from scratch through exactly this journal on every run —
so the gap is proven, not assumed.

Neither PR depends on the other's merge order. Whichever lands **second**
renumbers; if this one lands first, #349 is renumbered on its rebase rather than
this one being held back.

Re-run this immediately before merging, because another migration may have
landed in between:

```bash
git fetch origin
git ls-tree -r --name-only origin/develop -- migrations | grep '\.sql$' | tail -3
python3 -c "import json;j=json.load(open('migrations/meta/_journal.json'));i=[e['idx'] for e in j['entries']];print('dupes',[x for x in set(i) if i.count(x)>1]);print('ordered',i==sorted(i))"
```

If the number collides: rename the file, update its `_journal.json` tag, and
re-run `pnpm test:integration` — the migration is exercised for real there, so a
rename that breaks it fails loudly rather than at deploy.

> A duplicate journal `idx` has already happened once in this repo during
> parallel work on this program, and nothing catches it automatically. A CI
> guard belongs in its own change, not smuggled into this one.
