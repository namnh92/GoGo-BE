import type { PromSample } from '@gogo/providers';

/**
 * BE-CMS-P2 (#315) — the product-level shape of the ops metrics view, and
 * every rule that turns Prometheus samples into it.
 *
 * Pure on purpose. The interesting decisions here — which statuses count as a
 * provider failure, which are the caller's fault, what "p95" excludes, when a
 * 30-day window is not 30 days — are all things a test should be able to pin
 * with a fixture rather than a live stack. Nothing in this file performs I/O.
 */

// ── windows ────────────────────────────────────────────────────────────────

export const OPS_WINDOWS = ['1h', '24h', '7d', '30d'] as const;
export type OpsWindow = (typeof OPS_WINDOWS)[number];

const WINDOW_SECONDS: Record<OpsWindow, number> = {
  '1h': 3600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
};

/**
 * Step per window, chosen so every chart is 60–360 points.
 *
 * Small enough to send to a browser without downsampling logic, large enough
 * to draw. The client does not get to choose it — a step is a resolution
 * decision, and an arbitrary one is an arbitrary load on the store.
 */
const WINDOW_STEP_SECONDS: Record<OpsWindow, number> = {
  '1h': 60,
  '24h': 300,
  '7d': 1800,
  '30d': 7200,
};

export type ResolvedWindow = {
  window: OpsWindow;
  /** What was actually queryable, as a Prometheus duration string. */
  effectiveWindow: string;
  effectiveSeconds: number;
  stepSeconds: number;
  retentionDays: number;
  truncated: boolean;
};

/**
 * Clamp a requested window to what the store still holds.
 *
 * Grafana Cloud Free keeps 14 days. A 30-day request against it is not an
 * error and must not be answered with 30 days of anything: sixteen of those
 * days do not exist, and a chart that runs flat across them is a lie told in
 * the shape of data. The response says what it actually covers and that it
 * was cut.
 */
export function resolveWindow(window: OpsWindow, retentionDays: number): ResolvedWindow {
  const requested = WINDOW_SECONDS[window];
  const retained = Math.max(1, Math.floor(retentionDays)) * 86_400;
  const effectiveSeconds = Math.min(requested, retained);
  const truncated = effectiveSeconds < requested;
  return {
    window,
    // Echo the requested window verbatim when nothing was cut. Deriving it
    // instead answered a 24h request with "1d" — the same duration, a
    // different word from the one on the button the operator pressed, which
    // reads as though something was changed.
    effectiveWindow: truncated ? promDuration(effectiveSeconds) : window,
    effectiveSeconds,
    stepSeconds: WINDOW_STEP_SECONDS[window],
    retentionDays,
    truncated,
  };
}

/**
 * Whole days where they divide, whole hours next, minutes otherwise.
 *
 * The floor is one minute, not sixty. Clamping to 60 here — which this did
 * first — turned the 1h trend's four-step lookback of 240 seconds into `60m`,
 * so every point on an hour-long chart would have been a rate smoothed over
 * the whole hour and the chart would have been flat by construction.
 */
export function promDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

// ── providers ──────────────────────────────────────────────────────────────

export const OPS_PROVIDERS = ['places', 'routes', 'sheets'] as const;
export type OpsProvider = (typeof OPS_PROVIDERS)[number];

/**
 * Which service an adapter operation belongs to.
 *
 * Derived from the `method` label rather than a new label, because the label
 * set is already bounded and adding one would be a producer change for a
 * grouping the reader can do (#315 is not allowed to touch producer
 * semantics). Sheets and Routes are matched first: `google.` alone would
 * swallow both.
 */
export function providerOf(method: string): OpsProvider | null {
  if (method.startsWith('google.sheets.')) return 'sheets';
  if (method === 'google.routeMatrix') return 'routes';
  // Backstop. `operationForSku` folds `routes.computeRouteMatrix` onto
  // `google.routeMatrix` before this is reached, so nothing should arrive here
  // under a SKU name — but a SKU nobody remembered to map must land on the
  // right provider rather than vanish, because vanishing means a billed
  // provider reports `null` spend and `null` renders as "chưa đo".
  if (method.startsWith('routes.')) return 'routes';
  if (method.startsWith('google.')) return 'places';
  return null;
}

