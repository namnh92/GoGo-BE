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
  // `reason` is Google's `ErrorInfo.reason`. Finite in practice but it is
  // Google's vocabulary, not ours — see the note in the spec.
  places_provider_failures_total: ['method', 'status', 'reason'],
  // Two values, from CLIENT_REJECT_STATUSES.
  places_provider_rejected_total: ['method', 'canonical_status'],
  // One per billable SKU, which is one per adapter operation.
  places_provider_cost_units: ['sku'],
  // #335 — the durable usage ledger's own health. Two values, from the flush
  // path itself: a rising `error` rate means `provider_usage_daily` is behind
  // and the cost screen is under-reporting, which is the one failure mode a
  // ledger has that a counter does not.
  provider_usage_ledger_flush_total: ['outcome'],

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

  // --- notifications -------------------------------------------------------
  campaign_dispatched_total: ['result'],
  push_delivery_failed_total: ['kind'],
};

/**
 * `MetricsPort.time()` attaches this itself, so a call site that passes no
 * `outcome` still produces one.
 */
export const TIMED_LABEL = 'outcome';

export type MetricName = keyof typeof METRIC_LABELS;
