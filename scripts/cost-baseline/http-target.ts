/**
 * PR3 / COST-BE-003 (#336) — the one thing a scenario needs: a way to call the
 * API and be told how long it took.
 *
 * Two implementations, one interface, because the baseline has to run in two
 * places that cannot share a transport: `app.inject()` inside the integration
 * harness (no socket, no port, deterministic) and `fetch` against a deployed
 * DEV API. The scenarios must not know which — a scenario that branched on the
 * transport would stop being the same experiment.
 *
 * Latency is recorded here rather than derived from a server-side histogram
 * because there is no server-side HTTP histogram: `metric-labels.ts` has a
 * provider duration and no API duration. So this is client-side wall clock,
 * and the artifact says so. Naming it as a limitation beats inventing a
 * number, and beats adding an unrelated metric to a measurement PR.
 */

export type ApiResponse = {
  status: number;
  body: unknown;
  /** Wall clock at the caller, milliseconds. */
  durationMs: number;
};

export type ApiRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  token?: string | undefined;
  payload?: unknown;
  /** Multipart body, already encoded, plus its boundary content-type. */
  raw?: { body: Buffer; contentType: string } | undefined;
  headers?: Record<string, string> | undefined;
};

export interface HttpTarget {
  request(req: ApiRequest): Promise<ApiResponse>;
}

/** Fastify's `inject` — the harness path. No socket, so no port to collide. */
export function injectTarget(instance: {
  inject(opts: Record<string, unknown>): Promise<{ statusCode: number; body: string }>;
}): HttpTarget {
  let ip = 0;
  return {
    async request(req) {
      const started = Date.now();
      const res = await instance.inject({
        method: req.method,
        url: req.url,
        // Rate limits are per IP and every scenario repeats one call ten to
        // twenty times. A baseline that tripped the limiter would be measuring
        // the limiter.
        remoteAddress: `10.90.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
        headers: {
          ...(req.token ? { authorization: `Bearer ${req.token}` } : {}),
          ...(req.raw ? { 'content-type': req.raw.contentType } : {}),
          ...req.headers,
        },
        ...(req.raw ? { payload: req.raw.body } : {}),
        ...(req.payload !== undefined ? { payload: req.payload } : {}),
      });
      return { status: res.statusCode, body: parse(res.body), durationMs: Date.now() - started };
    },
  };
}

/** A deployed API — the `live` path. */
export function fetchTarget(baseUrl: string): HttpTarget {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async request(req) {
      const started = Date.now();
      const res = await fetch(`${root}${req.url}`, {
        method: req.method,
        headers: {
          ...(req.token ? { authorization: `Bearer ${req.token}` } : {}),
          ...(req.raw
            ? { 'content-type': req.raw.contentType }
            : req.payload !== undefined
              ? { 'content-type': 'application/json' }
              : {}),
          ...req.headers,
        },
        ...(req.raw
          ? { body: new Uint8Array(req.raw.body) }
          : req.payload !== undefined
            ? { body: JSON.stringify(req.payload) }
            : {}),
      });
      const text = await res.text();
      return { status: res.status, body: parse(text), durationMs: Date.now() - started };
    },
  };
}

function parse(body: string): unknown {
  if (body === '') return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Percentile over the runner's own timings.
 *
 * Nearest-rank, not interpolated: with ten samples an interpolated p95 is a
 * weighted guess between the ninth and tenth, and saying "the 95th percentile
 * of ten requests" already stretches the word. `null` for an empty set — no
 * requests is not a fast response.
 */
export function percentile(samples: number[], q: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? null;
}
