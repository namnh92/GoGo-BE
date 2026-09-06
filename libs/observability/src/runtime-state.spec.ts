import { describe, expect, it } from 'vitest';
import { RuntimeStateStore } from './runtime-state';

const op = {
  provider: 'upstash',
  service: 'upstash.redis',
  operation: 'upstash.redis.rate_limit.connect',
};

describe('RuntimeStateStore (#427)', () => {
  it('keeps one entry per operation, the latest attempt winning', () => {
    const store = new RuntimeStateStore();
    expect(store.get(op.operation)).toBeNull();
    store.record(op, 'timeout', new Date('2026-09-06T03:00:00Z'));
    store.record(op, 'ok', new Date('2026-09-06T03:00:02Z'));
    expect(store.get(op.operation)).toEqual({
      operation: op.operation,
      status: 'ok',
      observedAt: '2026-09-06T03:00:02.000Z',
    });
    expect(store.snapshot()).toHaveLength(1);
  });
});
