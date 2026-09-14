import type { NodeOptions } from '@sentry/node';
import { redactCoordinatesDeep } from '@gogo/observability';

/**
 * #588 — the only way this API initialises Sentry.
 *
 * With no extra configuration `@sentry/node` 10 attaches, to every error event,
 * the request's absolute URL and raw `query_string` (`requestDataIntegration`),
 * request headers such as `referer`, an incoming request body of up to 10 kB
 * (`httpServerIntegration`, `maxRequestBodySize: 'medium'`), outgoing-request
 * breadcrumbs whose `http.query` keeps the raw query, and console breadcrumbs.
 * `GET /v1/search` and `GET /v1/administrative/locate` carry the device position
 * in the query, room constraints carry `originLat`/`originLng` in the body, and a
 * failed query's `DrizzleQueryError` message lists its bound parameters. Every
 * one of those would reach Sentry as an exact position.
 *
 * Each hook runs the payload through the same redaction the request log uses,
 * so method, path, status, other parameters, `request_id`, exception type and
 * stack all survive — only coordinate values do not.
 */
export function sentryInitOptions(opts: { dsn: string; environment: string }): NodeOptions {
  return {
    dsn: opts.dsn,
    environment: opts.environment,
    beforeSend: (event) => redactCoordinatesDeep(event),
    beforeSendTransaction: (event) => redactCoordinatesDeep(event),
    beforeBreadcrumb: (breadcrumb) => redactCoordinatesDeep(breadcrumb),
  };
}
