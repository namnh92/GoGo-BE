import { describe, expect, it, vi } from 'vitest';
import { LogMetrics, NoopMetrics } from './metrics';
import type { AppLogger } from './logger';

const fakeLogger = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = {
    info: (obj: Record<string, unknown>) => lines.push(obj),
  } as unknown as AppLogger;
  return { logger, lines };
};

describe('LogMetrics', () => {
  it('emits counters and histograms in one stable shape', () => {
    const { logger, lines } = fakeLogger();
    const metrics = new LogMetrics(logger);

    metrics.increment('place_import_rows_total', { status: 'ready', error_code: undefined });
    metrics.observe('place_resolve_duration_seconds', 42, { source: 'cms_import' });

    expect(lines[0]).toEqual({
      metric: 'place_import_rows_total',
      type: 'counter',
      value: 1,
      status: 'ready',
    });
    // Undefined labels are dropped, not emitted as the string "undefined".
    expect(lines[0]).not.toHaveProperty('error_code');
    expect(lines[1]).toMatchObject({
      metric: 'place_resolve_duration_seconds',
      type: 'histogram',
      value: 42,
    });
  });

  it('times a call and labels the outcome, rethrowing failures', async () => {
    const { logger, lines } = fakeLogger();
    const metrics = new LogMetrics(logger);

    await metrics.time('op_ms', { source: 'x' }, async () => 'ok');
    expect(lines[0]).toMatchObject({ metric: 'op_ms', outcome: 'ok' });

    await expect(
      metrics.time('op_ms', { source: 'x' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lines[1]).toMatchObject({ metric: 'op_ms', outcome: 'error' });
  });
});

describe('NoopMetrics', () => {
  it('still runs the timed function', async () => {
    const fn = vi.fn(async () => 7);
    expect(await new NoopMetrics().time('x', {}, fn)).toBe(7);
    expect(fn).toHaveBeenCalledOnce();
  });
});