/**
 * The adapter operation a billed SKU belongs to.
 *
 * For Places the two are the same string — `places_provider_cost_units` is
 * labelled with the operation name. Routes is not: it bills as
 * `routes.computeRouteMatrix` while its request and latency series arrive as
 * `google.routeMatrix`.
 *
 * Left unmapped, that renders as two rows for one operation: one carrying six
 * calls and no cost, one carrying the cost and no calls. A reader has no way
 * to tell those are the same thing, and the obvious reading — that the
 * expensive operation is idle — is exactly backwards.
 */
const SKU_OPERATION: Readonly<Record<string, string>> = {
  'routes.computeRouteMatrix': 'google.routeMatrix',
};

export function operationForSku(sku: string): string {
  return SKU_OPERATION[sku] ?? sku;
}

// ── latency semantics ──────────────────────────────────────────────────────

/**
 * HTTP statuses excluded from the primary latency percentiles.
 *
 * These are the two our own classifier already calls the caller's fault:
 * `CLIENT_REJECT_STATUSES` is `INVALID_ARGUMENT` and `NOT_FOUND`, which arrive
 * as 400 and 404 (#314). Google refuses a malformed place id in tens of
 * milliseconds, so leaving them in makes the provider look *faster* the more
 * broken links users paste — the p95 that is supposed to answer "is Google
 * slow" would improve during an incident of a completely different kind.
 *
 * Operational failures stay in. A 403 or a 429 or a timeout is a real call
 * that really took that long, and hiding it is the opposite problem.
 *
 * The excluded mass is not thrown away: `rejectedLatency` reports it on its
 * own, so "fast rejections" is visible as a fact rather than as an absence.
 */
export const LATENCY_EXCLUDED_STATUSES = ['400', '404'] as const;

/**
 * Below this many observations a histogram p99 is just the top populated
 * bucket edge wearing a decimal point. Reported as `null` instead — the CMS
 * renders "chưa đủ dữ liệu", which is true, where a number would not be.
 */
export const P99_MIN_SAMPLES = 100;

export type Percentiles = { p50: number | null; p95: number | null; p99: number | null };

// ── query templates ────────────────────────────────────────────────────────

/**
 * Every PromQL string GoGo-BE can send, as a function of two bounded inputs:
 * a window from the enum above and this deployment's own `env` label.
 *
 * There is no path from a request body to any of these. The window is
 * validated against `OPS_WINDOWS` before it reaches here, the environment
 * comes from config, and nothing else is interpolated — so "can a client
 * inject PromQL" has the answer "there is no hole to inject into", which is a
 * stronger answer than escaping.
 *
 * The `env` matcher is not optional. One Grafana stack holds every
 * environment; without it a DEV console would quietly add production traffic
 * to its own numbers the day production starts writing.
 */
export function opsQueries(env: string, w: ResolvedWindow) {
  const e = `env="${env}"`;
  const range = w.effectiveWindow;
  const notRejected = `status!~"${LATENCY_EXCLUDED_STATUSES.join('|')}"`;
  const bucket = 'place_provider_request_duration_seconds_bucket';
  return {
    requests: `sum by (method, status) (increase(places_provider_requests_total{${e}}[${range}]))`,
    failures: `sum by (method) (increase(places_provider_failures_total{${e}}[${range}]))`,
    rejected: `sum by (method) (increase(places_provider_rejected_total{${e}}[${range}]))`,
    costUnits: `sum by (sku) (increase(places_provider_cost_units{${e}}[${range}]))`,
    latencySamples: `sum by (method) (increase(place_provider_request_duration_seconds_count{${e},${notRejected}}[${range}]))`,
    quantile: (q: number) =>
      `histogram_quantile(${q}, sum by (le, method) (rate(${bucket}{${e},${notRejected}}[${range}])))`,
    rejectedQuantile: (q: number) =>
      `histogram_quantile(${q}, sum by (le, method) (rate(${bucket}{${e},status=~"${LATENCY_EXCLUDED_STATUSES.join('|')}"}[${range}])))`,
  } as const;
}

/**
 * Trend series. The lookback is four steps so each point is a smoothed rate
 * rather than a single scrape interval's noise.
 */
export function opsTrendQueries(env: string, w: ResolvedWindow) {
  const e = `env="${env}"`;
  const look = promDuration(w.stepSeconds * 4);
  const notRejected = `status!~"${LATENCY_EXCLUDED_STATUSES.join('|')}"`;
  return {
    requests: `sum(rate(places_provider_requests_total{${e}}[${look}]))`,
    failures: `sum(rate(places_provider_failures_total{${e}}[${look}]))`,
    latencyP95: `histogram_quantile(0.95, sum by (le) (rate(place_provider_request_duration_seconds_bucket{${e},${notRejected}}[${look}])))`,
    costUnits: `sum(rate(places_provider_cost_units{${e}}[${look}]))`,
  } as const;
}

