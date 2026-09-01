import { describe, expect, it } from 'vitest';
import type { PromSample } from '@gogo/providers';
import {
  LATENCY_EXCLUDED_STATUSES,
  OPS_WINDOWS,
  P99_MIN_SAMPLES,
  aggregate,
  opsQueries,
  opsTrendQueries,
  promDuration,
  providerOf,
  resolveWindow,
  type OpsSamples,
} from './ops-metrics';

/**
 * #315 — deterministic fixtures, never a live stack.
 *
 * Every number here is one a reader can check by hand. Asserting "roughly what
 * Grafana said this afternoon" would make the suite pass or fail on traffic
 * nobody controls, which is a slower way of testing nothing.
 */

const s = (labels: Record<string, string>, value: number): PromSample => ({ labels, value });

/** No samples at all, so a test can supply only the arrays it cares about. */
const NONE: OpsSamples = {
  requests: [],
  failures: [],
  rejected: [],
  costUnits: [],
  latencySamples: [],
  p50: [],
  p95: [],
  p99: [],
  rejectedP50: [],
  rejectedP95: [],
};

describe('windows', () => {
  it('offers exactly the four the contract names', () => {
    expect([...OPS_WINDOWS]).toEqual(['1h', '24h', '7d', '30d']);
  });

  it('keeps a window the store can still answer', () => {
    const w = resolveWindow('7d', 14);
    expect(w.effectiveWindow).toBe('7d');
    expect(w.truncated).toBe(false);
    expect(w.retentionDays).toBe(14);
  });

  it('cuts 30d to the 14 days Grafana Cloud Free actually keeps', () => {
    const w = resolveWindow('30d', 14);
    // Sixteen of those days do not exist. Answering with 30 and a flat line is
    // a lie in the shape of data.
    expect(w.effectiveWindow).toBe('14d');
    expect(w.effectiveSeconds).toBe(14 * 86_400);
    expect(w.truncated).toBe(true);
    expect(w.window).toBe('30d');
  });

  it('does not cut anything on a store that keeps more than 30 days', () => {
    const w = resolveWindow('30d', 400);
    expect(w.effectiveWindow).toBe('30d');
    expect(w.truncated).toBe(false);
  });

  it('gives every window a step that yields between 60 and 360 points', () => {
    for (const window of OPS_WINDOWS) {
      const w = resolveWindow(window, 3650);
      const points = w.effectiveSeconds / w.stepSeconds;
      expect(points).toBeGreaterThanOrEqual(60);
      expect(points).toBeLessThanOrEqual(360);
    }
  });

  it('echoes the requested window verbatim when nothing was cut', () => {
    // Deriving it answered a 24h request with "1d" — the same duration, a
    // different word from the one on the button the operator pressed.
    expect(resolveWindow('24h', 14).effectiveWindow).toBe('24h');
    expect(resolveWindow('1h', 14).effectiveWindow).toBe('1h');
    expect(resolveWindow('7d', 14).effectiveWindow).toBe('7d');
  });

  it('renders durations in the largest whole unit', () => {
    expect(promDuration(3600)).toBe('1h');
    expect(promDuration(86_400)).toBe('1d');
    expect(promDuration(14 * 86_400)).toBe('14d');
    expect(promDuration(1800)).toBe('30m');
  });
});

describe('provider grouping', () => {
  it.each([
    ['google.searchText', 'places'],
    ['google.details.core', 'places'],
    ['google.details.quality', 'places'],
    ['google.details.detail', 'places'],
    ['google.autocomplete', 'places'],
    ['google.expand', 'places'],
    ['google.routeMatrix', 'routes'],
    ['google.sheets.meta', 'sheets'],
    ['google.sheets.values', 'sheets'],
  ])('%s belongs to %s', (method, provider) => {
    expect(providerOf(method)).toBe(provider);
  });

  it('refuses to guess for a method it does not know', () => {
    // Silently folding an unknown operation into Places would attribute its
    // cost to the wrong service.
    expect(providerOf('vietmap.search')).toBeNull();
    expect(providerOf('')).toBeNull();
  });
});

