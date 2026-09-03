# ADR-0013: Observability topology, and how Grafana is modelled in the Cost Center

- **Status:** accepted
- **Date:** 2026-09-03
- **Deciders:** product owner + BE + platform
- **Relates to** GoGo-BE#389 (COST-BE-030, gap G-22), GoGo-BE#401, GoGo-BE#370,
  ADR-0012 (durable provider usage accounting), GoGo-Infra INF-053/INF-054
- **Requirement authority:** `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md`
  (COST-OBS-EPIC-001) §3, §20–§22, §24, §41-P6, §44.6, §44.15

## Context

GoGo-BE#389 asks for a **Grafana Cloud usage collector**: read
`grafana.metrics` → `active_series` and ledger it against the hosted free
tier's 10,000-series allowance. It is sequenced first among the P1 providers
_because the credential already exists_ — `observability/grafana-read-token`
was provisioned by INF-054, and `scripts/ops/check-quotas.sh` already probes
the series count with it.

That reasoning is sound only while Grafana is Grafana Cloud. It may not stay
that way: **Grafana may move self-hosted onto the BE VPS.**

What exists today, so the decision is made against facts rather than plans:

- **DEV runs Grafana Cloud Free**, decided 2026-09-01 (INF-054). One stateless
  Alloy container on the existing host scrapes both GoGo-BE processes and
  remote-writes; 10,000 active series, 14 days of retention. Staging and prod
  were never bootstrapped, and prod would need Grafana Cloud Pro — which the
  manifest itself calls out as "a cost decision and not this one".
- **The read path is already vendor-neutral.**
  `libs/providers/src/prometheus-query.adapter.ts` is a plain Prometheus HTTP
  API client, not a Grafana client: "Grafana Cloud's Mimir speaks the
  Prometheus HTTP API […] the CMS never learns which vendor holds the samples,
  and swapping one for another is a binding change." `GRAFANA_PROM_URL` is
  config in SSM.
- **The registry already carries `grafana` as `planned`** with a
  `grafana.metrics` service and an `active_series` meter — declared, with no
  collector and no pricing rule behind it.