// ── aggregation ────────────────────────────────────────────────────────────

export type ProviderOperation = {
  method: string;
  calls: number;
  successes: number;
  failures: number;
  rejected: number;
  successRate: number | null;
  latency: Percentiles;
  /**
   * Billable units this SKU accrued. Units, not money — see `costModel` on the
   * response.
   */
  billableUnits: number | null;
};

export type ProviderBreakdown = {
  provider: OpsProvider;
  instrumented: boolean;
  calls: number;
  successes: number;
  failures: number;
  rejected: number;
  successRate: number | null;
  latency: Percentiles;
  billableUnits: number | null;
  operations: ProviderOperation[];
};

export type OpsTotals = {
  providerRequests: number;
  providerSuccesses: number;
  providerFailures: number;
  providerRejected: number;
  providerSuccessRate: number | null;
  providerFailureRate: number | null;
  providerRejectedRate: number | null;
  latency: Percentiles;
  rejectedLatency: Pick<Percentiles, 'p50' | 'p95'>;
  billableUnits: number;
};

/** Raw instant-query results, one array per template. */
export type OpsSamples = {
  requests: PromSample[];
  failures: PromSample[];
  rejected: PromSample[];
  costUnits: PromSample[];
  latencySamples: PromSample[];
  p50: PromSample[];
  p95: PromSample[];
  p99: PromSample[];
  rejectedP50: PromSample[];
  rejectedP95: PromSample[];
};

const byLabel = (samples: PromSample[], label: string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const s of samples) {
    const key = s.labels[label];
    if (key === undefined) continue;
    // `increase()` over a counter can land a hair above or below the integer
    // that actually happened; a dashboard showing "5.999 calls" is noise.
    out.set(key, (out.get(key) ?? 0) + s.value);
  }
  return out;
};

const finite = (n: number | undefined): number | null =>
  n === undefined || !Number.isFinite(n) ? null : n;

/**
 * Whole calls, but never rounding a real event down to none.
 *
 * `increase()` extrapolates at the window edges, so six requests come back as
 * 5.9998 and a single request scraped once can come back as 0.4. Plain
 * rounding turns that into `0`, and a provider row then reads
 * "instrumented, zero calls" — which is the 0-versus-unknown ambiguity this
 * whole screen exists to avoid, arriving through a side door. Seen live on
 * DEV the first time Sheets was called.
 *
 * A positive `increase()` means at least one thing happened. Say one.
 */
const roundCount = (n: number): number => (n > 0 ? Math.max(1, Math.round(n)) : Math.round(n));

const round = (n: number): number => Math.round(n * 1000) / 1000;

const rate = (part: number, whole: number): number | null =>
  whole <= 0 ? null : round(part / whole);

/**
 * Fold the instant-query results into per-operation rows.
 *
 * Counts are rounded to whole calls. `increase()` extrapolates at the window
 * edges, so it returns 5.9998 for six requests; presenting that verbatim makes
 * a dashboard look broken in a way that has nothing to do with the system.
 */
