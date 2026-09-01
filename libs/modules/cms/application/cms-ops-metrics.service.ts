import { Inject, Injectable, Optional } from '@nestjs/common';
import { METRICS_QUERY, MetricsQueryError, type MetricsQueryPort } from '@gogo/providers';
import { APP_CONFIG } from '../../shared/config';
import {
  OPS_PROVIDERS,
  LATENCY_EXCLUDED_STATUSES,
  P99_MIN_SAMPLES,
  aggregate,
  opsQueries,
  opsTrendQueries,
  providerOf,
  resolveWindow,
  type OpsProvider,
  type OpsSamples,
  type OpsWindow,
  type ProviderBreakdown,
  type ResolvedWindow,
} from '../domain/ops-metrics';

/**
 * BE-CMS-P2 (#315) — the permissioned monitoring API behind the CMS ops
 * dashboard.
 *
 * The rule this exists to enforce: **the console never reads `/v1/metrics` and
 * never reaches Grafana.** That endpoint is a machine surface guarded by one
 * shared token that grants read of every internal series, with no per-user
 * authorization and no audit of who looked at what; handing it to a browser is
 * handing it to anyone who opens devtools. So GoGo-BE queries the store
 * server-to-server with a `metrics:read` credential from SSM and returns
 * facts, and the console's own admin session decides who may ask.
 *
 * Two more things it must never do, both of which are easier to get wrong than
 * right:
 *
 * - **Never become a dependency of consumer traffic.** Nothing outside the CMS
 *   ops module is given this service. A monitoring outage may not touch a
 *   room, a plan or a search.
 * - **Never fail loudly at the console.** A store that is down is a fact about
 *   monitoring, not about GoGo, so it comes back as `200` with
 *   `backend.status`. A `503` here renders as "the CMS is broken", which is
 *   the wrong sentence.
 */

type OpsMetricsConfig = {
  APP_ENV?: string | undefined;
  GRAFANA_RETENTION_DAYS?: number | undefined;
};

export type BackendStatus = 'ok' | 'degraded' | 'unavailable';

export type OpsEnvelope = {
  window: OpsWindow;
  effectiveWindow: string;
  retentionDays: number;
  truncated: boolean;
  generatedAt: string;
  backend: { status: BackendStatus; detail?: string };
  /** Set when the payload came from cache after a failed refresh. */
  stale?: boolean;
  asOf?: string;
};

/**
 * How long a fresh answer is reused.
 *
 * The console polls; ten operators with a dashboard open must cost the store
 * one query, not ten. Longer for the wide windows because a 30-day aggregate
 * does not meaningfully change in three minutes and is the most expensive
 * thing here to compute.
 */
const CACHE_TTL_MS: Record<OpsWindow, number> = {
  '1h': 45_000,
  '24h': 45_000,
  '7d': 180_000,
  '30d': 180_000,
};

/** Grafana Cloud Free. Overridden per environment once a paid tier is used. */
const DEFAULT_RETENTION_DAYS = 14;

type CacheEntry = { at: number; value: unknown };