- **`hosting.vps` already exists** as a `manual` provider service, and
  `gogo.cost_observability` already exists as the internal `FIXED_COST`
  service that the collector scheduler writes the cost-of-cost row into (#369).

So the question is not "can we collect Grafana usage". It is **what a Grafana
number would mean**, and that answer changes completely with the topology. A
decision is needed now because #389 is the next P1 item in the queue and would
otherwise be implemented against a premise that may already be dead.

## The distinction this ADR turns on

An **external provider billing source** is a third party that meters our usage
and bills or rate-limits us for it. Its usage is worth a collector because the
number has a price or a cliff attached: exceeding it costs money or stops
service. Google Places requests, Cloudflare R2 bytes, Upstash commands, Neon
compute-hours, GitHub Actions minutes — all of these.

**Internal observability infrastructure** is software we run on hardware we
already pay for. Its "usage" has no price and no cliff. A self-hosted
Prometheus holding 40,000 series does not bill anyone for the extra 30,000; it
uses more of a VPS whose cost is a flat monthly subscription that does not move
when the series count does.

Metering the second as if it were the first produces a number that _looks_
measured, sits on the cost screen next to real money, and is not money at all.
Epic §44.6 (`unknown != zero`) and §44.15 (paid-collector cost budgeted and
measurable) both exist to stop exactly that class of error, and §24 already
says the plainest version of it: **Grafana is a telemetry source, not cost
history.**

## Options considered

1. **Build the Grafana Cloud collector now, as #389 is written.** Cheapest
   path while Cloud stays. But if Grafana moves, the collector reads an
   endpoint that no longer exists, or — worse — succeeds against a self-hosted
   Prometheus and reports a series count as though it were billable usage. A
   collector that silently reports a measured zero is the failure mode
   `check-quotas.sh` was written to avoid, reproduced inside the Cost Center.
2. **Delete `grafana` from the registry and treat observability as invisible.**
   Wrong in the other direction. Observability does cost something — a share of
   the VPS, or a Cloud Pro subscription — and a cost board that omits a line is
   read as that line costing nothing.
3. **Decide the cost _modelling_ now for both topologies, and defer the
   _storage backend_ choice with named triggers.** The modelling question is
   answerable today and unblocks the queue; the storage question is not
   urgent, has no forcing function, and would be answered badly under time
   pressure.

## Decision

**Option 3.**

### D1 — No Grafana Cloud active-series collector is part of MVP

`grafana.metrics` / `active_series` gets **no `UsageCollector`** and no pricing
rule. GoGo-BE#389's Grafana half is withdrawn from the MVP scope. The other
three P1 providers in that issue (OneSignal, Tenjin, Sentry) are unaffected —
they were already waiting on credentials, and none of them depends on where
Grafana runs.

This holds _regardless_ of which topology wins. Under Cloud, a free-tier series
count is a quota probe, and `scripts/ops/check-quotas.sh` already performs it
without a ledger; a ledgered daily series count would add a row that prices at
$0 forever until the day the plan changes, at which point the price — not the
usage — is the fact that moved. Under self-hosted it is not a billing number at
all (D2).

### D2 — Self-hosted Grafana is internal observability infrastructure, not an external provider

If Grafana runs on the BE VPS, it is **not** an external provider billing
source and must never be modelled as one. It has no external meter, no external
allowance, and no external invoice.

Its cost is recorded in exactly one of two places, both of which already exist:

| Cost                                     | Where it goes                                                                                                                                                          | Why                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The VPS the stack runs on                | **`hosting.vps`** — `manual` provider, MANUAL/FIXED rows via the manual-cost items API (#382, epic §27)                                                                | Epic §3 "Manual / fixed-cost only". The subscription is flat; it does not move with series count, scrape interval, or dashboard traffic                  |
| Running the Cost Center's own collectors | **`gogo.cost_observability`** — internal `FIXED_COST` service, written by the collector scheduler from each collector's declared `monitoringCost` (#369, epic §20–§22) | This is the cost of _tracking_ cost, which the epic already models as a first-class provider with its own budget (DEV ≤ $1/month, early prod ≤ $5/month) |

Neither of these is a usage collector, and neither requires a new table,
migration, capability, or registry provider. **The modelling for self-hosted
Grafana is "use what is already there", not "build something".**

### D3 — Grafana is dashboard/UI; metrics storage is a separate, undecided question

Grafana-the-product is a **visualisation and alerting UI**. It is not a
time-series database. Conflating the two is what makes "where does Grafana run"
sound like one question when it is two:

1. **Where the dashboards and alert rules live.** Self-hosted Grafana OSS on the
   BE VPS, or Grafana Cloud.
2. **Where the samples live.** Prometheus, Mimir, Loki (logs), Grafana Cloud's
   hosted Mimir, or something else.

These can be answered independently — self-hosted Grafana reading Grafana
Cloud's Mimir is a valid combination, and so is Grafana Cloud reading nothing
of ours at all.

**This ADR decides neither.** The storage backend is explicitly left open and
must be decided in its own ADR when one of these triggers fires:

- DEV's Grafana Cloud Free stack approaches 10,000 active series, or its 14-day
  retention stops being enough for an investigation actually attempted;
- staging or production bootstrap needs a time-series destination (prod on
  Cloud means Pro, which is a real subscription and therefore a
  `hosting`-shaped manual cost, not a free tier);
- logs (Loki or otherwise) enter scope, which is a storage decision this ADR
  has deliberately said nothing about;
- someone proposes running Prometheus/Mimir on the BE VPS, which adds a
  stateful service with retention, disk and restore obligations to a host that
  currently has none.

Whichever way it goes, the read path does not change: the adapter speaks the
Prometheus HTTP API, and swapping the store is a `GRAFANA_PROM_URL` change plus
credentials. That is a deliberate property of ADR-0004's adapter rule and it is
the reason this decision can be deferred safely.

### D4 — What is allowed to change in the registry, and when

Until the topology is decided, the `grafana` provider stays exactly as it is:
`status: 'planned'`, capabilities empty, no collector, no pricing rule. It is
_declared_ so the cost board shows "chưa nối" rather than silently omitting
observability — option 2's failure mode.

- **If Cloud stays:** `grafana` may later gain `ACTUAL_COST_COLLECTOR` or a
  manual subscription row for Pro. It still does not gain a `USAGE_COLLECTOR`
  for `active_series` unless someone can name the price that number carries.
- **If self-hosted wins:** the `grafana.metrics` service and its `active_series`
  meter are removed, and the cost is `hosting.vps` per D2. That removal is a
  code change and needs its own authorized task; it is **not** part of this ADR
  and must not be done as a drive-by.

## Consequences

**Easier**

- #389 stops being blocked on a premise nobody had checked. Its three
  credential-blocked providers can proceed on their own schedule.
- The next agent reading G-22 or #389 cannot mistake "credential exists" for
  "collector is correct" — both now carry the reasoning and point here.
- Deferring the storage backend costs nothing operationally: the adapter is
  already vendor-neutral, so the decision is a config change whenever it comes.

**Harder / accepted costs**

- Observability cost is **not** broken down by component while self-hosted. A
  `hosting.vps` MANUAL row says "the VPS costs $X"; it does not say what share
  Grafana takes. That is the honest resolution available — apportioning a flat
  subscription across processes would be an invented number — but it means
  "what does monitoring cost us" is answerable only at VPS granularity.
- G-22 cannot be fully closed until the topology is decided, so the Cost
  Observability epic keeps one open gap for longer than it otherwise would.
- If Grafana Cloud Free is silently exceeded, the Cost Center will not be the
  thing that notices. `scripts/ops/check-quotas.sh` remains the guard, and it
  is a daily probe rather than a ledger. That is a deliberate acceptance, not
  an oversight: the epic (§24) already assigns quota probing and cost history
  to different mechanisms.

**Unchanged, and must stay unchanged**

- The CMS ops dashboard keeps reading metrics through `METRICS_QUERY` /
  `prometheus-query.adapter.ts`. Nothing in this ADR touches that path; the
  console must never learn which vendor holds the samples.
- `GRAFANA_RETENTION_DAYS` keeps driving the truncation the ops API reports —
  self-hosted retention is still retention, and a 30-day request must still
  come back `truncated: true` rather than extrapolated.
- Grafana remains a telemetry source and never becomes cost history (epic §24).
  The Postgres ledger stays the Cost Center's record.

## Migration & rollback

Nothing to migrate: no schema, no code, no data. This ADR removes work from the
queue and records why.

- **Adopting it** is the bookkeeping in GoGo-BE#401: this file, the G-22 row in
  `Cost-Spec/GOGO_COST_OBSERVABILITY_STATUS_AND_GAPS.md`, and the #389 issue
  body.
- **Backing it out** is one PR reverting those three edits, plus reopening the
  Grafana half of #389. Nothing will have been built on top of it, because its
  entire content is "do not build this yet".
- **Superseding it** is the expected path, not a failure: the storage-backend
  ADR triggered by D3 supersedes D3 and may supersede D4. D1 and D2 survive any
  such decision — a self-hosted stack is internal infrastructure whichever
  store it writes to.

## Follow-ups this ADR does not do

- **GoGo-Infra:** decide and record the observability topology itself (where
  Grafana runs, and separately where samples live). If it moves off Cloud, the
  `observability/grafana-*` rows in `config/secrets.manifest.yml` change
  meaning and INF-054's comment block needs rewriting — it currently reads as a
  settled decision.
- **GoGo-BE:** registry change per D4, only after the topology is decided and
  only as an authorized task.
- **Cost-Spec:** the epic's §41-P6 P1 list still names Grafana Cloud; it is the
  requirement authority and is not edited from `develop`. The gap list carries
  the deviation instead, which is the documented convention.
