import {
  MetricsQueryError,
  type MetricsQueryPort,
  type PromSample,
  type PromSeries,
} from './ports';
import { withResilience } from './resilience';

/**
 * Reads the time-series store back (#315).
 *
 * Grafana Cloud's Mimir speaks the Prometheus HTTP API, so this is a plain
 * Prometheus client rather than anything Grafana-specific — which is the point
 * of ADR-0004's adapter rule: the CMS never learns which vendor holds the
 * samples, and swapping one for another is a binding change.
 *
 * Three things this deliberately does not do:
 *
 * - **No retries.** A dashboard refresh that fans out into a retry storm is
 *   how a slow monitoring backend becomes a down one. One attempt, a short
 *   timeout, and the caller serves cache. `withResilience` is here for the
 *   breaker, not the retry.
 * - **No query construction.** Every PromQL string is a constant owned by the
 *   CMS layer. This takes a string and sends it; it cannot be handed anything
 *   a client typed because nothing upstream of it accepts free text.
 * - **No error text.** Whatever Prometheus says about a failed query is
 *   classified into one of four words and thrown away. The store's own
 *   messages quote the query, which names internal series.
 */

const RESILIENCE = {
  name: 'grafana.query',
  // Under the CMS request budget on purpose: the console degrades to "monitoring
  // unavailable" rather than hanging, and observability must never be able to
  // make a page look broken.
  timeoutMs: 4000,
  retries: 0,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

type PromResponse = {
  status?: string;
  data?: {
    resultType?: string;
    result?: {
      metric?: Record<string, string>;
      value?: [number, string];
      values?: [number, string][];
    }[];
  };
};

export type PrometheusQueryConfig = {
  /** Remote-write endpoint from SSM; the query API is derived from it. */
  url: string;
  username: string;
  token: string;
};

/**
 * SSM stores the *write* endpoint, because that is what the collector needs
 * and one parameter is better than two that can disagree. The query API is its
 * sibling, so it is derived rather than stored:
 *
 *   https://…grafana.net/api/prom/push  ->  https://…grafana.net/api/prom
 *
 * Tolerates the base URL with or without the suffix, so an operator who pastes
 * the query URL instead of the push URL still gets a working deployment.
 */
export function promApiBase(writeUrl: string): string {
  const trimmed = writeUrl.replace(/\/+$/, '');
  const withoutPush = trimmed.endsWith('/push') ? trimmed.slice(0, -'/push'.length) : trimmed;
  return withoutPush.endsWith('/api/prom') ? withoutPush : `${withoutPush}/api/prom`;
}

export class PrometheusQueryAdapter implements MetricsQueryPort {
  private readonly base: string;
  private readonly auth: string;

  constructor(config: PrometheusQueryConfig) {
    this.base = promApiBase(config.url);
    // Basic, per Grafana Cloud: the username is the numeric instance id and
    // the password is the `metrics:read` access-policy token. The token is
    // never logged, never returned, and never leaves this process.
    this.auth = `Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}`;
  }

  async query(promql: string): Promise<PromSample[]> {
    const body = await this.call('/api/v1/query', { query: promql });
    return (body.data?.result ?? []).flatMap((r) => {
      const value = r.value?.[1];
      if (value === undefined) return [];
      const n = Number(value);
      return Number.isFinite(n) ? [{ labels: r.metric ?? {}, value: n }] : [];
    });
  }

  async queryRange(
    promql: string,
    start: Date,
    end: Date,
    stepSeconds: number,
  ): Promise<PromSeries[]> {
    const body = await this.call('/api/v1/query_range', {
      query: promql,
      start: String(Math.floor(start.getTime() / 1000)),
      end: String(Math.floor(end.getTime() / 1000)),
      step: String(stepSeconds),
    });
    return (body.data?.result ?? []).map((r) => ({
      labels: r.metric ?? {},
      points: (r.values ?? []).flatMap(([t, v]) => {
        const n = Number(v);
        // Prometheus renders a gap as `NaN`. A gap is not a zero, and charting
        // it as one invents a dip that never happened.
        return Number.isFinite(n) ? [{ t: t * 1000, v: n }] : [];
      }),
    }));
  }

  private async call(path: string, params: Record<string, string>): Promise<PromResponse> {
    return withResilience(RESILIENCE, async (signal) => {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        signal,
        headers: {
          authorization: this.auth,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // POST, not GET: a 30-day range query is long enough to meet a URL
        // length limit at a proxy, and a query in a URL is a query in an
        // access log.
        body: new URLSearchParams(params).toString(),
      });

      if (!res.ok) {
        // Four words, chosen before the body is read, because the body quotes
        // the query back — and the query names internal series.
        const reason =
          res.status === 401 || res.status === 403
            ? 'unauthorized'
            : res.status === 400 || res.status === 422
              ? 'bad_request'
              : 'upstream';
        throw new MetricsQueryError(reason);
      }

      let body: PromResponse;
      try {
        body = (await res.json()) as PromResponse;
      } catch (err) {
        throw new MetricsQueryError('malformed', err);
      }
      // A 200 carrying `status: "error"` is how Prometheus reports a query it
      // parsed but could not run. Treating it as success returns an empty
      // dashboard that looks like "no traffic".
      if (body.status !== 'success') throw new MetricsQueryError('malformed');
      return body;
    });
  }
}
