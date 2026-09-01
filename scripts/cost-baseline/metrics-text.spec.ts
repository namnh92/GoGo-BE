import { describe, expect, it } from 'vitest';
import { countBy, diffSnapshots, parseMetricsText, quantile, quantileOf } from './metrics-text';

const EXPOSITION = `# TYPE places_provider_requests_total counter
places_provider_requests_total{method="google.details.quality",status="200"} 7
places_provider_requests_total{method="google.expand",status="302"} 2
# TYPE place_provider_request_duration_seconds histogram
place_provider_request_duration_seconds_bucket{method="google.details.quality",status="200",le="0.1"} 2
place_provider_request_duration_seconds_bucket{method="google.details.quality",status="200",le="0.5"} 6
place_provider_request_duration_seconds_bucket{method="google.details.quality",status="200",le="+Inf"} 7
place_provider_request_duration_seconds_sum{method="google.details.quality",status="200"} 1.75
place_provider_request_duration_seconds_count{method="google.details.quality",status="200"} 7
`;

describe('#336 parseMetricsText', () => {
  it('reads counters and histograms out of the exposition format', () => {
    const snap = parseMetricsText(EXPOSITION);
    expect(snap.counters).toHaveLength(2);
    expect(countBy(snap, 'places_provider_requests_total', 'method')).toEqual(
      new Map([
        ['google.details.quality', 7],
        ['google.expand', 2],
      ]),
    );
    const hist = snap.histograms[0]!;
    expect(hist.name).toBe('place_provider_request_duration_seconds');
    expect(hist.count).toBe(7);
    expect(hist.buckets.at(-1)).toEqual({ le: Infinity, count: 7 });
  });

  it('ignores comments and unparseable lines rather than guessing at them', () => {
    expect(parseMetricsText('# HELP x y\nnot a metric line\n').counters).toEqual([]);
  });
});

describe('#336 diffSnapshots', () => {
  it('reports the window, not the process uptime', () => {
    const before = parseMetricsText(EXPOSITION);
    const after = parseMetricsText(
      EXPOSITION.replace('status="200"} 7\nplaces', 'status="200"} 10\nplaces'),
    );
    const diff = diffSnapshots(before, after);
    expect(countBy(diff, 'places_provider_requests_total', 'method')).toEqual(
      new Map([['google.details.quality', 3]]),
    );
  });

  it('counts a series that only exists after the window from zero', () => {
    const before = parseMetricsText('');
    const after = parseMetricsText(EXPOSITION);
    const diff = diffSnapshots(before, after);
    expect(countBy(diff, 'places_provider_requests_total', 'method').get('google.expand')).toBe(2);
  });
});

describe('#336 quantiles', () => {
  it('interpolates inside the bucket that crosses the target, like histogram_quantile', () => {
    const hist = parseMetricsText(EXPOSITION).histograms[0]!;
    // p50 of 7 observations = rank 3.5, inside the 0.1→0.5 bucket (2 → 6).
    expect(quantile(hist, 0.5)).toBeCloseTo(0.1 + (1.5 / 4) * 0.4, 6);
  });

  it('is null for a window that observed nothing — an absent latency is not a fast one', () => {
    expect(quantile({ name: 'x', labels: {}, buckets: [], sum: 0, count: 0 }, 0.95)).toBeNull();
    expect(quantileOf(parseMetricsText(''), 'anything', () => true, 0.5)).toBeNull();
  });

  it('merges every matching series before taking the quantile', () => {
    const two = parseMetricsText(
      `${EXPOSITION}place_provider_request_duration_seconds_bucket{method="google.expand",status="302",le="0.1"} 2
place_provider_request_duration_seconds_bucket{method="google.expand",status="302",le="0.5"} 2
place_provider_request_duration_seconds_bucket{method="google.expand",status="302",le="+Inf"} 2
place_provider_request_duration_seconds_sum{method="google.expand",status="302"} 0.04
place_provider_request_duration_seconds_count{method="google.expand",status="302"} 2
`,
    );
    const merged = quantileOf(two, 'place_provider_request_duration_seconds', () => true, 0.5);
    const oneSeries = quantileOf(
      two,
      'place_provider_request_duration_seconds',
      (l) => l.method === 'google.details.quality',
      0.5,
    );
    expect(merged).not.toBeNull();
    expect(merged).toBeLessThan(oneSeries!);
  });
});
