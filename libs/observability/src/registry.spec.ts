import { describe, expect, it } from 'vitest';
import { MetricsRegistry, TeeMetrics } from './registry';
import { NoopMetrics } from './metrics';

describe('MetricsRegistry (#120)', () => {
  it('accumulates a counter per label set', () => {
    const r = new MetricsRegistry();
    r.increment('place_import_rows_total', { status: 'ready' });
    r.increment('place_import_rows_total', { status: 'ready' });
    r.increment('place_import_rows_total', { status: 'failed', error_code: 'NO_MATCH' });

    const out = r.render();
    expect(out).toContain('place_import_rows_total{status="ready"} 2');
    expect(out).toContain('place_import_rows_total{error_code="NO_MATCH",status="failed"} 1');
  });

  it('does not split one series because labels arrived in a different order', () => {
    const r = new MetricsRegistry();
    r.increment('m', { a: '1', b: '2' });
    r.increment('m', { b: '2', a: '1' });
    // Two series here would make every rate() wrong by half.
    expect(r.render()).toContain('m{a="1",b="2"} 2');
  });

  it('drops undefined labels rather than rendering them', () => {
    const r = new MetricsRegistry();
    r.increment('m', { status: 'ok', error_code: undefined });
    expect(r.render()).toContain('m{status="ok"} 1');
    expect(r.render()).not.toContain('undefined');
  });

  it('renders a histogram with cumulative buckets, sum and count', () => {
    const r = new MetricsRegistry();
    // Seconds (#320).
    r.observe('place_resolve_duration_seconds', 0.25, { source: 'cms_import' });
    r.observe('place_resolve_duration_seconds', 0.75, { source: 'cms_import' });

    const out = r.render();
    expect(out).toContain('# TYPE place_resolve_duration_seconds histogram');
    // Cumulative, and inclusive of the edge: 0.25s lands in le="0.25".
    expect(out).toContain('place_resolve_duration_seconds_bucket{le="0.25",source="cms_import"} 1');
    expect(out).toContain('place_resolve_duration_seconds_bucket{le="1",source="cms_import"} 2');
    expect(out).toContain('place_resolve_duration_seconds_bucket{le="+Inf",source="cms_import"} 2');
    expect(out).toContain('place_resolve_duration_seconds_sum{source="cms_import"} 1');
    expect(out).toContain('place_resolve_duration_seconds_count{source="cms_import"} 2');
  });

  it('escapes a label value that would otherwise break the format', () => {
    const r = new MetricsRegistry();
    r.increment('m', { action: 'say "hi"' });
    expect(r.render()).toContain('m{action="say \\"hi\\""} 1');
  });

  it('times an operation and labels the outcome', async () => {
    const r = new MetricsRegistry();
    await r.time('op_seconds', { kind: 'x' }, async () => 'done');
    await r
      .time('op_seconds', { kind: 'x' }, async () => {
        throw new Error('nope');
      })
      .catch(() => undefined);

    const out = r.render();
    expect(out).toContain('outcome="ok"');
    expect(out).toContain('outcome="error"');
  });

  it('tees to every target so one destination cannot lose the other', () => {
    const registry = new MetricsRegistry();
    const tee = new TeeMetrics([new NoopMetrics(), registry]);
    tee.increment('m', { a: '1' });
    expect(registry.render()).toContain('m{a="1"} 1');
  });
});

/**
 * #313 — `duration_ms` used to be a label on `places_provider_requests_total`,
 * so ten requests produced ten series each stuck at 1. These pin the shape that
 * replaced it: a bounded counter, and a real histogram beside it.
 */
describe('#313 — provider latency is a histogram, not a label', () => {
  it('does not grow a new series per duration', () => {
    const r = new MetricsRegistry();

    for (const seconds of [0.064, 0.071, 0.08, 0.104, 0.12, 0.16, 0.206, 0.252, 0.291, 0.306]) {
      r.increment('places_provider_requests_total', { method: 'google.searchText', status: 200 });
      r.observe('place_provider_request_duration_seconds', seconds, {
        method: 'google.searchText',
        status: 200,
      });
    }

    const rendered = r.render();
    const counterLines = rendered
      .split('\n')
      .filter((l) => l.startsWith('places_provider_requests_total'));

    // Ten requests, one series, value 10 — the whole point of a counter.
    expect(counterLines).toHaveLength(1);
    expect(counterLines[0]).toContain(' 10');
    expect(rendered).not.toContain('duration_ms=');
    expect(rendered).not.toContain('duration_seconds=');
  });

  it('counts and sums observations correctly', () => {
    const r = new MetricsRegistry();
    r.observe('place_provider_request_duration_seconds', 0.1, { method: 'm', status: 200 });
    r.observe('place_provider_request_duration_seconds', 0.3, { method: 'm', status: 200 });

    const rendered = r.render();
    expect(rendered).toContain(
      'place_provider_request_duration_seconds_count{method="m",status="200"} 2',
    );
    expect(rendered).toContain(
      'place_provider_request_duration_seconds_sum{method="m",status="200"} 0.4',
    );
  });

  it('uses the provider buckets, which resolve the range Google actually answers in', () => {
    const r = new MetricsRegistry();
    // Every observed DEV latency fell between 64ms and 306ms. The default
    // bucket set spans that in three steps; these must do better.
    for (const seconds of [0.064, 0.12, 0.206, 0.306]) {
      r.observe('place_provider_request_duration_seconds', seconds, { method: 'm', status: 200 });
    }

    const rendered = r.render();
    const edges = [
      ...rendered.matchAll(/place_provider_request_duration_seconds_bucket\{[^}]*le="([\d.]+)"/g),
    ].map((m) => Number(m[1]));
    expect(edges).toContain(0.075);
    expect(edges).toContain(0.15);
    expect(edges).toContain(0.3);
    // Cumulative, and separated: the default set would have put 64/120/206 in
    // two buckets and told us nothing about the shape.
    const at = (le: string) =>
      rendered.match(
        new RegExp(`_bucket\\{le="${le.replace('+', '\\+').replace('.', '\\.')}"[^}]*\\} (\\d+)`),
      )?.[1];
    expect(at('0.075')).toBe('1');
    expect(at('0.15')).toBe('2');
    expect(at('0.3')).toBe('3');
    expect(at('+Inf')).toBe('4');
  });
});

