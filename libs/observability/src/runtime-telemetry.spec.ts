import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './registry';
import { meterRuntimeCall, recordRuntimeCall } from './runtime-telemetry';

const op = {
  provider: 'upstash',
  service: 'upstash.redis',
  operation: 'upstash.redis.rate_limit.hit',
};

describe('runtime telemetry (#414)', () => {
  it('records a count and a duration on the same four labels', () => {
    const registry = new MetricsRegistry();
    recordRuntimeCall(registry, op, 'ok', Date.now() - 20);
    const out = registry.render();
    expect(out).toContain(
      'provider_requests_total{operation="upstash.redis.rate_limit.hit",provider="upstash",service="upstash.redis",status="ok"} 1',
    );
    expect(out).toMatch(
      /provider_request_duration_seconds_count\{operation="upstash\.redis\.rate_limit\.hit",provider="upstash",service="upstash\.redis",status="ok"\} 1/,
    );
  });

  it('meters a resolved call as ok and returns its value', async () => {
    const registry = new MetricsRegistry();
    const value = await meterRuntimeCall(registry, op, async () => 42);
    expect(value).toBe(42);
    expect(registry.render()).toContain('status="ok"} 1');
    expect(registry.render()).not.toContain('status="error"');
  });

  it('meters a rejected call as error and rethrows the same error', async () => {
    const registry = new MetricsRegistry();
    const boom = new Error('ECONNRESET');
    await expect(meterRuntimeCall(registry, op, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(registry.render()).toContain('status="error"} 1');
    expect(registry.render()).not.toContain('status="ok"');
  });
});
