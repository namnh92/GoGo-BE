# Administrative data — alerts, runbook and dashboard queries

ADM-010 (#463). BE-side definitions; the Prometheus/Alertmanager wiring is
GoGo-Infra#156. Every query below runs against the metrics this API already
exposes at `/metrics`, plus the capability endpoint
`GET /v1/cms/administrative-datasets/capability` for exact identities.

## What is a label and what is not

Every administrative metric label comes from a closed set: an operation, a
lifecycle state, a gate name, a severity, a mapping status, a bounded reason,
`dry_run` versus `execute`. Deliberately absent, and each one was tempting:

| not a label                  | where it lives instead                              |
| ---------------------------- | --------------------------------------------------- |
| `placeId`                    | structured log, audit row                           |
| dataset UUID                 | audit row                                           |
| **combined dataset version** | capability endpoint, audit row                      |
| boundary version             | capability endpoint, boundary load ledger           |
| administrative code          | audit row, moderation API                           |
| reviewer / admin id          | audit row — and nothing good comes of a leaderboard |
| `runId`                      | backfill run row                                    |
| checksum                     | dataset row, boundary load ledger                   |
| raw error message            | structured log                                      |

The version is the one worth spelling out: it mints a new value on every
publication, so a `{version="…"}` label would grow the series set forever and
every dashboard built on it would slowly stop loading.

## Capability, at a glance

```promql
administrative_dataset_active            # 1 when a dataset is published
administrative_boundary_active           # 1 when its boundary release is loaded
administrative_publication_enabled       # 1 when a place can be approved at all
administrative_dataset_age_seconds
administrative_boundary_age_seconds
```

`GET /v1/cms/administrative-datasets/capability` answers the same question with
the identities attached: exact versions, timestamps, counts per lifecycle state,
mapping counts, remediation counts, and whether the resolver is `FULL`,
`PARTIAL` (no polygons — it still answers from codes, names and the change
mapping) or `UNAVAILABLE`.

## Alerts

Thresholds are per environment and belong in Infra#156; what follows is the
condition and why it matters.

| alert                                                  | condition                                                                                                                                         | why                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **No active dataset**                                  | `administrative_dataset_active == 0` for 15m, in an environment expected to publish places                                                        | No place can be approved. The domain guard refuses; the API stays up.                                                                 |
| **No active boundaries**                               | `administrative_boundary_active == 0` while `administrative_dataset_active == 1`, 30m                                                             | The resolver is `PARTIAL`: geometry answers nothing, so most places land in review.                                                   |
| **Dataset validation ERROR**                           | `increase(administrative_validation_findings_total{severity="ERROR"}[1h]) > 0`                                                                    | A staged dataset cannot be published. Read the gate name.                                                                             |
| **Boundary validation ERROR**                          | `increase(administrative_boundary_findings_total{severity="ERROR"}[1h]) > 0`                                                                      | A boundary release was refused; the previous one still serves.                                                                        |
| **Publication or rollback failed**                     | `increase(administrative_dataset_operations_total{operation=~"publish\|rollback",result="failed"}[15m]) > 0`                                      | `failed` is not `rejected`: a rejection is the policy working.                                                                        |
| **Cache refresh failing**                              | `increase(administrative_cache_refresh_total{result="failed"}[30m]) > 2`                                                                          | Not an outage — other processes converge on the 60s TTL — but a repeated failure means the publishing process is serving stale reads. |
| **Quarantine or unresolved grew**                      | `delta(administrative_quarantined_changes[24h]) > <baseline delta>`                                                                               | The pinned dataset carries 1,033 unresolved rows by design. Alert on the _change_, never on the level.                                |
| **Review backlog**                                     | `administrative_mappings{status="NEEDS_REVIEW"} > <threshold>` for 24h                                                                            | Places are accumulating that nobody can approve.                                                                                      |
| **Remediation backlog**                                | `sum(administrative_remediation) - administrative_remediation{category="compliant"} > <threshold>`                                                | Pre-policy approved places. Reported, never auto-corrected.                                                                           |
| **Backfill failure rate**                              | `increase(administrative_backfill_places_total{outcome="failure"}[1h]) / clamp_min(increase(administrative_backfill_places_total[1h]), 1) > 0.05` |                                                                                                                                       |
| **Backfill stopped on a version change**               | `increase(administrative_backfill_version_stops_total[1h]) > 0`                                                                                   | Expected right after a publication; unexpected otherwise, and the run needs resuming or abandoning.                                   |
| **Provider request attributed to administrative work** | `increase(places_provider_requests_total[1h]) > 0` while no ingestion job ran                                                                     | The administrative feature calls no provider. Any increment here is a regression against ADR-0019 §10.                                |
| **Upstash command attributed to administrative work**  | `increase(provider_requests_total{provider="upstash"}[1h])` rising with no cache/rate-limit traffic to explain it                                 | The administrative cache is in-process by decision (ADR-0019 §8).                                                                     |

### Expected warnings are a baseline, not an alarm

The pinned dataset ships with known, measured warnings. Alerting on their
existence would train everyone to ignore the channel:

| expected                                  | count | rule                                                                         |
| ----------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| `SOURCE_FORMATTING` (`06325: xã Bắc Sơn`) | 1     | alert only if it changes                                                     |
| `UNRESOLVED_CHANGES` (divided communes)   | 1,033 | alert on delta, not level                                                    |
| `SAME_LEVEL_OVERLAP`                      | 233   | alert on delta                                                               |
| `COMMUNE_OUTSIDE_PROVINCE`                | 1,370 | alert on delta — province and commune outlines were simplified independently |
| `AREA_OUTLIER`                            | 56    | alert on delta                                                               |

So the boundary and validation alerts above fire on `severity="ERROR"` only,
and the warning families are watched with `delta()` against the accepted
baseline.

## Runbook

**No active dataset.** Import a pinned snapshot (`POST
/v1/cms/administrative-datasets/import`), validate it, read the diff, publish.
Until then place approval is blocked by design and everything else works.

**Validation ERROR.** Read `administrative_validation_findings_total{severity="ERROR"}`
for the gate, then the stored report on the dataset row for the rows that tripped
it. An ERROR is never overridable; fix the source or the override and re-validate.

**Publication failed.** The transaction rolled back and the previous version is
still active. Check the audit row (`administrative_dataset.publish_rejected`
carries the refusal reason) and the run's `ACTIVE_VERSION_CHANGED` case, which
means somebody else published first.

**Boundary load rejected.** The previous release still serves. The load
ledger's `validation_report` names the gate; a coverage mismatch means the
archive is not the archive that was pinned.

**Backfill stopped on a version change.** Either roll back to the exact pinned
versions and resume the run, or abandon it (`--abandon <runId> --reason …`) and
start a new one pinned to what is active now. Never edit a run's pins.

**Review backlog rising.** Look at `administrative_resolver_unresolved_total` by
reason: `BOUNDARY_EDGE` and `MULTIPLE_BOUNDARY_MATCHES` mean geometry is
ambiguous, `EVIDENCE_CONFLICT` means two sources disagree, `DIVIDED_CHANGE`
means the upstream split a commune and nobody may guess which half.

## Dashboard queries

```promql
# Dataset lifecycle, by outcome
sum by (operation, result) (increase(administrative_dataset_operations_total[24h]))

# Resolver outcome distribution
sum by (status) (increase(administrative_resolver_runs_total[24h]))
sum by (method) (increase(administrative_resolver_runs_total[24h]))
sum by (reason) (increase(administrative_resolver_unresolved_total[24h]))

# Point-in-polygon outcomes and latency
sum by (outcome) (increase(administrative_boundary_matches_total[24h]))
histogram_quantile(0.95, sum by (le) (rate(administrative_pip_duration_seconds_bucket[5m])))

# Review backlog and remediation
administrative_mappings
administrative_remediation

# Approval blocks, by the closed reason enum
sum by (reason) (increase(place_approval_checks_total{result="blocked"}[24h]))

# Publication deferrals from the import paths
sum by (source, reason) (increase(place_publication_deferred_total[24h]))

# Backfill progress
sum by (outcome, mode) (increase(administrative_backfill_places_total[1h]))
histogram_quantile(0.95, sum by (le) (rate(administrative_backfill_batch_duration_seconds_bucket[5m])))

# Freshness
administrative_dataset_age_seconds
administrative_boundary_age_seconds

# The zero-cost invariant
increase(places_provider_requests_total[24h])
increase(provider_requests_total{provider="upstash"}[24h])
```

## Zero-provider, zero-Upstash

There is deliberately **no** permanent `administrative_google_requests_total`
counter sitting at zero forever. A counter that can only ever be zero tells an
operator nothing and quietly implies somebody is checking. The guarantee is
enforced where it can actually fail — in tests that assert the existing provider
and Upstash counters do not move across the whole administrative surface — and
watched in production through the two alert rules above, which fire on the real
meters rather than on a decorative one.
