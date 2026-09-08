/**
 * #319 — the label keys each metric is allowed to carry.
 *
 * A Prometheus-compatible backend bills and indexes by *active series*, and a
 * series is one unique combination of label values. So a label whose value
 * comes from outside a finite set is not a slightly-expensive label; it is an
 * unbounded one, and it stays unbounded forever because a series that stops
 * being written is not a series that stops existing.
 *
 * Two of these have already shipped and had to be taken back out:
 *
 * - `places_provider_requests_total{duration_ms}` (#313) — every distinct
 *   millisecond made its own series, so ten requests produced ten series each
 *   stuck at 1. That is a log line wearing a counter's clothes, and no
 *   `rate()` can ask it anything.
 * - `place_import_unknown_mapping_total{field}` (#319) — free text an
 *   operator typed, sliced to 64 characters on the theory that truncation
 *   made it safe. Truncation caps a label's *length*; the number of distinct
 *   values it can take is untouched.
 *
 * The list below is the audit result, and the spec beside it is what stops the
 * third one. Adding a label means adding it here, which is the moment to ask
 * where its values come from.
 *
 * **Never** put these in a label: a raw duration, a URL, a place id, a query
 * string, an error message, a job id, a request id, a timestamp, a
 * spreadsheet id, or anything else a user or an operator typed.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  // --- providers -----------------------------------------------------------
  // `method` is the adapter's own operation name, `status` an HTTP code.
  places_provider_requests_total: ['method', 'status'],
  place_provider_request_duration_seconds: ['method', 'status'],
  // #339 — a `businessStatus` the adapter has no mapping for. Deliberately
  // **not** labelled with the value: that is Google's vocabulary and it can
  // grow, which is exactly how `place_import_unknown_mapping_total{field}`
  // became free text wearing a counter's clothes. The count alone answers the
  // question it exists for — is a status we do not handle arriving in volume?
  places_provider_business_status_unmapped_total: ['method'],
  // #339 — a place moved far enough to throw its cached travel legs away.
  // `source` is the door the move came through, not the place.
  place_relocation_invalidated_total: ['source'],
  // `reason` is Google's `ErrorInfo.reason`. Finite in practice but it is
  // Google's vocabulary, not ours — see the note in the spec.
  places_provider_failures_total: ['method', 'status', 'reason'],
  // Two values, from CLIENT_REJECT_STATUSES.
  places_provider_rejected_total: ['method', 'canonical_status'],
  // One per billable SKU, which is one per adapter operation.
  places_provider_cost_units: ['sku'],
  // #414 — runtime telemetry for the infrastructure this process calls
  // (Redis, Postgres). `provider` / `service` / `operation` are registry ids
  // declared in `@gogo/cost-observability` — literals from a closed list,
  // never a key, a channel, a table or a command's arguments. `status` is a
  // closed set — `ok | error` on the request path, `ok | unavailable | timeout`
  // for a bootstrap connect (#427): these are not HTTP calls and carry no code.
  provider_requests_total: ['provider', 'service', 'operation', 'status'],
  provider_request_duration_seconds: ['provider', 'service', 'operation', 'status'],
  // #335 — the durable usage ledger's own health. Two values, from the flush
  // path itself: a rising `error` rate means `provider_usage_daily` is behind
  // and the cost screen is under-reporting, which is the one failure mode a
  // ledger has that a counter does not.
  provider_usage_ledger_flush_total: ['outcome'],
  // #369 — how long one ledger flush takes; the number ADR-0012's DEV
  // validation could not measure. No labels: one process, one ledger.
  provider_usage_ledger_flush_duration_seconds: [],
  // #369 — the collector scheduler. `collector` is a registered literal id
  // (`ledger`, …), `outcome` a closed set from CollectorOutcome.
  cost_collector_runs_total: ['collector', 'outcome'],
  cost_collector_duration_seconds: ['collector'],
  // #369 — counted once per tick that had to pause paid collectors.
  cost_monitoring_over_budget_total: [],

  // --- worker --------------------------------------------------------------
  // #340 — `job` is the registered job name (a literal in `apps/worker`),
  // `result` is ok | failed | lock_skipped. Both closed sets; no timings as
  // labels, the duration is its own histogram.
  worker_periodic_runs_total: ['job', 'result'],
  worker_periodic_duration_seconds: ['job'],

  // --- ingestion -----------------------------------------------------------
  place_resolve_duration_seconds: ['source', 'outcome'],
  place_resolve_confidence_bucket: ['source', 'bucket'],
  place_import_jobs_total: ['status', 'source_type'],
  place_import_rows_total: ['status', 'error_code'],
  place_duplicate_candidates_total: ['kind'],
  // Both ends come from LEGACY_FIELD_ALIASES, which is a literal in source.
  place_import_legacy_mapping_total: ['from', 'to'],
  // A constant. The column that went unmapped is reported on the job itself
  // (`unmappedHeaders`); this only answers "is it still happening".
  place_import_unknown_mapping_total: ['code'],
  place_import_category_derived_total: ['source', 'category'],
  // Google's place-type vocabulary — large (~200) and externally controlled,
  // but finite, and it is the metric that says which type needs a mapping.
  place_import_category_underivable_total: ['google_type'],
  place_identity_change_total: ['reason'],
  // #334 — Google answered about a different place id than the one requested,
  // which is how a moved or merged place surfaces. `provider` is a constant
  // and `path` is the three doors identity can arrive through; no ids.
  place_provider_id_mismatch_total: ['provider', 'path'],
  // #334 — an import/submission/bulk row refused because the Google Place ID
  // is recorded against two places and the conflict is still open. `path` is
  // the finite set of doors; a non-zero rate means the merge queue is behind.
  place_identity_conflict_blocked_total: ['path'],
  // #337 — a Google Place ID answered from the catalogue instead of from
  // Google. `path` is the finite set of doors DB-first sits behind
  // (`resolve_link`, `submit`, `import`, `ingest`, `confirm`, `merge`); the hit
  // rate is what says whether PR4's saving is actually being taken.
  // #340 — the refresh job's own ledger. `outcome` is REFRESH_OUTCOMES, a
  // closed set of ten declared in `place-refresh.ts`: per-row (`attempted`,
  // `succeeded`, `moved`, `invalid_identity`, `dormant`) and per-tick
  // (`deferred_not_due`, `refused_budget`, `disabled`, `provider_error`,
  // `deadline`). No place id, no external id, no Google status text.
  place_refresh_total: ['outcome'],
  place_dbfirst_hit_total: ['path'],
  // …and why a lookup fell through, which is the more useful half: `absent` is
  // the catalogue growing, `stale` is refresh falling behind, `legacy` is a
  // pre-PR1 row, `indeterminate` is a provider status we never learned, and
  // `closure_unverified` is a row that knows the place as closed but not
  // recently enough to refuse on — the one miss that is a deliberate spend.
  place_dbfirst_miss_total: ['reason'],
  // #337 — the short-lived resolve proof (`issued`, `accepted`, `expired`,
  // `bad_signature`, `malformed`, `unsupported_version`, `wrong_purpose`,
  // `mismatch`, `disabled`, `unconfigured`). A closed set from
  // `AttestationRejection` plus the four operational outcomes; never a token,
  // never a place id. `unconfigured` climbing means a deployment lost its
  // secret and is quietly paying for the second Details call again.
  place_resolution_attestation_total: ['result'],

  // --- submissions ---------------------------------------------------------
  mobile_place_submissions_total: ['status'],
  place_submission_publish_latency_hours: ['decision'],

  // --- CMS -----------------------------------------------------------------
  cms_emergency_takedown_total: ['resource_type', 'role'],
  // `"METHOD /route"` built from the Fastify route *template*, never the
  // resolved URL — bounded by the route table, and writes only.
  // `resource_type` is the collection segment of that template, so it is the
  // same vocabulary collapsed one level further.
  cms_super_admin_bypass_total: ['action', 'resource_type'],

  // --- suggestions ---------------------------------------------------------
  experiment_assignment_total: ['experiment', 'variant'],
  ai_feedback_runs_total: ['outcome'],
  // `weights_version` grows by one set of series per activated ranking config.
  // Bounded by deploys rather than by traffic, and it never comes back down.
  suggestion_run_latency_seconds: ['variant', 'weights_version'],
  suggestion_run_over_budget_total: ['variant'],

  // --- share links (#205) --------------------------------------------------
  // `type` is the share_link_type enum (plus the literal `unknown` on a slug
  // nobody minted); `result` is ok / not_found / gone.
  share_link_created_total: ['type'],
  share_link_resolved_total: ['type', 'result'],
  // #206 — `attached` (vendor URL stored), `none` (no vendor configured),
  // `fallback` (vendor failed; link minted without attribution, FR-LINK-006).
  share_link_attribution_total: ['result'],

  // --- notifications -------------------------------------------------------
  campaign_dispatched_total: ['result'],
  // #193 — one provider call per event; `kind` is the notification kind enum.
  // `sent` counts provider-accepted calls, `unknown_user` the ids the provider
  // had no subscription for (never logged in on any device, or logged out),
  // `failed` a permanent refusal (configuration or payload) the dispatcher does
  // not retry. Transient outages are not counted here: they surface as an
  // outbox retry (`outbox_event_retry_total`) and on the `onesignal.push`
  // breaker.
  push_delivery_sent_total: ['kind'],
  // A request the provider accepted with nobody subscribed in it (HTTP 200,
  // no message id). Not a send and not a failure; counted apart so missing
  // subscriptions are visible rather than folded into `sent`.
  push_delivery_no_target_total: ['kind'],
  push_delivery_unknown_user_total: ['kind'],
  push_delivery_failed_total: ['kind'],
  // #193 — the OneSignal adapter itself. `status` is an HTTP code or the
  // literal `network`.
  push_provider_requests_total: ['status'],
  push_provider_request_duration_seconds: ['status'],
  // #199 — identity JWTs. `result` is `issued` or `unavailable` (no signing key
  // in this environment). Never the token, never the user.
  push_identity_tokens_total: ['result'],
  /** #160 — result: confirmed | still_enabled | unreachable | error. */
  push_identity_logout_confirm_total: ['result'],
  // #459 — the administrative address resolver. `status` is a mapping status,
  // `method` the evidence that decided it (or `none`). Deliberately **not**
  // labelled with the dataset or boundary version: those are minted per
  // publication and would grow the series set forever, which is the same
  // mistake `place_import_unknown_mapping_total{field}` made. The versions live
  // on every resolver result and in the audit row, where they belong.
  administrative_resolver_runs_total: ['status', 'method'],
  administrative_resolver_duration_seconds: ['status'],
  // Why a run could not resolve: a closed vocabulary (`ResolverReason`), so the
  // rate of `EVIDENCE_CONFLICT` against `NO_BOUNDARY_MATCH` is answerable.
  administrative_resolver_unresolved_total: ['reason'],
  // `outcome` is `unique | province_only | multiple | edge | none | invalid |
  // skipped`. `edge` apart from `multiple` on purpose: a point on a shared
  // border is geometry working correctly, overlapping polygons are a data
  // defect, and they have different fixes.
  administrative_boundary_matches_total: ['outcome'],
  // `written | noop | conflict | blocked`. A rising `blocked` means unattended
  // runs are repeatedly meeting reviewer-owned rows.
  administrative_mapping_writes_total: ['outcome'],
  // `StaleReason`. `REVALIDATED` is the healthy case — still true, older label.
  administrative_stale_evaluations_total: ['reason'],
  // #461 — one per committed enrichment batch. `outcome` is `dry_run` or
  // `executed`; the per-place numbers live on the run row, where a reviewer
  // reads them together rather than as twelve unrelated series.
  administrative_backfill_batches_total: ['outcome'],

  // --- ADM-010 (#463): administrative dataset, boundaries, moderation --------
  //
  // Every label below comes from a closed set. Deliberately absent, and each
  // one was tempting: `placeId`, `datasetId`, an administrative code, a
  // reviewer id, a `runId`, a checksum, a raw error message, and the combined
  // dataset version — that last one mints a new value on every publication, so
  // labelling by it would grow the series set forever. Exact identities live on
  // the capability endpoint, in structured logs and in audit rows.
  //
  // `operation` is import|validate|diff|publish|rollback; `result` is
  // succeeded|rejected|failed. A rejection is the policy working and a failure
  // is not, so they must never be one bucket.
  administrative_dataset_operations_total: ['operation', 'result'],
  administrative_dataset_operation_duration_seconds: ['operation'],
  // ADM-011 (#484). `view` is list|detail; `decision` is accept|reject;
  // `operation` is decision|materialize; `result` is succeeded|rejected. The
  // dataset, the quarantined row and the reviewer are all unbounded and all
  // live in the audit row instead — a label per decision would be a series per
  // row of a 1,033-row queue.
  administrative_override_queue_reads_total: ['view'],
  administrative_override_decisions_total: ['decision', 'result'],
  administrative_override_conflicts_total: ['operation'],
  administrative_override_materializations_total: ['result'],
  administrative_override_operation_duration_seconds: ['operation'],
  // `gate` is a GateId from ADM-004's closed list of twenty; `severity` is
  // ERROR or WARNING. This is what an alert on "validation regressed" reads.
  administrative_validation_findings_total: ['gate', 'severity'],
  // `result` is ok|failed. A failed warm-up is not a failed publication —
  // PostgreSQL is authoritative and other processes converge on the TTL — so it
  // is counted apart from the publication itself.
  administrative_cache_refresh_total: ['result'],
  // `result` is loaded|unchanged|rejected|failed.
  administrative_boundary_loads_total: ['result'],
  administrative_boundary_load_duration_seconds: [],
  // Bytes of the pinned archive as fetched. A histogram because it is a
  // measurement of a thing that changes per release, not a running total.
  administrative_boundary_archive_bytes: [],
  administrative_boundary_findings_total: ['gate', 'severity'],
  // How long one point-in-polygon containment took. No labels: one query
  // shape, and the boundary version is not a label.
  administrative_pip_duration_seconds: [],
  // `class` is definitional|unnumbered. Confidence is 1.00 or absent, and a
  // dashboard that averaged the two would be averaging a definition with a
  // silence.
  administrative_resolver_confidence_total: ['class'],
  // `mode` is dry_run|execute — the distinction the whole job is built on.
  administrative_backfill_runs_total: ['outcome', 'mode'],
  administrative_backfill_places_total: ['outcome', 'mode'],
  administrative_backfill_run_duration_seconds: ['mode'],
  administrative_backfill_batch_duration_seconds: ['mode'],
  administrative_backfill_version_stops_total: ['mode'],
  // `action` is the moderator verb, `result` is ok|rejected|conflict|unchanged.
  // Never the reviewer: unbounded, and nothing good comes of a leaderboard.
  administrative_moderation_actions_total: ['action', 'result'],
  // `reason` is the closed ApprovalBlockCode enum, or `none` when allowed.
  place_approval_checks_total: ['result', 'reason'],
  // `source` is cms_import|link_import; `reason` is the deferral enum.
  place_publication_deferred_total: ['source', 'reason'],

  // --- gauges: current state, not events ------------------------------------
  //
  // A counter cannot answer "is a dataset published" or "how many places are
  // waiting for a reviewer", and a process that restarted would answer wrong if
  // it tried. These are refreshed by a collector immediately before each
  // scrape, so an age is the age now rather than at the last publication.
  administrative_dataset_active: [],
  administrative_dataset_age_seconds: [],
  administrative_datasets: ['state'],
  administrative_quarantined_changes: [],
  administrative_unresolved_changes: [],
  administrative_boundary_active: [],
  administrative_boundary_age_seconds: [],
  administrative_boundary_units: ['level'],
  administrative_mappings: ['status'],
  administrative_remediation: ['category'],
  administrative_publication_enabled: [],
};

/**
 * `MetricsPort.time()` attaches this itself, so a call site that passes no
 * `outcome` still produces one.
 */
export const TIMED_LABEL = 'outcome';

export type MetricName = keyof typeof METRIC_LABELS;