@Injectable()
export class CmsOpsMetricsService {
  /**
   * Bounded by construction: three kinds × four windows × (all | three
   * providers). No part of the key comes from a request body, so a caller
   * cannot grow it.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: OpsMetricsConfig,
    @Optional() @Inject(METRICS_QUERY) private readonly metrics: MetricsQueryPort | null = null,
  ) {}

  private get env(): string {
    return this.config.APP_ENV ?? 'dev';
  }

  private get retentionDays(): number {
    return this.config.GRAFANA_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS;
  }

  async summary(window: OpsWindow) {
    const w = resolveWindow(window, this.retentionDays);
    return this.serve(`summary|${window}`, w, async () => {
      const { totals } = aggregate(await this.instantSamples(w));
      const trends = await this.trends(w);
      return {
        totals,
        costModel: COST_MODEL,
        latencySemantics: LATENCY_SEMANTICS,
        trends,
      };
    });
  }

  async providers(window: OpsWindow) {
    const w = resolveWindow(window, this.retentionDays);
    return this.serve(`providers|${window}`, w, async () => {
      const { providers } = aggregate(await this.instantSamples(w));
      return {
        providers: providers.map(stripOperations),
        costModel: COST_MODEL,
        latencySemantics: LATENCY_SEMANTICS,
      };
    });
  }

  async provider(provider: OpsProvider, window: OpsWindow) {
    const w = resolveWindow(window, this.retentionDays);
    return this.serve(`provider:${provider}|${window}`, w, async () => {
      const { providers } = aggregate(await this.instantSamples(w));
      const found = providers.find((p) => p.provider === provider) ?? emptyBreakdown(provider);
      return {
        provider: found,
        costModel: COST_MODEL,
        latencySemantics: LATENCY_SEMANTICS,
        trends: await this.trends(w),
      };
    });
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /**
   * Fresh if the cache is warm, otherwise a refresh — and if the refresh
   * fails, the last good answer with `degraded` rather than nothing.
   *
   * Stale data plainly labelled beats an empty dashboard: during an incident
   * the numbers from four minutes ago are usually the ones someone wants, and
   * `stale` + `asOf` let the console say so instead of implying they are live.
   */
  private async serve<T>(
    key: string,
    w: ResolvedWindow,
    load: () => Promise<T>,
  ): Promise<T & OpsEnvelope> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS[w.window]) {
      return { ...(cached.value as T), ...this.envelope(w, 'ok') };
    }
    if (!this.metrics) {
      return {
        ...emptyPayload<T>(),
        ...this.envelope(w, 'unavailable', 'No metrics backend configured for this environment'),
      };
    }
    try {
      const value = await load();
      this.cache.set(key, { at: Date.now(), value });
      return { ...value, ...this.envelope(w, 'ok') };
    } catch (err) {
      // Bounded, and never the store's own text: its errors quote the query,
      // and the query names internal series.
      const detail = describe(err);
      if (cached) {
        return {
          ...(cached.value as T),
          ...this.envelope(w, 'degraded', detail),
          stale: true,
          asOf: new Date(cached.at).toISOString(),
        };
      }
      return { ...emptyPayload<T>(), ...this.envelope(w, 'unavailable', detail) };
    }
  }

  private envelope(w: ResolvedWindow, status: BackendStatus, detail?: string): OpsEnvelope {
    return {
      window: w.window,
      effectiveWindow: w.effectiveWindow,
      retentionDays: w.retentionDays,
      truncated: w.truncated,
      generatedAt: new Date().toISOString(),
      backend: detail ? { status, detail } : { status },
    };
  }

  private async instantSamples(w: ResolvedWindow): Promise<OpsSamples> {
    const q = opsQueries(this.env, w);
    const run = (promql: string) => this.metrics!.query(promql);
    const [
      requests,
      failures,
      rejected,
      costUnits,
      latencySamples,
      p50,
      p95,
      p99,
      rejectedP50,
      rejectedP95,
    ] = await Promise.all([
      run(q.requests),
      run(q.failures),
      run(q.rejected),
      run(q.costUnits),
      run(q.latencySamples),
      run(q.quantile(0.5)),
      run(q.quantile(0.95)),
      run(q.quantile(0.99)),
      run(q.rejectedQuantile(0.5)),
      run(q.rejectedQuantile(0.95)),
    ]);
    return {
      requests,
      failures,
      rejected,
      costUnits,
      latencySamples,
      p50,
      p95,
      p99,
      rejectedP50,
      rejectedP95,
    };
  }

  private async trends(w: ResolvedWindow) {
    const q = opsTrendQueries(this.env, w);
    const end = new Date();
    const start = new Date(end.getTime() - w.effectiveSeconds * 1000);
    const range = async (promql: string) => {
      const series = await this.metrics!.queryRange(promql, start, end, w.stepSeconds);
      // These are all `sum(...)` with no `by`, so there is one series or none.
      return (
        series[0]?.points.map((p) => ({ t: new Date(p.t).toISOString(), v: round3(p.v) })) ?? []
      );
    };
    const [requests, failures, latencyP95, costUnits] = await Promise.all([
      range(q.requests),
      range(q.failures),
      range(q.latencyP95),
      range(q.costUnits),
    ]);
    return {
      stepSeconds: w.stepSeconds,
      series: { requests, failures, latencyP95, costUnits },
    };
  }
}