/**
 * #320 — units and bucket edges.
 *
 * A p95 is a statement about bucket edges before it is a statement about the
 * system, so an alert whose threshold falls between two edges is comparing
 * against an interpolation. Each set below is asserted to carry its own
 * threshold as an edge.
 */
describe('#320 — seconds, and an edge on every alert threshold', () => {
  it('times an operation in seconds, not milliseconds', async () => {
    const r = new MetricsRegistry();
    await r.time('op_seconds', { kind: 'x' }, () => new Promise((res) => setTimeout(res, 30)));

    const sum = Number(/op_seconds_sum\{[^}]*\} ([\d.e-]+)/.exec(r.render())?.[1]);
    // 30ms is 0.03s. In milliseconds this assertion reads 30 and passes on the
    // old code, which is exactly why it is written as a range around 0.03.
    expect(sum).toBeGreaterThan(0.01);
    expect(sum).toBeLessThan(1);
  });

  const edgesOf = (name: string, value: number) => {
    const r = new MetricsRegistry();
    r.observe(name, value, {});
    return [...r.render().matchAll(new RegExp(`${name}_bucket\\{le="([\\d.]+)"`, 'g'))].map((m) =>
      Number(m[1]),
    );
  };

  it('puts an edge at 1s, where the Google-slow alert fires', () => {
    expect(edgesOf('place_provider_request_duration_seconds', 0.1)).toContain(1);
  });

  it('puts an edge at 3s, where the resolve-slow alert fires', () => {
    expect(edgesOf('place_resolve_duration_seconds', 0.1)).toContain(3);
  });

  it('puts an edge at 3s, where the SG-010 suggestion budget sits', () => {
    expect(edgesOf('suggestion_run_latency_seconds', 0.1)).toContain(3);
  });

  it('keeps the submission queue in hours, with an edge at the 72h SLA', () => {
    const edges = edgesOf('place_submission_publish_latency_hours', 5);
    expect(edges).toContain(72);
    // On the seconds default set every observation would land in +Inf and the
    // metric would answer nothing at all.
    expect(edges.at(-1)).toBe(336);
  });

  it('falls back to the seconds default for a histogram with no set of its own', () => {
    const edges = edgesOf('op_seconds', 0.1);
    expect(edges[0]).toBe(0.001);
    expect(edges.at(-1)).toBe(30);
  });
});

/**
 * ADM-010 (#463) — gauges and collectors.
 *
 * The property that matters is that a gauge *replaces* rather than accumulates,
 * and that a collector runs at scrape time. An age computed when a dataset was
 * published and never refreshed would be wrong by however long the process has
 * been running.
 */
describe('gauges', () => {
  it('replaces the previous reading rather than adding to it', () => {
    const registry = new MetricsRegistry();
    registry.gauge('administrative_dataset_age_seconds', 10);
    registry.gauge('administrative_dataset_age_seconds', 42);
    expect(registry.render()).toContain('administrative_dataset_age_seconds 42');
    expect(registry.render()).not.toContain('administrative_dataset_age_seconds 52');
  });

  it('keeps one series per label set, and renders a gauge type', () => {
    const registry = new MetricsRegistry();
    registry.gauge('administrative_mappings', 3, { status: 'NEEDS_REVIEW' });
    registry.gauge('administrative_mappings', 7, { status: 'VERIFIED' });
    const body = registry.render();
    expect(body).toContain('# TYPE administrative_mappings gauge');
    expect(body).toContain('administrative_mappings{status="NEEDS_REVIEW"} 3');
    expect(body).toContain('administrative_mappings{status="VERIFIED"} 7');
  });

  it('runs its collectors immediately before rendering', async () => {
    const registry = new MetricsRegistry();
    let reads = 0;
    registry.registerCollector(async () => {
      reads += 1;
      registry.gauge('administrative_dataset_active', reads);
    });
    expect(await registry.collect()).toContain('administrative_dataset_active 1');
    expect(await registry.collect()).toContain('administrative_dataset_active 2');
  });

  it('does not let a failing collector take the scrape down with it', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('administrative_dataset_active', 1);
    registry.increment('administrative_dataset_operations_total', {
      operation: 'publish',
      result: 'succeeded',
    });
    registry.registerCollector(() => Promise.reject(new Error('database is asleep')));

    // A database hiccup degrades one gauge to its previous value; it does not
    // take every other metric in the process with it.
    const body = await registry.collect();
    expect(body).toContain('administrative_dataset_active 1');
    expect(body).toContain('administrative_dataset_operations_total');
  });

  it('lists gauge names alongside counters and histograms', () => {
    const registry = new MetricsRegistry();
    registry.gauge('administrative_publication_enabled', 1);
    registry.increment('administrative_cache_refresh_total', { result: 'ok' });
    expect(registry.names()).toEqual([
      'administrative_cache_refresh_total',
      'administrative_publication_enabled',
    ]);
  });
});
