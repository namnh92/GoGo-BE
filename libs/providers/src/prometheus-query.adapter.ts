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
 * A plain Prometheus HTTP API client, and nothing else. Both stores this has
 * pointed at speak it — Grafana Cloud through Mimir, and the self-hosted
 * Prometheus of ADR-0007 directly — which is the point of ADR-0004's adapter
 * rule: the CMS never learns which vendor holds the samples, and swapping one
 * for another is a binding change. Nothing in this file names a vendor's
 * hostname, and nothing in it may start to.
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
  name: 'metrics.query',
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
  /** Prometheus-compatible endpoint; the query API is derived from it. */
  url: string;
  /**
   * Basic-auth credentials, both or neither. Optional because authentication
   * is a property of the deployment, not of the protocol: Grafana Cloud
   * requires it, a Prometheus reachable only from one address on a LAN does
   * not. Absent credentials send no `authorization` header — they never send
   * an empty one, which reads to a server as a malformed attempt rather than
   * as no attempt.
   */
  username?: string | undefined;
  token?: string | undefined;
};

/**
 * The deploy stores the collector's *write* endpoint, because that is what the
 * collector needs and one parameter is better than two that can disagree. The
 * query API is its sibling, so it is derived rather than stored:
 *
 *   https://…/api/prom/push          ->  https://…/api/prom
 *   http://192.168.68.168:9090/api/v1/write  ->  http://192.168.68.168:9090
 *   http://192.168.68.168:9090       ->  http://192.168.68.168:9090
 *
 * **Derived from the URL's shape, never from its hostname.** An earlier version
 * appended `/api/prom` to any host that did not contain `.grafana.net`, which
 * put one vendor's domain into shared code and made the store's identity a
 * string match. ADR-0006 and ADR-0013 both rest on the opposite property —
 * "swapping the store is a binding change, not a rewrite" — and a hostname test
 * is what turns that into a rewrite.
 *
 * Two suffixes are recognised because two remote-write conventions exist:
 * Prometheus' own `/api/v1/write`, and the `<base>/push` that Mimir and Cortex
 * publish (Grafana Cloud runs Mimir). Anything else is already a query root and
 * is passed through untouched — so an operator who pastes the query URL instead
 * of the write URL still gets a working deployment, and one who pastes a bare
 * Mimir host must write the `/api/prom` they mean rather than have it guessed.
 */
export function promApiBase(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (trimmed.endsWith('/api/v1/write')) {
    return trimmed.slice(0, -'/api/v1/write'.length);
  }
  if (trimmed.endsWith('/push')) {
    return trimmed.slice(0, -'/push'.length);
  }
  return trimmed;
}

/** The environment variables that can name a metrics store, neutral and legacy. */
export type MetricsQueryEnv = {
  METRICS_QUERY_URL?: string | undefined;
  METRICS_QUERY_USERNAME?: string | undefined;
  METRICS_QUERY_TOKEN?: string | undefined;
  PROMETHEUS_REMOTE_WRITE_URL?: string | undefined;
  GRAFANA_PROM_URL?: string | undefined;
  GRAFANA_PROM_USER?: string | undefined;
  GRAFANA_READ_TOKEN?: string | undefined;
};

/**
 * Which store the read path talks to — **the enforcement of ADR-0007 §E7**.
 *
 * §E7 forbids two states, and the dangerous one is quiet: the collector writing
 * to the self-hosted Prometheus while the API still queries Grafana Cloud. The
 * monitoring screen then reports healthy and shows nothing, which is the exact
 * shape `unknown != zero` exists to prevent. Prose cannot prevent it, because
 * the two halves are two environment variables and nothing stops an operator
 * setting one.
 *
 * So the read path *follows the write path by construction*:
 *
 * 1. `METRICS_QUERY_URL` — an explicit query endpoint always wins. This is the
 *    escape hatch for a deployment whose read and write endpoints genuinely
 *    differ (a read replica, a proxy), and the operator is stating it on
 *    purpose.
 * 2. **`PROMETHEUS_REMOTE_WRITE_URL` — where the collector writes is where the
 *    API reads.** Setting the write endpoint moves both halves in one action;
 *    the split-brain state cannot be reached by forgetting a variable, only by
 *    deliberately overriding rule 1.
 * 3. `GRAFANA_PROM_URL` + its two credentials — the legacy Cloud path, kept
 *    working *unchanged* for the whole rollback window (§E7 again: the Cloud
 *    credentials stay valid and are revoked last).
 * 4. Nothing configured — `null`, and the ops endpoints answer
 *    `backend.status: "unavailable"`. Never a fake: a fake answers a dashboard
 *    with invented traffic.
 *
 * Under rule 2 authentication is optional, and its absence is a deployment
 * decision recorded in GoGo-Infra INF-066, not an oversight here.
 */
export function resolveMetricsQueryConfig(env: MetricsQueryEnv): PrometheusQueryConfig | null {
  if (env.METRICS_QUERY_URL) {
    return {
      url: env.METRICS_QUERY_URL,
      username: env.METRICS_QUERY_USERNAME || undefined,
      token: env.METRICS_QUERY_TOKEN || undefined,
    };
  }
  if (env.PROMETHEUS_REMOTE_WRITE_URL) {
    return {
      url: env.PROMETHEUS_REMOTE_WRITE_URL,
      username: env.METRICS_QUERY_USERNAME || undefined,
      token: env.METRICS_QUERY_TOKEN || undefined,
    };
  }
  // The legacy path keeps its old gate exactly: Grafana Cloud rejects an
  // unauthenticated read, so a URL without both credentials is not a usable
  // store and binding it would trade "unavailable" for a 401 on every panel.
  if (env.GRAFANA_PROM_URL && env.GRAFANA_PROM_USER && env.GRAFANA_READ_TOKEN) {
    return {
      url: env.GRAFANA_PROM_URL,
      username: env.GRAFANA_PROM_USER,
      token: env.GRAFANA_READ_TOKEN,
    };
  }
  return null;
}

export class PrometheusQueryAdapter implements MetricsQueryPort {
  private readonly base: string;
  private readonly auth: string | null;

  constructor(config: PrometheusQueryConfig) {
    this.base = promApiBase(config.url);
    // Basic when credentials exist — on Grafana Cloud the username is the
    // numeric instance id and the password is the `metrics:read` token. The
    // token is never logged, never returned, and never leaves this process.
    // Both or neither: half a credential is a 401 that looks like an outage.
    this.auth =
      config.username && config.token
        ? `Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}`
        : null;
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
          ...(this.auth === null ? {} : { authorization: this.auth }),
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