describe('query templates', () => {
  const w = resolveWindow('24h', 14);

  it('scopes every query to this deployment', () => {
    const q = opsQueries('dev', w);
    for (const value of Object.values(q)) {
      const promql = typeof value === 'function' ? value(0.95) : value;
      // One stack holds every environment. Without this a DEV console would
      // quietly add production traffic to its own numbers.
      expect(promql).toContain('env="dev"');
    }
  });

  it('asks the store only for the window it resolved, not the one requested', () => {
    const truncated = resolveWindow('30d', 14);
    expect(opsQueries('dev', truncated).requests).toContain('[14d]');
    expect(opsQueries('dev', truncated).requests).not.toContain('[30d]');
  });

  it('excludes deterministic input rejections from the latency percentiles', () => {
    const q = opsQueries('dev', w);
    expect(q.quantile(0.95)).toContain('status!~"400|404"');
    // …and reports the excluded mass on its own rather than discarding it.
    expect(q.rejectedQuantile(0.95)).toContain('status=~"400|404"');
    expect([...LATENCY_EXCLUDED_STATUSES]).toEqual(['400', '404']);
  });

  it('counts latency samples with the same exclusion the percentiles use', () => {
    // A p99 gated on a sample count that included rejections would unlock at a
    // threshold the percentile itself never saw.
    expect(opsQueries('dev', w).latencySamples).toContain('status!~"400|404"');
  });

  it('smooths trend points over four steps', () => {
    const trends = opsTrendQueries('dev', resolveWindow('1h', 14));
    // 1h steps at 60s, so the lookback is 4m.
    expect(trends.requests).toContain('[4m]');
  });

  it('interpolates nothing a caller could supply', () => {
    // The only inputs are an enum and a config value, so there is no hole to
    // inject into — a stronger property than escaping one.
    const q = opsQueries('dev', w);
    const all = Object.values(q).map((v) => (typeof v === 'function' ? v(0.95) : v));
    for (const promql of all) {
      expect(promql).not.toContain(';');
      expect(promql).toMatch(/^[\w\s(){}[\]"'~!=,.|<>+*/-]+$/);
    }
  });
});

describe('aggregation', () => {
  /**
   * Six Places calls: four details (three 200, one 400) and two searches (both
   * 200). One routes call that failed operationally. Nothing from Sheets.
   */
  const fixture: OpsSamples = {
    ...NONE,
    requests: [
      s({ method: 'google.details.quality', status: '200' }, 3),
      s({ method: 'google.details.quality', status: '400' }, 1),
      s({ method: 'google.searchText', status: '200' }, 2),
      s({ method: 'google.routeMatrix', status: '503' }, 1),
    ],
    failures: [s({ method: 'google.routeMatrix' }, 1)],
    rejected: [s({ method: 'google.details.quality' }, 1)],
    costUnits: [
      s({ sku: 'google.details.quality' }, 4),
      s({ sku: 'google.searchText' }, 2),
      s({ sku: 'routes.computeRouteMatrix' }, 10),
    ],
    latencySamples: [
      s({ method: 'google.details.quality' }, 3),
      s({ method: 'google.searchText' }, 2),
    ],
    p50: [s({ method: 'google.details.quality' }, 0.175), s({ method: 'google.searchText' }, 0.3)],
    p95: [s({ method: 'google.details.quality' }, 0.44), s({ method: 'google.searchText' }, 0.48)],
    p99: [s({ method: 'google.details.quality' }, 0.9)],
    rejectedP50: [s({ method: 'google.details.quality' }, 0.03)],
    rejectedP95: [s({ method: 'google.details.quality' }, 0.05)],
  };

  const { totals, providers } = aggregate(fixture);

  it('counts requests, successes, failures and rejections separately', () => {
    expect(totals.providerRequests).toBe(7);
    expect(totals.providerSuccesses).toBe(5);
    // Google not serving us…
    expect(totals.providerFailures).toBe(1);
    // …and us asking for something that does not exist. Different claims.
    expect(totals.providerRejected).toBe(1);
  });

  it('derives the three rates from those counts', () => {
    expect(totals.providerSuccessRate).toBeCloseTo(5 / 7, 3);
    expect(totals.providerFailureRate).toBeCloseTo(1 / 7, 3);
    expect(totals.providerRejectedRate).toBeCloseTo(1 / 7, 3);
  });

  it('takes the worst per-method quantile rather than averaging them', () => {
    // Quantiles do not average: the mean of two p95s is not the p95 of the
    // union. The max is the summary that cannot hide a slow operation behind
    // a fast one.
    expect(totals.latency.p95).toBe(0.48);
    expect(totals.latency.p50).toBe(0.3);
  });

  it('reports the rejected latency instead of discarding it', () => {
    // 30ms against a 440ms p95 is the whole reason rejections are excluded.
    expect(totals.rejectedLatency.p50).toBe(0.03);
    expect(totals.rejectedLatency.p95).toBe(0.05);
  });

  it('withholds p99 until there are enough observations', () => {
    expect(P99_MIN_SAMPLES).toBe(100);
    // Five samples. A p99 from those is the top populated bucket edge.
    expect(totals.latency.p99).toBeNull();
    const places = providers.find((p) => p.provider === 'places')!;
    expect(
      places.operations.find((o) => o.method === 'google.details.quality')!.latency.p99,
    ).toBeNull();
  });

  it('releases p99 once the sample count clears the threshold', () => {
    const busy = aggregate({
      ...fixture,
      latencySamples: [s({ method: 'google.details.quality' }, 500)],
    });
    expect(busy.totals.latency.p99).toBe(0.9);
  });

  it('groups operations under the right provider', () => {
    const places = providers.find((p) => p.provider === 'places')!;
    expect(places.operations.map((o) => o.method)).toEqual([
      'google.details.quality',
      'google.searchText',
    ]);
    expect(places.calls).toBe(6);
    expect(places.successes).toBe(5);

    const routes = providers.find((p) => p.provider === 'routes')!;
    expect(routes.calls).toBe(1);
    expect(routes.failures).toBe(1);
  });

  it('marks an uninstrumented provider rather than reporting it as idle', () => {
    const sheets = providers.find((p) => p.provider === 'sheets')!;
    // No metric for it at all. "chưa đo" and "0 calls" are different claims,
    // and rendering the second when the first is true is the defect.
    expect(sheets.instrumented).toBe(false);
    expect(sheets.calls).toBe(0);
    expect(sheets.billableUnits).toBeNull();
    expect(sheets.successRate).toBeNull();
  });

  it('gives Sheets no billable units even once it is instrumented', () => {
    const withSheets = aggregate({
      ...fixture,
      requests: [...fixture.requests, s({ method: 'google.sheets.values', status: '200' }, 4)],
    });
    const sheets = withSheets.providers.find((p) => p.provider === 'sheets')!;
    expect(sheets.instrumented).toBe(true);
    expect(sheets.calls).toBe(4);
    // Quota-limited, not billed per call. Null, never 0 — 0 reads as "free".
    expect(sheets.billableUnits).toBeNull();
  });

  it('attributes billable units to the operation that spent them', () => {
    const places = providers.find((p) => p.provider === 'places')!;
    expect(places.billableUnits).toBe(6);
    expect(
      places.operations.find((o) => o.method === 'google.details.quality')!.billableUnits,
    ).toBe(4);
  });

  it('rounds the extrapolation increase() adds at the window edges', () => {
    const noisy = aggregate({
      ...NONE,
      requests: [s({ method: 'google.searchText', status: '200' }, 5.9998)],
    });
    // Six calls happened. "5.9998 calls" makes a dashboard look broken in a
    // way that has nothing to do with the system.
    expect(noisy.totals.providerRequests).toBe(6);
  });

  it('never rounds a real call down to no calls', () => {
    // A series scraped once inside the window comes back below 0.5, and plain
    // rounding made the row read "instrumented, zero calls" — the
    // 0-versus-unknown ambiguity this screen exists to avoid, arriving through
    // a side door. Seen live on DEV the first time Sheets was called.
    const barely = aggregate({
      ...NONE,
      requests: [s({ method: 'google.sheets.meta', status: '200' }, 0.4)],
      costUnits: [s({ sku: 'google.sheets.meta' }, 0.4)],
    });
    expect(barely.totals.providerRequests).toBe(1);
    const sheets = barely.providers.find((p) => p.provider === 'sheets')!;
    expect(sheets.instrumented).toBe(true);
    expect(sheets.calls).toBe(1);
  });

  it('still reports a genuine zero as zero', () => {
    const none = aggregate({
      ...NONE,
      requests: [s({ method: 'google.searchText', status: '200' }, 0)],
    });
    expect(none.totals.providerRequests).toBe(0);
  });

  it('reports nulls, not zeros, when there is nothing to divide by', () => {
    const empty = aggregate(NONE);
    expect(empty.totals.providerRequests).toBe(0);
    expect(empty.totals.providerSuccessRate).toBeNull();
    expect(empty.totals.latency.p95).toBeNull();
    for (const p of empty.providers) expect(p.instrumented).toBe(false);
  });

  it('ignores a NaN quantile rather than charting it', () => {
    // histogram_quantile over an all-zero rate returns NaN. Prometheus drops
    // it; if one arrives anyway it must not become a data point.
    const withNaN = aggregate({ ...NONE, p95: [s({ method: 'google.searchText' }, Number.NaN)] });
    expect(withNaN.totals.latency.p95).toBeNull();
  });
});
