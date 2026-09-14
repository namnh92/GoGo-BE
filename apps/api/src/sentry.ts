import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/node';
import { redactCoordinatesDeep } from '@gogo/observability';

/**
 * #588 — the only way this API initialises Sentry, and the protection boundary
 * for exact positions in error events.
 *
 * Structural limits (nothing to pattern-match, so nothing to miss):
 *
 * - Incoming request bodies are never captured: the `Http` integration is
 *   replaced by one with `maxIncomingRequestBodySize: 'none'`, and
 *   {@link sanitizeRequest} drops `request.data` anyway. Room constraints
 *   (`originLat`/`originLng`), CMS place edits (`lat`/`lng`), Google Maps link
 *   imports (`url` with `@lat,lng`) and any CSV or JSON body stay out.
 * - The request keeps only `url`, `method`, `query_string` and the headers in
 *   {@link SENTRY_REQUEST_HEADERS}; `referer`, `origin`, cookies, `env` and IP
 *   are dropped. `sendDefaultPii` stays off.
 *
 * Pattern limits (text an operator needs): the URL and query string, exception
 * values, breadcrumbs and the remaining event go through
 * `redactCoordinatesDeep` — see `libs/observability/src/telemetry-redaction.ts`
 * for exactly what it matches.
 *
 * Also relied on, and pinned by `sentry-usage.spec.ts`: no code outside this
 * file and the global exception filter calls the Sentry API, the filter attaches
 * only `request_id`, tracing is off, `includeLocalVariables` is unset, and the
 * worker process does not initialise Sentry.
 */

export const SENTRY_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'content-length',
  'content-type',
  'user-agent',
  'x-request-id',
]);

type WithRequest = Pick<ErrorEvent, 'request'>;
type TransactionEvent = Parameters<NonNullable<NodeOptions['beforeSendTransaction']>>[0];

/** A copy of `event` whose request keeps only the allowlisted fields and headers. */
export function sanitizeRequest<T extends WithRequest>(event: T): T {
  const request = event.request;
  if (!request) return event;
  const headers = request.headers
    ? Object.fromEntries(
        Object.entries(request.headers).filter(([name]) =>
          SENTRY_REQUEST_HEADERS.has(name.toLowerCase()),
        ),
      )
    : undefined;
  return {
    ...event,
    request: {
      ...(request.url !== undefined ? { url: request.url } : {}),
      ...(request.method !== undefined ? { method: request.method } : {}),
      ...(request.query_string !== undefined ? { query_string: request.query_string } : {}),
      ...(headers ? { headers } : {}),
    },
  };
}

export function sentryInitOptions(opts: { dsn: string; environment: string }): NodeOptions {
  return {
    dsn: opts.dsn,
    environment: opts.environment,
    sendDefaultPii: false,
    // Same name as the default `Http` integration, so this instance replaces it.
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
    beforeSend: (event: ErrorEvent) => redactCoordinatesDeep(sanitizeRequest(event)),
    beforeSendTransaction: (event: TransactionEvent) =>
      redactCoordinatesDeep(sanitizeRequest(event)),
    beforeBreadcrumb: (breadcrumb: Breadcrumb) => redactCoordinatesDeep(breadcrumb),
  };
}
