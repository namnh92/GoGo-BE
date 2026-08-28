# Suggestion Engine Spec (SG-001)

Deterministic pipeline (SRS §12): `snapshot → retrieval → hard filter →
scoring → fairness/diversity → optimizer → validation/explanation`. AI (SG-009)
may only refine over already-validated candidates and is OFF by default
(`FLAG_AI_REFINEMENT`, kill switch).

## Snapshot (SG-002)

`suggestion_runs.input_snapshot` stores the full room snapshot (constraints
version, budget, window, origin, member preferences, seeds) — immutable,
versioned by `engine_version` + `weights_version` for audit/A-B (FR-SUG-010).

## Hard filters (SG-003) — never overridable

| Check                                                  | Reason code            |
| ------------------------------------------------------ | ---------------------- |
| PostGIS/haversine radius                               | `OUT_OF_AREA`          |
| price lower bound > per-person budget                  | `OUT_OF_BUDGET`        |
| no opening-hours overlap with window (overnight aware) | `CLOSED_DURING_WINDOW` |
| missing required dietary key                           | `DIETARY_UNMET`        |
| missing required accessibility key                     | `ACCESSIBILITY_UNMET`  |

## Scoring (SG-004)

`score = (Σ wᵢ·componentᵢ) × (0.5 + 0.5·suitability(audience))`

Components (all 0..1, persisted for "Vì sao phù hợp"): `preference` (weighted
selection overlap per member, averaged), `consensus` (share of members with
any match), `distance` (1/(1+d/2km)), `budget` (headroom vs per-person
budget; unknown price = 0.4, never free), `quality` (rating × log-scaled
count), `freshness` (e^(−days/60)), `seedBoost` (FR-ROOM-010).

Weights: `ranking_configs['suggestion.scoring']` versioned rows; bounds in
`SCORING_WEIGHT_BOUNDS` — an out-of-bounds config is rejected whole, falling
back to defaults `0.3/0.15/0.15/0.15/0.15/0.05/0.05`.

Reason codes: `MATCHES_PREFERENCES`, `LIKED_BY_EVERYONE`, `FITS_BUDGET`,
`NEAR_ORIGIN`, `HIGHLY_RATED`, `HOST_SUGGESTED`.

## Fairness + diversity (SG-005)

MMR-style iterative top-K: each pick maximizes
`score − repeats·0.08 + satisfaction(least-satisfied member)·0.1`.
Guarantee tested: a 3-vs-1 minority's preferred venue appears in top-K.
Tie-break is total-ordered: score → rating → rating count → placeId.

## Decision (SG-006)

- Couple `match`: winner = place all members voted yes/star; auto-plans once
  every member has voted; multiple matches resolve by candidate rank.
- Group `vote`: star=2 / yes=1 / no=0; host finalizes; ties resolve by
  candidate rank (explainable) or explicit host pick (allowlisted only).
- Votes idempotent by (room, member, place) upsert.

## Optimizer (SG-007)

Greedy sequential build: stop count from window (`⌊window/2h⌋+1`, 1..4),
per-stop checks — window fit (visit + travel @400 m/min + 10' buffer),
per-person budget accumulation, consecutive-category diversity. Totals carry
`overBudget` (UPPER bound — FR-SUG-006) and `uncertain` (any confidence <0.6
or unknown price).

## Regenerate / lock (SG-008)

Locked stops are anchors: same place, position, duration, cost — asserted in
CI (`suggestion-plan.int.spec.ts`, release gate E2E #3). Unlocked current
places are excluded from the refill pool ("give me something else").
Constraint edits mark plans/scores stale; regenerate always uses the fresh
snapshot. Plans version linearly; exactly one `current` per room (partial
unique index).

## Not in this slice

SG-009 AI refinement (needs provider + DPA — blocked, tracked GoGo-BE#48),
SG-010 offline eval/A-B (partial: versions persisted; assignment + cost
budget tracked GoGo-BE#49).

## Experiments and evaluation (SG-010, #49)

**The subject is the room, never the member.** A group room split across two
variants would compare two systems and call it one experiment, and the plan
would depend on who asked for it. Assignment is `sha256(experimentKey:roomId)`
mapped into the configured shares — computed rather than stored, so a room
always lands in the same variant and there is no row whose loss would silently
reassign it mid-experiment. The salt is the experiment key, so two experiments
running over the same rooms do not correlate.

Shares may sum to less than 1; the remainder is control. Summing to more is
refused, because the alternative is silently dropping whichever variant sorted
last.

**A variant names an approved ranking config version.** Approved, not draft: an
experiment must not become a way to put unreviewed weights in front of users,
and the four-eyes rule stays the gate. A variant naming a version that is not
approved falls back to the active config and says so in the recorded weights
version, so the audit does not claim the experiment ran when it did not.

**Null is not control.** A run with no `experiment_key` means no experiment was
defined; a run with a key and `control` means the experiment ran and this room
was the baseline. Those are different facts about a result and are stored
differently.

**The kill switch is a normal write.** `PUT /cms/experiments/{key}` with
`enabled: false` sends every subject to control on the next request. A switch
that needs a deploy is not a switch. Definitions are read per call rather than
cached for the same reason.

**Offline evaluation replays stored snapshots.** Every suggestion run keeps the
immutable snapshot it was computed from, so a candidate config can be scored
against real rooms before anyone is exposed to it — which is what makes
activating a config a decision rather than a hope. It reads, scores in memory
and writes nothing: no plan, no run, no user.

Runs where no candidate passes the hard filters are **skipped, not counted as
agreement** — counting them would flatter every candidate config, since both
configs return the same nothing. Out-of-bounds weights are refused outright:
any number produced from them would describe a config the engine would have
rejected anyway.

**Latency is a result too.** Every run records `latency_ms` and emits
`suggestion_run_latency_ms` labelled by variant, with
`suggestion_run_over_budget_total` past 3s. A variant that wins on ranking and
loses on speed is two results, and only one of them shows up in ranking.