export function aggregate(samples: OpsSamples): {
  totals: OpsTotals;
  providers: ProviderBreakdown[];
} {
  const requestsByMethodStatus = new Map<string, Map<string, number>>();
  for (const s of samples.requests) {
    const method = s.labels.method;
    const status = s.labels.status;
    if (method === undefined || status === undefined) continue;
    const inner = requestsByMethodStatus.get(method) ?? new Map<string, number>();
    inner.set(status, (inner.get(status) ?? 0) + s.value);
    requestsByMethodStatus.set(method, inner);
  }

  const failures = byLabel(samples.failures, 'method');
  const rejected = byLabel(samples.rejected, 'method');
  // Folded onto the operation that spent them, so one operation is one row.
  const cost = new Map<string, number>();
  for (const [sku, value] of byLabel(samples.costUnits, 'sku')) {
    const method = operationForSku(sku);
    cost.set(method, (cost.get(method) ?? 0) + value);
  }
  const latencyCount = byLabel(samples.latencySamples, 'method');
  const p50 = byLabel(samples.p50, 'method');
  const p95 = byLabel(samples.p95, 'method');
  const p99 = byLabel(samples.p99, 'method');

  const methods = new Set<string>([
    ...requestsByMethodStatus.keys(),
    ...failures.keys(),
    ...rejected.keys(),
    ...cost.keys(),
  ]);

  const operations: ProviderOperation[] = [];
  for (const method of [...methods].sort()) {
    const statuses = requestsByMethodStatus.get(method) ?? new Map<string, number>();
    let calls = 0;
    let successes = 0;
    for (const [status, value] of statuses) {
      calls += value;
      if (status.startsWith('2')) successes += value;
    }
    calls = roundCount(calls);
    successes = roundCount(successes);
    const fail = roundCount(failures.get(method) ?? 0);
    const rej = roundCount(rejected.get(method) ?? 0);
    const samplesForP99 = latencyCount.get(method) ?? 0;
    operations.push({
      method,
      calls,
      successes,
      failures: fail,
      rejected: rej,
      successRate: rate(successes, calls),
      latency: {
        p50: roundOrNull(p50.get(method)),
        p95: roundOrNull(p95.get(method)),
        // A p99 from a handful of observations is the top populated bucket
        // edge, not a percentile.
        p99: samplesForP99 >= P99_MIN_SAMPLES ? roundOrNull(p99.get(method)) : null,
      },
      billableUnits: cost.has(method) ? roundCount(cost.get(method)!) : null,
    });
  }

  const providers: ProviderBreakdown[] = OPS_PROVIDERS.map((provider) => {
    const ops = operations.filter((o) => providerOf(o.method) === provider);
    const calls = sum(ops.map((o) => o.calls));
    const successes = sum(ops.map((o) => o.successes));
    const units = ops.map((o) => o.billableUnits).filter((u): u is number => u !== null);
    return {
      provider,
      // No operation seen at all is "not measured", which the console must
      // render differently from a measured zero.
      instrumented: ops.length > 0,
      calls,
      successes,
      failures: sum(ops.map((o) => o.failures)),
      rejected: sum(ops.map((o) => o.rejected)),
      successRate: rate(successes, calls),
      latency: worstOf(ops),
      // Sheets is quota-limited rather than billed per call, so it has no SKU
      // counter and must report `null` — never 0, which reads as "free".
      billableUnits: units.length > 0 ? sum(units) : null,
      operations: ops,
    };
  });

  const calls = sum(operations.map((o) => o.calls));
  const successes = sum(operations.map((o) => o.successes));
  const fails = sum(operations.map((o) => o.failures));
  const rejects = sum(operations.map((o) => o.rejected));
  const totalLatencySamples = sum([...latencyCount.values()]);

  return {
    totals: {
      providerRequests: calls,
      providerSuccesses: successes,
      providerFailures: fails,
      providerRejected: rejects,
      providerSuccessRate: rate(successes, calls),
      providerFailureRate: rate(fails, calls),
      providerRejectedRate: rate(rejects, calls),
      latency: {
        p50: aggregateQuantile(samples.p50),
        p95: aggregateQuantile(samples.p95),
        p99: totalLatencySamples >= P99_MIN_SAMPLES ? aggregateQuantile(samples.p99) : null,
      },
      rejectedLatency: {
        p50: aggregateQuantile(samples.rejectedP50),
        p95: aggregateQuantile(samples.rejectedP95),
      },
      billableUnits: sum([...cost.values()].map(roundCount)),
    },
    providers,
  };
}

/**
 * One number for "the provider tier", from per-method quantiles.
 *
 * The max, not the mean. Quantiles do not average — the mean of two p95s is
 * not the p95 of the union — and of the two defensible summaries the max is
 * the one that cannot hide a slow operation behind a fast one.
 */
function aggregateQuantile(samples: PromSample[]): number | null {
  const values = samples.map((s) => s.value).filter((v) => Number.isFinite(v));
  return values.length === 0 ? null : round(Math.max(...values));
}

function worstOf(ops: ProviderOperation[]): Percentiles {
  const pick = (key: 'p50' | 'p95' | 'p99'): number | null => {
    const values = ops.map((o) => o.latency[key]).filter((v): v is number => v !== null);
    return values.length === 0 ? null : round(Math.max(...values));
  };
  return { p50: pick('p50'), p95: pick('p95'), p99: pick('p99') };
}

function roundOrNull(n: number | undefined): number | null {
  const v = finite(n);
  return v === null ? null : round(v);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
