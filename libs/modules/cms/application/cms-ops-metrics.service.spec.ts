import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsQueryError, type MetricsQueryPort, type PromSample } from '@gogo/providers';
import { CmsOpsMetricsService } from './cms-ops-metrics.service';

/**
 * #315 — the envelope, the cache and the failure behaviour.
 *
 * The arithmetic lives in `domain/ops-metrics.spec.ts`; what is under test
 * here is everything around it: that a monitoring outage cannot make the
 * console look broken, that a dashboard refresh cannot hammer the store, and
 * that nothing Grafana says reaches a browser.
 */

const sample = (labels: Record<string, string>, value: number): PromSample => ({ labels, value });

function stubPort(overrides: Partial<MetricsQueryPort> = {}) {
  const queries: string[] = [];
  const port: MetricsQueryPort = {
    query: vi.fn(async (promql: string) => {
      queries.push(promql);
      if (promql.includes('places_provider_requests_total')) {
        return [sample({ method: 'google.searchText', status: '200' }, 4)];
      }
      return [];
    }),
    queryRange: vi.fn(async () => []),
    ...overrides,
  };
  return { port, queries };
}

const config = { APP_ENV: 'dev', GRAFANA_RETENTION_DAYS: 14 };

describe('envelope', () => {
  it('reports a served window as untruncated', async () => {
    const { port } = stubPort();
    const res = await new CmsOpsMetricsService(config, port).summary('7d');
    expect(res.window).toBe('7d');
    expect(res.effectiveWindow).toBe('7d');
    expect(res.truncated).toBe(false);
    expect(res.retentionDays).toBe(14);
    expect(res.backend.status).toBe('ok');
  });

  it('states the real span when 30d exceeds what DEV keeps', async () => {
    const { port, queries } = stubPort();
    const res = await new CmsOpsMetricsService(config, port).summary('30d');
    expect(res.window).toBe('30d');
    expect(res.effectiveWindow).toBe('14d');
    expect(res.truncated).toBe(true);
    // And the store is asked for 14 days, not 30 — nothing is extrapolated
    // across the sixteen days that do not exist.
    expect(queries.every((q) => !q.includes('[30d]'))).toBe(true);
    expect(queries.some((q) => q.includes('[14d]'))).toBe(true);
  });

  it('scopes every query to its own environment', async () => {
    const { port, queries } = stubPort();
    await new CmsOpsMetricsService({ ...config, APP_ENV: 'prod' }, port).summary('1h');
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toContain('env="prod"');
  });
});

describe('a monitoring outage is not an outage', () => {
  it('answers 200-shaped with unavailable when no backend is configured', async () => {
    // Bound to null rather than a fake: a fake would answer a dashboard with
    // invented traffic, and this screen must never show an unmeasured number.
    const res = await new CmsOpsMetricsService(config, null).summary('24h');
    expect(res.backend.status).toBe('unavailable');
    expect(res.totals).toBeNull();
    expect(res.backend.detail).toContain('No metrics backend configured');
  });

  it('reports unavailable, not an error, when the store refuses us', async () => {
    const port = stubPort({
      query: vi.fn(async () => {
        throw new MetricsQueryError('unauthorized');
      }),
    }).port;
    const res = await new CmsOpsMetricsService(config, port).summary('24h');
    expect(res.backend.status).toBe('unavailable');
    expect(res.totals).toBeNull();
  });

  it('never returns the store its own words', async () => {
    const leaky = new Error(
      'query failed: sum(increase(places_provider_requests_total{env="dev"}[24h])) — token glc_xyz rejected',
    );
    const port = stubPort({
      query: vi.fn(async () => {
        throw leaky;
      }),
    }).port;
    const res = await new CmsOpsMetricsService(config, port).summary('24h');
    const body = JSON.stringify(res);
    // Prometheus quotes the query back, and the query names internal series.
    expect(body).not.toContain('places_provider_requests_total');
    expect(body).not.toContain('glc_xyz');
    expect(body).not.toContain('increase(');
    expect(res.backend.detail).toBe('Monitoring backend is not answering');
  });

  it('reports absent numbers as null so the console cannot render a false zero', async () => {
    const res = await new CmsOpsMetricsService(config, null).providers('24h');
    for (const p of res.providers) {
      expect(p.instrumented).toBe(false);
      expect(p.successRate).toBeNull();
      expect(p.billableUnits).toBeNull();
    }
  });
});

