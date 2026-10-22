import { describe, expect, it } from 'vitest';
import type { CollectorDefinition } from '@gogo/modules';
import { registerOpenRouterActivityCollector } from './cost-openrouter';

/** BE#709 — the worker registers `openrouter_activity` only with a management key. */

function harness() {
  const registered: CollectorDefinition[] = [];
  const lines: { obj: object; msg: string }[] = [];
  return {
    registered,
    lines,
    collectors: { register: (def: CollectorDefinition) => registered.push(def) },
    logger: { info: (obj: object, msg: string) => lines.push({ obj, msg }) },
  };
}

describe('registerOpenRouterActivityCollector', () => {
  it('without a key registers nothing, logs what is missing, does not throw', () => {
    for (const env of [
      {},
      { OPENROUTER_MANAGEMENT_KEY: '  ' },
      { OPENROUTER_API_KEY: 'runtime-key-is-not-enough' },
    ]) {
      const h = harness();
      expect(registerOpenRouterActivityCollector(env, {} as never, h.collectors, h.logger)).toBe(
        false,
      );
      expect(h.registered).toEqual([]);
      expect(h.lines).toEqual([
        {
          obj: { provider: 'openrouter', missing: 'OPENROUTER_MANAGEMENT_KEY' },
          msg: 'openrouter cost collector not registered — credentials absent',
        },
      ]);
    }
  });

  it('with a key registers openrouter_activity and never logs the key', () => {
    const h = harness();
    const secret = ['mgmt', 'wiring', 'value'].join('_');
    expect(
      registerOpenRouterActivityCollector(
        { OPENROUTER_MANAGEMENT_KEY: secret },
        {} as never,
        h.collectors,
        h.logger,
      ),
    ).toBe(true);
    expect(h.registered.map((d) => [d.id, d.providerId, d.capability])).toEqual([
      ['openrouter_activity', 'openrouter', 'ACTUAL_COST_COLLECTOR'],
      ['anthropic_byok_openrouter', 'anthropic', 'ACTUAL_COST_COLLECTOR'],
    ]);
    expect(h.lines.map((l) => l.msg)).toEqual(['openrouter cost collector registered']);
    expect(JSON.stringify(h.lines)).not.toContain(secret);
  });
});
