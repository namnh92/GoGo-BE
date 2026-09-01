import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  LogMetrics,
  MetricsRegistry,
  TeeMetrics,
  type AppLogger,
  type MetricsPort,
} from '@gogo/observability';

/**
 * #318 — the worker's own scrape surface.
 *
 * `apps/api` has had a `MetricsRegistry` behind `/v1/metrics` since #120. The
 * worker had only `LogMetrics`, so every series it produced existed in the log
 * stream and nowhere a collector could reach.
 *
 * That is not a small subset. The worker is where the heavy work runs — bulk
 * import chunks process here, not in the API process — so the invisible half
 * included every `place_import_*` counter, `place_resolve_duration_ms`, the
 * outbox and campaign counters, and, worst of all,
 * `places_provider_cost_units` for the Google calls bulk import makes. A cost
 * dashboard built on the API scrape alone would have under-reported Google
 * spend by its largest component, which is worse than reporting nothing:
 * it looks like an answer.
 *
 * The endpoint is deliberately not the API's. Two processes, two registries,
 * two scrape targets — that is how Prometheus expects to see them, and it is
 * what lets `instance` tell a slow import apart from a slow request.
 */

export const DEFAULT_WORKER_METRICS_PORT = 9101;

/**
 * Both sinks, exactly as `apps/api` wires them: the log line stays the record
 * any aggregator can read, and the registry is what a scraper reads. Losing
 * one must not lose the other.
 */
export function createWorkerMetrics(logger: AppLogger): {
  metrics: MetricsPort;
  registry: MetricsRegistry;
} {
  const registry = new MetricsRegistry();
  return { metrics: new TeeMetrics([new LogMetrics(logger), registry]), registry };
}

export type MetricsEndpoint = { port: number; close: () => Promise<void> };

export function workerMetricsPort(raw = process.env.WORKER_METRICS_PORT): number {
  if (raw === undefined || raw === '') return DEFAULT_WORKER_METRICS_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`WORKER_METRICS_PORT must be a port number, received "${raw}"`);
  }
  return value;
}

/**
 * Serve `GET /metrics` for a collector on the same private network.
 *
 * **Never resolves to a rejected promise, and never throws.** A worker that
 * cannot bind its metrics port is a worker with no metrics; a worker that dies
 * because it could not bind its metrics port is an outage caused by the thing
 * that was supposed to observe one. Every failure path here logs and returns
 * `null`, and the ticks carry on.
 *
 * Not published in `docker-compose.prod.yml`, so it is reachable only from
 * inside the compose network — the token is the second lock, not the first.
 */
export function startMetricsEndpoint(opts: {
  registry: MetricsRegistry;
  token: string | undefined;
  logger: AppLogger;
  port?: number;
  /**
   * `0.0.0.0` because the collector is a sibling container and a loopback bind
   * would be unreachable from it. Confinement comes from the port not being
   * published, not from the bind address.
   */
  host?: string;
}): Promise<MetricsEndpoint | null> {
  const { registry, token, logger } = opts;
  const host = opts.host ?? '0.0.0.0';
  let port: number;
  try {
    port = opts.port ?? workerMetricsPort();
  } catch (err) {
    logger.error({ err }, 'worker metrics endpoint not started: bad port configuration');
    return Promise.resolve(null);
  }

  const server = http.createServer((req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET' || (path !== '/metrics' && path !== '/')) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
        return;
      }
      // Same rule as the API route: with no token configured the endpoint does
      // not advertise that it exists and is merely locked.
      if (!token) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
        return;
      }
      const header = req.headers.authorization;
      const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
      if (!constantTimeEquals(presented, token)) {
        // No body. The series names describe internal structure and a 401 that
        // echoed them would defeat the token.
        res.writeHead(401, { 'content-type': 'text/plain' }).end();
        return;
      }
      res
        .writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end(registry.render());
    } catch (err) {
      logger.error({ err }, 'worker metrics scrape failed');
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  return new Promise<MetricsEndpoint | null>((resolve) => {
    const giveUp = (err: unknown) => {
      logger.error({ err, port, host }, 'worker metrics endpoint unavailable — ticks continue');
      server.removeAllListeners('error');
      server.close();
      resolve(null);
    };
    server.once('error', giveUp);
    try {
      server.listen(port, host, () => {
        server.removeListener('error', giveUp);
        // A later error — a socket fault mid-scrape — must not take the
        // process with it either.
        server.on('error', (err) => logger.error({ err }, 'worker metrics endpoint error'));
        // What the OS actually gave us. With `port: 0` the requested number is
        // not the listening one, and a caller told 0 cannot reach it.
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        logger.info({ port: bound, host }, 'worker metrics endpoint listening');
        resolve({
          port: bound,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
              // Sockets a collector left open must not hold shutdown; the
              // registry is in memory and there is nothing to flush.
              server.closeAllConnections?.();
            }),
        });
      });
    } catch (err) {
      // `listen` validates the port synchronously and throws a RangeError
      // rather than emitting `error`, so the handler above never sees it.
      giveUp(err);
    }
  });
}

/** Length first: `timingSafeEqual` throws when the buffers differ in size. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