/**
 * What the cost number is, stated in the payload rather than in a comment
 * nobody reading the JSON will see.
 *
 * `places_provider_cost_units` counts **billable units by SKU**. That is a
 * real, reconcilable quantity — it is what an invoice is computed *from* — but
 * it is not money: no unit price exists anywhere in this system, and Google's
 * varies by tier and contract. So the API reports units and reports
 * `estimatedCost: null`, and no field is ever called `actualSpend`,
 * `billedAmount` or `invoiceCost`, because none of them would be true.
 *
 * Turning units into an amount needs either a price table someone owns or the
 * Cloud Billing API. Until then a currency figure here would be a guess
 * wearing a currency symbol, which is worse than the honest absence.
 */
const COST_MODEL = {
  kind: 'units_only' as const,
  estimatedCost: null,
  currency: null,
  basis: 'sku_request_counter',
  note: 'Billable SKU units counted per request. Not money: no unit price is configured, and no provider billing API is connected.',
};

/** Self-describing latency semantics, so a reader need not guess. */
const LATENCY_SEMANTICS = {
  unit: 'seconds' as const,
  source: 'place_provider_request_duration_seconds histogram',
  excludesHttpStatuses: [...LATENCY_EXCLUDED_STATUSES],
  excludesReason:
    'Deterministic input rejections (#314). Google refuses a malformed place id in tens of milliseconds, so counting those would make the provider look faster the more broken links users paste. Operational failures stay in.',
  p99MinSamples: P99_MIN_SAMPLES,
};

function stripOperations(p: ProviderBreakdown) {
  const { operations: _operations, ...rest } = p;
  return rest;
}

function emptyBreakdown(provider: OpsProvider): ProviderBreakdown {
  return {
    provider,
    instrumented: false,
    calls: 0,
    successes: 0,
    failures: 0,
    rejected: 0,
    successRate: null,
    latency: { p50: null, p95: null, p99: null },
    billableUnits: null,
    operations: [],
  };
}

/**
 * The payload when there is nothing to report.
 *
 * Every count is absent rather than zero. `backend.status` already says the
 * store could not be read, and a rendered `0` next to it is the exact
 * ambiguity the CMS is required to avoid: no traffic and no measurement are
 * different facts.
 */
function emptyPayload<T>(): T {
  return {
    totals: null,
    providers: OPS_PROVIDERS.map(emptyBreakdown).map(stripOperations),
    provider: null,
    trends: null,
    costModel: COST_MODEL,
    latencySemantics: LATENCY_SEMANTICS,
  } as unknown as T;
}

/**
 * Four words plus a sentence a person can act on. Never the store's text.
 *
 * Reads through `cause` as well: `withResilience` wraps a transient failure in
 * `ProviderUnavailableError` and keeps the original underneath, so the
 * classification survives the wrapper.
 */
function describe(err: unknown): string {
  const inner = err instanceof MetricsQueryError ? err : (err as { cause?: unknown } | null)?.cause;
  if (inner instanceof MetricsQueryError) {
    err = inner;
  }
  if (err instanceof MetricsQueryError) {
    switch (err.reason) {
      case 'unauthorized':
        return 'Monitoring backend refused our credential';
      case 'bad_request':
        return 'Monitoring backend rejected the query';
      case 'malformed':
        return 'Monitoring backend returned an unreadable response';
      default:
        return 'Monitoring backend is not answering';
    }
  }
  return 'Monitoring backend is not answering';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export { providerOf, OPS_PROVIDERS };
