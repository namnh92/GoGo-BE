import { secondsSince, type MetricsPort } from './metrics';

/**
 * #414 — request-level telemetry for the infrastructure this process talks
 * to (Redis, Postgres), on the same two series whatever the client library:
 *
 * - `provider_requests_total{provider, service, operation, status}`
 * - `provider_request_duration_seconds{provider, service, operation, status}`
 *
 * The three ids are the cost registry's (`@gogo/cost-observability`), so a
 * `/monitoring` row and a Prometheus series name the same thing. They are the
 * only label values: never a key, a channel, a table, a SQL text or an error
 * message (see `metric-labels.ts` for why). `status` is `ok | error` — an
 * INCR or a SELECT has no HTTP code, and a closed pair is what a rate() can
 * ask about.
 *
 * Runtime telemetry is not a cost meter (epic §8): nothing here feeds the
 * usage ledger, and a collector still reads the bill from the provider.
 */
export type RuntimeOperation = {
  /** Registry provider id — `upstash`, `neon`. */
  provider: string;
  /** Registry service id — `upstash.redis`, `neon.postgres`. */
  service: string;
  /** Registry operation id — `upstash.redis.rate_limit.hit`. */
  operation: string;
};

export type RuntimeCallStatus = 'ok' | 'error';

/** One finished call: a count and a duration, on the same labels. */
export function recordRuntimeCall(
  metrics: MetricsPort,
  op: RuntimeOperation,
  status: RuntimeCallStatus,
  startedAtMs: number,
): void {
  metrics.increment('provider_requests_total', {
    provider: op.provider,
    service: op.service,
    operation: op.operation,
    status,
  });
  metrics.observe('provider_request_duration_seconds', secondsSince(startedAtMs), {
    provider: op.provider,
    service: op.service,
    operation: op.operation,
    status,
  });
}

/**
 * Times `fn` as one operation. A rejection is recorded as `error` and
 * rethrown untouched — the caller's fallback (a fail-open rate limiter, a
 * cached revocation answer) sees exactly what it saw before.
 */
export async function meterRuntimeCall<T>(
  metrics: MetricsPort,
  op: RuntimeOperation,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    recordRuntimeCall(metrics, op, 'ok', started);
    return result;
  } catch (err) {
    recordRuntimeCall(metrics, op, 'error', started);
    throw err;
  }
}
