import { describe, expect, it } from 'vitest';
import type { CollectorDefinition } from '@gogo/modules';
import { registerSentryEventsCollector } from './cost-sentry';

/** BE#696 A6 — the worker registers `sentry_events` only with a token. */

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

describe('registerSentryEventsCollector', () => {
  it('without a token registers nothing, logs what is missing, does not throw', () => {
    for (const env of [{}, { SENTRY_STATS_TOKEN: '', SENTRY_ORG: 'gogo-vn' }]) {
      const h = harness();
      expect(registerSentryEventsCollector(env, {} as never, h.collectors, h.logger)).toBe(false);
      expect(h.registered).toEqual([]);
      expect(h.lines).toEqual([
        {
          obj: { provider: 'sentry', missing: 'SENTRY_STATS_TOKEN / SENTRY_ORG' },
          msg: 'sentry cost collector not registered — credentials absent',
        },
      ]);
    }
  });

  it('with a token registers sentry_events and never logs the token', () => {
    const h = harness();
    const token = 'sntrys_wiring_secret';
    expect(
      registerSentryEventsCollector(
        { SENTRY_STATS_TOKEN: token },
        {} as never,
        h.collectors,
        h.logger,
      ),
    ).toBe(true);
    expect(h.registered.map((d) => [d.id, d.providerId, d.serviceId])).toEqual([
      ['sentry_events', 'sentry', 'sentry.errors'],
    ]);
    expect(h.lines.map((l) => l.msg)).toEqual(['sentry cost collector registered']);
    expect(JSON.stringify(h.lines)).not.toContain(token);
  });
});
