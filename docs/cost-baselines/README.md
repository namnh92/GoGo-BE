# Cost baselines

PR3 / COST-BE-003 (#336). Source: `Cost-Spec/GOGO_COST_AND_PLACES_EXECUTION_PLAN_v2_DECIDED.md` §3 PR3 and §4 — **historical only since 2026-09-02**; the requirement for test-run cost measurement is now `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md` §28–§30 and §43.

> **Status 2026-09-02.** Every file in this directory is frozen historical
> evidence and is never rewritten — a later measurement adds a file. The
> scenarios A–E describe the Google-seeded flows of that period and are not
> product architecture targets. PR9 (#342, "AFTER baseline") is no longer a
> roadmap item; the epic-shaped `cost_test_runs` / `cost_test_run_deltas` model
> supersedes it (tracker #370).

A baseline answers one question: **how many provider requests, of which
operation, does each product flow make today?** PR4 (same-execution reuse,
DB-first), PR5 (tier by need) and PR7 (refresh) all claim to move those
numbers. Without a frozen BEFORE they cannot be held to it.

## The rule that outranks the rest

**Every baseline reports operations separately — never a single "Google calls"
number.** `google.searchText` is an Essentials IDs-Only request; a
`google.details.quality` is Enterprise. They differ by a factor of twenty in
price, and PR5 deliberately moves volume from one to the other. Any total that
adds them hides the change it exists to measure. Nothing in the artifact
schema sums across operations.

Three more, for the same reason:

- **`null` is not `0`.** An unpriced operation, an uninstrumented one and a
  measured zero are three different facts. `google.routeMatrix` counts units
  exactly and has no verified per-element price (`price_unknown`); the Maps SDK
  has no telemetry at all (`not_instrumented`); scenario A really does make
  zero Places requests. Only the last is a zero.
- **No money field is an invoice.** Everything is `basis: ESTIMATED` at Google
  list price. GoGo cannot see the billing account, so free-cap arithmetic is an
  approximation and is labelled one.
- **Redis is measured by hand.** Upstash's free tier exposes no per-command
  API. `redis.commands` is `null` with the method written beside it.

## Two transports

|                                                    | `stub`                   | `live`       |
| -------------------------------------------------- | ------------------------ | ------------ |
| Google                                             | pinned response table    | the real API |
| Adapters, masks, resolver, import pipeline, ledger | real                     | real         |
| Call counts                                        | real                     | real         |
| Latency, error rate                                | **measure this machine** | real         |
| Needs credentials                                  | no                       | yes          |
| Deterministic                                      | yes                      | no           |

`stub` replaces the _transport_ and nothing above it. What a flow costs is
decided by how many times the stack calls `fetch` and with what field mask —
exactly what PR4 and PR5 change — so a stubbed run freezes the half of the
matrix that can be frozen today, and says in `limitations` which half it is not.

## The freezes

Produced by `apps/api/test/cost-baseline.int.spec.ts`, each named by the **UTC**
day, because that is how `provider_usage_daily` is keyed.

| File                             | What it records                                                    | Status                              |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| `2026-09-01-before-stub.json`    | what every flow cost before any of PR4–PR7                         | **immutable** — PR9's BEFORE column |
| `2026-09-02-after-pr4-stub.json` | after #337: same-execution reuse, DB-first, resolution attestation | superseded — PR9's per-PR column    |
| `2026-09-02-after-pr5-stub.json` | after #338: Details tiered by what each call site actually reads   | the golden the spec checks          |

The newest file is a golden: the spec re-runs the scenarios and refuses any
drift from it, so a behaviour change that moves a call count cannot land
silently. When PR5 or PR7 moves one on purpose, that spec fails — deliberately.
Re-freezing is a decision with a diff and a reviewer:

```bash
COST_BASELINE_WRITE=1 pnpm vitest run --project integration cost-baseline
```

**A re-freeze adds a file; it never rewrites an older one.** PR9 (#342) owes a
BEFORE/AFTER/DELTA table per operation, and a BEFORE column reconstructed from
git history is not evidence anybody will check. The spec asserts that
`2026-09-01-before-stub.json` and every superseded golden still exist and are
not the current golden, so overwriting one fails the build rather than passing
quietly. Attribution needs the intermediate files too: "quality fell by
thirty-three" is a different claim from "PR4 took eighteen and PR5 took
fifteen", and only the second can be checked against the PR that made it.

### What #337 moved, and what it did not

- **C (place already catalogued)** — `details.quality` 6 → 0. The Google Place
  ID is the dedup key and GoGo holds it, so both the preview and the submit are
  answered from the canonical provider row. C2 still pays its one
  `google.expand`: that HTTP hop is how a short link's id is learned, and it is
  not a Places request.
- **D (new place)** — three Enterprise `details` per place become two. The
  preview issues a short-lived signed attestation, the submit presents it
  instead of re-verifying, and the moderator's approve still re-verifies against
  Google because moderation delay outlives any attestation.
- **E (bulk)** — the three catalogued direct-id rows resolve without a Details
  call. Publish still re-fetches; that stays until PR8 settles what may be
  stored.
- **Unmoved on purpose** — A and B (still zero Places operations), every tier
  and field mask (that is PR5), and anything that would require storing more
  Google content (ADR-0006 §9.5).

### What #338 moved, and what it did not

PR5 changes no flow's behaviour and no flow's result. It changes which Google
SKU each call site buys, from a single default that bought the most expensive
one to a tier each path has to state and justify (ADR-0006 §2, amended).

| Operation                | before (2026-09-01) | after PR4 | after PR5 | at list price   |
| ------------------------ | ------------------- | --------- | --------- | --------------- |
| `google.details.core`    | 0                   | 0         | **15**    | $0.000 → $0.255 |
| `google.details.quality` | 53                  | 35        | **20**    | $1.060 → $0.400 |
| `google.searchText`      | 5                   | 5         | 5         | $0 (IDs-Only)   |
| `google.expand`          | 2                   | 2         | 2         | free, not a SKU |

- **E (bulk)** is the whole of it: fifteen resolve-stage Details move from
  Enterprise to Pro. The rows that come out are identical — resolving settles an
  identity, a category and a confidence, and every field that reads is a Pro
  field. Publish still buys Enterprise on the ten `ready` rows, because that
  call is what becomes the catalogue row.
- **D (new place)** is unchanged at two Enterprise calls per place. The preview
  renders Google's rating and review count, so it stays `quality`; the approve
  writes the catalogue row, so it stays `quality`. Plan §4's target cell for D
  reads `details.core` for the preview — that is a deviation, recorded here and
  in ADR-0006 §2, because a `core` preview would silently delete the rating from
  the mobile card rather than degrade it.
- **The submit path did move**, and this baseline cannot show it: with
  `PLACE_RESOLUTION_ATTESTATION_SECRET` set the submit makes no call at all. The
  rollback path — attestation off — went from `quality` to `core`, which
  `ingestion.int.spec.ts` pins.
- **Unmoved on purpose** — A, B and C (still zero Places operations), the
  `searchText` IDs-Only mask, and anything that would require storing more
  Google content (ADR-0006 §9.5). `liveness` (`id,movedPlaceId`, IDs-Only, free)
  is added and pinned but has no production caller yet, so it contributes a
  measured zero to every scenario; PR7's refresh is what will call it.

The same spec also runs the scenarios twice from the same starting state and
asserts they agree within ±1 per operation, which is the plan's acceptance
criterion.

## Measuring a deployed environment

```bash
DATABASE_URL=…              # the environment's Postgres — the ledger lives here
COST_BASELINE_API_URL=…     # the running API
COST_BASELINE_USER_TOKEN=…  # a normal user (submissions)
COST_BASELINE_MODERATOR_TOKEN=…
COST_BASELINE_OPS_TOKEN=…   # bulk import + publish are ops-only
COST_BASELINE_TUNNEL_QUIET=true
METRICS_TOKEN=…             # /metrics scrape
GRAFANA_QUERY_URL=… GRAFANA_USER=… GRAFANA_TOKEN=…   # optional cross-check

pnpm cost:baseline --name before-dev --fixtures docs/cost-baselines/fixtures-dev
pnpm cost:baseline --compare docs/cost-baselines/2026-…-a.json docs/cost-baselines/2026-…-b.json
```

A live run needs **its own fixture set**. The committed fixtures are synthetic
ids only the stub answers. Against real Google an operator points `--fixtures`
at a directory of real Place IDs — and only ids and URLs. Place IDs may be
stored (plan §7); names, addresses, ratings and hours may not, so a live
fixture file must not carry them.

## Contamination controls (plan §4)

Executed by `preflight`, recorded in the artifact, and **never** fatal: a
failed gate marks `preflight.quiet: false` on every number in the run rather
than aborting it. Aborting would tempt the next person to skip preflight to
get a number out; recording makes a contaminated baseline impossible to
mistake for a clean one.

| Gate                            | How                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| No import job `processing`      | queried                                                                                       |
| Usage ledger enabled            | config                                                                                        |
| 10 min of zero provider traffic | Grafana `increase(...[10m])`, `live` only                                                     |
| No handset on the DEV tunnel    | operator declaration (`COST_BASELINE_TUNNEL_QUIET`) — there is no server-side way to prove it |
| Working tree clean              | `git status --porcelain`, advisory                                                            |
| Same fixtures, order, git SHA   | recorded in `run`                                                                             |

Redis stays manual: Upstash console daily counter before and after, plus one
`redis-diag` `MONITOR` sample.

## Fixtures

`docs/cost-baselines/fixtures/` — `scenarios.json` (pinned inputs A–E),
`google-catalog.json` (what the pinned Google answers), `scenario-e-sheet.csv`
(the 20-row bulk import: 10 direct-id new, 5 name-only, 3 direct-id already
catalogued, 2 invalid).

Every id, name and address is invented and prefixed `GOGOBASE_`, asserted by
`scripts/cost-baseline/fixtures.spec.ts`. Nothing here was copied out of a
Google response, so committing them stores no provider content (plan §7).

Scenario ids are allocated from disjoint pools, so one scenario can never
pre-import another's "new" place — also asserted.

## What is still missing

- **A live DEV run.** No Google credentials are available, so real latency,
  real error rate and Google's own billable-unit counts are not yet measured.
  The `live` transport and the CLI exist for it; the fixture set does not.
- **Grafana cross-check.** Runs `null` until a run has Grafana credentials.
  `null` means nobody asked — never "Grafana agrees".
- **Server-side API latency.** `metric-labels.ts` has a provider duration
  histogram and no HTTP one, so `apiP50Ms`/`apiP95Ms` are the runner's own wall
  clock and include its overhead.
- **Maps SDK.** Client-side rendering, no server telemetry. A gap, never zero.
