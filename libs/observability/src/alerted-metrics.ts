/**
 * PI-SRE-001 (#120) — the metric names the alerts in `docs/infrastructure.md`
 * §3b fire on.
 *
 * Kept as a list so a rename fails a test instead of silently switching an
 * alert off. That is the failure this exists to prevent: an alert that matches
 * a series nobody emits any more looks exactly like an alert that is not
 * firing because nothing is wrong.
 */
export const ALERTED_METRICS = [
  'place_import_jobs_total',
  'place_import_rows_total',
  'place_resolve_duration_seconds',
  'place_resolve_confidence_bucket',
  'place_duplicate_candidates_total',
  'places_provider_requests_total',
  'place_provider_request_duration_seconds',
  'places_provider_failures_total',
  'places_provider_rejected_total',
  'places_provider_cost_units',
  'mobile_place_submissions_total',
  'place_submission_publish_latency_hours',
  'cms_emergency_takedown_total',
  'cms_super_admin_bypass_total',
] as const;

export type AlertedMetric = (typeof ALERTED_METRICS)[number];
