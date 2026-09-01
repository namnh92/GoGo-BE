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
    r.observe('place_resolve_duration_ms', 30, { source: 'cms_import' });
    r.observe('place_resolve_duration_ms', 300, { source: 'cms_import' });

    const out = r.render();
    expect(out).toContain('# TYPE place_resolve_duration_ms histogram');
    // Cumulative: the 50ms bucket holds the 30ms sample only.
    expect(out).toContain('place_resolve_duration_ms_bucket{le="50",source="cms_import"} 1');
    expect(out).toContain('place_resolve_duration_ms_bucket{le="500",source="cms_import"} 2');
    expect(out).toContain('place_resolve_duration_ms_bucket{le="+Inf",source="cms_import"} 2');
    expect(out).toContain('place_resolve_duration_ms_sum{source="cms_import"} 330');
    expect(out).toContain('place_resolve_duration_ms_count{source="cms_import"} 2');
  });

  it('escapes a label value that would otherwise break the format', () => {
    const r = new MetricsRegistry();
    r.increment('m', { action: 'say "hi"' });
    expect(r.render()).toContain('m{action="say \\"hi\\""} 1');
  });

  it('times an operation and labels the outcome', async () => {
    const r = new MetricsRegistry();
    await r.time('op_ms', { kind: 'x' }, async () => 'done');
    await r
      .time('op_ms', { kind: 'x' }, async () => {
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

    for (const ms of [64, 71, 80, 104, 120, 160, 206, 252, 291, 306]) {
      r.increment('places_provider_requests_total', { method: 'google.searchText', status: 200 });
      r.observe('place_provider_request_duration_ms', ms, {
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
  });

  it('counts and sums observations correctly', () => {
    const r = new MetricsRegistry();
    r.observe('place_provider_request_duration_ms', 100, { method: 'm', status: 200 });
    r.observe('place_provider_request_duration_ms', 300, { method: 'm', status: 200 });

    const rendered = r.render();
    expect(rendered).toContain(
      'place_provider_request_duration_ms_count{method="m",status="200"} 2',
    );
    expect(rendered).toContain(
      'place_provider_request_duration_ms_sum{method="m",status="200"} 400',
    );
  });

  it('uses the provider buckets, which resolve the range Google actually answers in', () => {
    const r = new MetricsRegistry();
    // Every observed DEV latency fell between 64ms and 306ms. The default
    // bucket set spans that in three steps; these must do better.
    for (const ms of [64, 120, 206, 306]) {
      r.observe('place_provider_request_duration_ms', ms, { method: 'm', status: 200 });
    }

    const rendered = r.render();
    const edges = [
      ...rendered.matchAll(/place_provider_request_duration_ms_bucket\{[^}]*le="(\d+)"/g),
    ].map((m) => Number(m[1]));
    expect(edges).toContain(75);
    expect(edges).toContain(150);
    expect(edges).toContain(300);
    // Cumulative, and separated: the default set would have put 64/120/206 in
    // two buckets and told us nothing about the shape.
    const at = (le: string) =>
      rendered.match(new RegExp(`_bucket\\{le="${le.replace('+', '\\+')}"[^}]*\\} (\\d+)`))?.[1];
    expect(at('75')).toBe('1');
    expect(at('150')).toBe('2');
    expect(at('300')).toBe('3');
    expect(at('+Inf')).toBe('4');
  });

  it('leaves every other histogram on the default buckets', () => {
    const r = new MetricsRegistry();
    r.observe('place_resolve_duration_ms', 3, { source: 'cms_import' });

    // 1/5/10/… — unchanged, so no existing alert moves under this change.
    expect(r.render()).toContain('place_resolve_duration_ms_bucket{le="5",source="cms_import"} 1');
    expect(r.render()).toContain('place_resolve_duration_ms_bucket{le="1",source="cms_import"} 0');
  });
});
