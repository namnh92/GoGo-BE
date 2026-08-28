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