describe('cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves ten dashboard refreshes from one round of queries', async () => {
    const { port } = stubPort();
    const service = new CmsOpsMetricsService(config, port);
    for (let i = 0; i < 10; i += 1) await service.summary('24h');
    // Ten operators with the console open must cost the store one refresh.
    expect(port.query).toHaveBeenCalledTimes(10);
  });

  it('refreshes once the short window TTL expires', async () => {
    const { port } = stubPort();
    const service = new CmsOpsMetricsService(config, port);
    await service.summary('1h');
    const first = (port.query as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.advanceTimersByTime(46_000);
    await service.summary('1h');
    expect((port.query as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(first);
  });

  it('holds a wide window longer than a narrow one', async () => {
    const { port } = stubPort();
    const service = new CmsOpsMetricsService(config, port);
    await service.summary('30d');
    const first = (port.query as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.advanceTimersByTime(60_000);
    await service.summary('30d');
    // A 30-day aggregate does not meaningfully change in a minute, and it is
    // the most expensive thing here to compute.
    expect((port.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(first);
  });

  it('keys the cache on nothing a caller supplies', async () => {
    const { port } = stubPort();
    const service = new CmsOpsMetricsService(config, port);
    await service.summary('1h');
    await service.summary('24h');
    await service.providers('1h');
    await service.provider('places', '1h');
    // Four distinct keys, all built from enums. There is no request-body
    // component, so a caller cannot grow the map.
    expect((port.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(40);
  });
});

describe('stale data beats an empty dashboard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves the last good answer as degraded when a refresh fails', async () => {
    let failing = false;
    const port: MetricsQueryPort = {
      query: vi.fn(async (promql: string) => {
        if (failing) throw new MetricsQueryError('upstream');
        return promql.includes('places_provider_requests_total')
          ? [sample({ method: 'google.searchText', status: '200' }, 4)]
          : [];
      }),
      queryRange: vi.fn(async () => []),
    };
    const service = new CmsOpsMetricsService(config, port);

    const fresh = await service.summary('1h');
    expect(fresh.backend.status).toBe('ok');
    expect(fresh.totals?.providerRequests).toBe(4);

    failing = true;
    vi.advanceTimersByTime(60_000);
    const stale = await service.summary('1h');

    // During an incident the numbers from a minute ago are usually the ones
    // someone wants — but they must not be presented as live.
    expect(stale.backend.status).toBe('degraded');
    expect(stale.stale).toBe(true);
    expect(stale.asOf).toBeTypeOf('string');
    expect(stale.totals?.providerRequests).toBe(4);
  });

  it('does not invent a stale answer it never had', async () => {
    const port = stubPort({
      query: vi.fn(async () => {
        throw new MetricsQueryError('upstream');
      }),
    }).port;
    const res = await new CmsOpsMetricsService(config, port).summary('1h');
    expect(res.backend.status).toBe('unavailable');
    expect(res.stale).toBeUndefined();
  });
});

describe('self-describing semantics', () => {
  it('says what the latency figure excludes and why', async () => {
    const { port } = stubPort();
    const res = await new CmsOpsMetricsService(config, port).summary('24h');
    expect(res.latencySemantics.unit).toBe('seconds');
    expect(res.latencySemantics.excludesHttpStatuses).toEqual(['400', '404']);
    expect(res.latencySemantics.excludesReason).toContain('#314');
  });

  /**
   * COST-BE-035 (#420), ADR-0014 amendment — this surface states no amount.
   * Not "an estimate labelled as an estimate": no money at all, because two
   * calculations of one cost (list price here, ledger with the free tier on
   * `/cms/ops/costs`) could not agree and a reader had no way to pick one.
   */
  it('carries no money field at all — runtime facts and a pointer only', async () => {
    const { port } = stubPort();
    for (const res of [
      await new CmsOpsMetricsService(config, port).summary('24h'),
      await new CmsOpsMetricsService(config, port).providers('24h'),
      await new CmsOpsMetricsService(config, port).provider('places', '24h'),
    ]) {
      const keys = JSON.stringify(res);
      for (const forbidden of [
        'costModel',
        'estimatedCost',
        'estimatedCostMicros',
        'costComplete',
        'unpricedOperations',
        'measurementGaps',
        'pricingVersion',
        'freeCapApplied',
        'actualSpend',
        'billedAmount',
        'invoiceCost',
        'billed',
      ]) {
        expect(keys, forbidden).not.toContain(forbidden);
      }
    }
  });

  it('points every row at its Cost Center row by registry id', async () => {
    const { port } = stubPort();
    const rows = await new CmsOpsMetricsService(config, port).providers('24h');
    const byGroup = Object.fromEntries(rows.providers.map((p) => [p.provider, p.costCenter]));
    expect(byGroup['places']).toEqual({ providerId: 'google', serviceId: 'google.places' });
    expect(byGroup['routes']).toEqual({ providerId: 'google', serviceId: 'google.routes' });
    expect(byGroup['sheets']).toEqual({ providerId: 'google', serviceId: 'google.sheets' });
    // Two SDKs behind one console group: the link lands on the provider.
    expect(byGroup['maps_sdk']).toEqual({ providerId: 'google', serviceId: null });
    const detail = await new CmsOpsMetricsService(config, port).provider('places', '24h');
    for (const op of detail.provider!.operations) {
      expect(op.costCenter, op.method).toEqual({
        providerId: 'google',
        serviceId: 'google.places',
      });
    }
  });
});
