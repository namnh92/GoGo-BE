# ADR-0007: Travel time — Routes API, batched-greedy access, no live traffic at MVP

- **Status:** accepted (2026-08-28) — batched greedy, Essentials tier, live traffic off at MVP
- **Date:** 2026-08-27
- **Deciders:** BE + product
- **Extends** ADR-0004 (maps/place provider), ADR-0006 (provider policy)

## Context

The itinerary optimizer estimates travel with **straight-line distance**
(`haversineMeters`). Nothing in the repo calls a routing API.

In Ho Chi Minh City at rush hour, 2 km straight-line is routinely 25 minutes of
riding. So the plans GoGo produces are **wrong in one direction, systematically**:
every arrival time is optimistic, and the error compounds across stops. A plan
that says "18:00 quán A → 19:30 quán B" quietly means "you will be late to both".
This is a product-quality defect, not an optimisation.

Fixing it means paying per request, so the decision is a budget one and needs an
ADR (core rule #11) rather than a ticket.

### What the code actually asks for

Measured, not assumed:

- `maxStops = max(1, min(4, floor(window/120) + 1))` → **at most 4 stops**.
- Selection is **greedy with early exit**: each round scans the ranked pool and
  takes the first candidate that fits the time and budget constraints. Typical
  runs touch 4–8 origin/destination pairs; the worst case, with a pool of 10, is
  `10 + 9 + 8 + 7 = 34`.
- `plans.regenerate` is rate-limited to **6/min per actor**, so one determined
  host is the realistic upper bound on burst.

### How the provider bills

Compute Route Matrix is billed **per element** (`origins × destinations`).
Essentials has a free cap of 10.000 elements/month before the first paid tier;
Pro has 5.000 and a higher first tier, and **`TRAFFIC_AWARE` /
`TRAFFIC_AWARE_OPTIMAL` moves the request into Pro**.
Sources: [Routes API usage and billing][1], [managing Maps Platform costs][2].
Prices change — treat the numbers below as the shape of the decision, and
re-check the tables before committing budget.

[1]: https://developers.google.com/maps/documentation/routes/usage-and-billing
[2]: https://developers.google.com/maps/billing-and-pricing/manage-costs

## Options considered

The greedy loop and the pricing model have **different shapes**: the optimizer
asks one leg at a time and stops early, while the matrix API charges for a
rectangle. That mismatch, not the adapter, is the real work.

| #   | Access pattern               | Elements / plan | Calls | Free-tier plan builds/month |
| --- | ---------------------------- | --------------- | ----- | --------------------------- |
| 1   | Full matrix upfront (11×11)  | 121             | 1     | ~82                         |
| 2   | One call per leg, sequential | 4–34            | 4–34  | ~294 (worst case)           |
| 3   | **Batched greedy**, pool 10  | 34              | 4     | ~294                        |
| 4   | **Batched greedy**, pool 5   | **14**          | **4** | **~714**                    |

1. **Full matrix** — one round trip, lowest latency, but pays for ~113 pairs it
   never uses. Worst cost, best latency.
2. **Per leg** — pays only for what it uses and keeps the early exit, but 34
   sequential round trips add seconds to a user-visible action.
   3/4. **Batched greedy** — one call per greedy step, origin = the stop just
   chosen, destinations = the remaining pool. Same worst-case element count as
   per-leg, but **4 network calls instead of 34**.

The trade-off inside batched greedy is that **it gives up the early exit**: step
one pays for the whole pool even though the loop often takes the first
candidate. Halving the pool halves that waste, which is why option 4 buys 2.4×
the free-tier headroom of option 3.

## Decision

**Batched greedy, pool of 5, Essentials tier, live traffic off.**

- **Batched greedy** because latency and cost both matter and it is the only
  option that is not worst-in-class at one of them.
- **Pool 5** because ~714 free plan builds/month is a real runway for early
  usage while 294 is not, and the ranking already surfaces the best candidates
  first — positions 6–10 rarely win a greedy pick.
- **Essentials, no `TRAFFIC_AWARE`** at MVP. Road travel time alone already
  fixes most of the error versus straight-line. Traffic-aware costs more _and_
  moves the whole request into Pro with a smaller free cap, so it waits until
  real usage data says the extra accuracy is worth it.
- Behind the existing provider-port pattern: `TravelTimePort`, one adapter, a
  fake for CI, and a feature flag that reverts to haversine.

### Caching

GoGo's geometry is unusually cache-friendly and the design should exploit it:

- **Place → place legs** are pairs of fixed catalog points. The catalog is small,
  popular places recur across rooms, and the pair is identical for every user.
  Cache these **durably in Postgres**, keyed `(from_place, to_place, mode,
time_bucket)`. Reuse should be high and grows with usage.
- **Origin → first place** starts from a user-supplied point and is not reusable
  across rooms. Cache in **Redis with a short TTL**, keyed by rounded
  coordinates, which still absorbs the 6-regenerates-per-minute case.

Time bucket: 1 hour at MVP. Finer buckets only matter once traffic-aware is on.

### Fallback and kill switch

Quota exhausted, provider down, or the flag off → fall back to the haversine
estimate, and **mark the result as an estimate**. A number presented as a real
travel time when it is a straight-line guess is exactly what core rule #8
forbids. The fallback path is the current behaviour, so it is already exercised.

### Budget guardrails

- A **Google Cloud Billing budget alert** is mandatory, not optional, and not a
  substitute for our own metric — ours can only see what we send, not what we
  are charged.
- `places_provider_cost_units{sku}` already exists; add the Routes SKU to it.
- Alert on elements/day crossing the monthly free cap pro-rata.

## Consequences

- Plans stop being systematically optimistic; arrival times become defensible.
- The optimizer gains an async, batched dependency where it had a pure function.
  Its unit tests must keep running against the fake, and the deterministic
  fallback keeps the suggestion pipeline testable without a provider.
- A new cost line that scales with plan generation — the first provider cost
  driven by _user activity_ rather than by catalog size. Cache hit rate becomes
  a number worth watching.
- Cache invalidation is mild: a place moving changes its coordinates, which
  changes the key; stale rows age out by time bucket.

**Correction 2026-09-02 (#339).** The sentence above was wrong, and the code
matched the ADR rather than the intent. `travel_legs` is keyed by
`(from_place_id, to_place_id, mode, time_bucket)` — place **ids**, not
coordinates — so a place moving changed nothing about the key and evicted
nothing. Nor do rows "age out": `time_bucket` is a partition, not a TTL, and
`fetched_at` was written but never read. The only delete in the codebase was
`mergePlaces`, and that fires because a place is disappearing, not because it
moved.

The consequence was a cached duration measured to a coordinate the place no
longer occupies, served indefinitely under its id, with the plans built on it
showing arrival times nobody could reproduce.

Invalidation is now explicit: a `geom` write that moves a place more than
`MATERIAL_MOVE_METERS` (50 m) deletes every leg in both directions and marks
live plans containing that place stale
(`libs/modules/shared/place-relocation.ts`). Fifty metres because editors nudge
pins by tens of metres routinely and recomputing a Routes matrix for a marker
moved into a courtyard is spend with no change in the answer. Time-based
expiry remains unimplemented and remains a real gap — this correction addresses
relocation only.

## Migration & rollback

1. Land the port + fake + Postgres cache table with the flag **off**. No
   behaviour change, no spend.
2. Enable in staging, compare estimated vs routed times on a fixed set of plans,
   and record the delta — this is also the evidence for whether traffic-aware is
   worth revisiting.
3. Enable in production behind the flag, watch elements/day for a week.
4. Rollback is the flag: the haversine path stays in the code permanently
   because it is also the quota/outage fallback.

**Not decided here:** whether to revisit `TRAFFIC_AWARE` after real usage. That
needs the staging delta from step 2 and a cost baseline, and should be its own
short amendment rather than a guess now.
