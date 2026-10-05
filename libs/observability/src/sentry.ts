import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/node';
import { redactCoordinatesDeep } from './telemetry-redaction';

type Integration = ReturnType<typeof Sentry.getDefaultIntegrations>[number];

/**
 * #588 — the only way the API and the worker initialise Sentry, and the
 * protection boundary for exact positions in error events. Lives in this lib
 * since BE#675 so both processes build the same options from one place.
 *
 * Structural limits (nothing to pattern-match, so nothing to miss):
 *
 * - Incoming request bodies are never captured. The SDK's default list is not
 *   used (`defaultIntegrations: false`); {@link sentryIntegrations} builds the
 *   list from it, drops every `Http`/`Http.*` integration, and adds exactly one
 *   `Http` integration with `maxIncomingRequestBodySize: 'none'`. That does not
 *   depend on the SDK merging same-named integrations, and
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
 * for exactly what it matches. HTTP breadcrumbs to a caller's `secretUrls`
 * (the worker's heartbeat pings, BE#675 F-03) keep only the origin.
 *
 * Also relied on, and pinned by `apps/api/src/sentry-usage.spec.ts`: no code
 * outside this file, the API's `main.ts` and global exception filter, and the
 * worker's `apps/worker/src/sentry.ts` calls the Sentry API; the filter attaches
 * only `request_id`, the worker only the periodic job name; tracing is off and
 * `includeLocalVariables` is unset.
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

/** `Http` and anything the SDK nests under it (`Http.Server`, …) — the integrations that can read a body. */
export const HTTP_INTEGRATION_NAME = /^Http(?:$|\.)/;

/**
 * BE#675 — what the SDK does with an unhandled promise rejection. The default,
 * `warn`, captures and logs, and the process keeps running; the API keeps it.
 * `none` captures only: the worker ends the process itself
 * (`apps/worker/src/sentry.ts`), because the SDK's own `strict` exit is skipped
 * for the names it ignores (`AbortError` in 10.71), and a worker Node would
 * have crashed must still crash for its restart policy to recover it.
 */
export type UnhandledRejectionMode = 'warn' | 'none';

const REDACTED = '[redacted]';

/** `origin + pathname` of each parseable URL — what the SDK's breadcrumb `url` keeps. */
function urlPrefixes(urls: readonly (string | undefined)[]): string[] {
  return urls.flatMap((raw) => {
    if (!raw) return [];
    try {
      const url = new URL(raw);
      return [`${url.origin}${url.pathname}`];
    } catch {
      return [];
    }
  });
}

/**
 * BE#675 F-03 — an HTTP breadcrumb to a URL whose path is itself a credential
 * (a heartbeat ping) keeps only the origin. Matched by prefix on the URL the
 * SDK records, which has the query and userinfo already stripped; query and
 * fragment, recorded separately, are dropped.
 */
export function redactSecretUrlBreadcrumb(
  breadcrumb: Breadcrumb,
  prefixes: readonly string[],
): Breadcrumb {
  const url = breadcrumb.data?.url;
  if (breadcrumb.category !== 'http' || typeof url !== 'string') return breadcrumb;
  const match = prefixes.find((prefix) => url.startsWith(prefix));
  if (!match) return breadcrumb;
  const { 'http.query': _query, 'http.fragment': _fragment, ...data } = breadcrumb.data ?? {};
  return { ...breadcrumb, data: { ...data, url: `${new URL(match).origin}/${REDACTED}` } };
}

/**
 * The SDK's default integrations with every HTTP integration removed, plus one
 * HTTP integration that never captures an incoming body. Tracing is off, so the
 * defaults are computed without span options. With `none`, the default
 * rejection handler is replaced in place by a capture-only one.
 */
export function sentryIntegrations(
  opts: { unhandledRejection?: UnhandledRejectionMode } = {},
): Integration[] {
  const defaults = Sentry.getDefaultIntegrations({})
    .filter((integration) => !HTTP_INTEGRATION_NAME.test(integration.name))
    .map((integration) =>
      opts.unhandledRejection === 'none' && integration.name === 'OnUnhandledRejection'
        ? Sentry.onUnhandledRejectionIntegration({ mode: 'none' })
        : integration,
    );
  return [...defaults, Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })];
}

export function sentryInitOptions(opts: {
  dsn: string;
  environment: string;
  unhandledRejection?: UnhandledRejectionMode;
  /** URLs whose path is a credential; empty and unparseable entries are ignored (F-03). */
  secretUrls?: readonly (string | undefined)[];
}): NodeOptions {
  const secretPrefixes = urlPrefixes(opts.secretUrls ?? []);
  return {
    dsn: opts.dsn,
    environment: opts.environment,
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: sentryIntegrations(
      opts.unhandledRejection ? { unhandledRejection: opts.unhandledRejection } : {},
    ),
    beforeSend: (event: ErrorEvent) => redactCoordinatesDeep(sanitizeRequest(event)),
    beforeSendTransaction: (event: TransactionEvent) =>
      redactCoordinatesDeep(sanitizeRequest(event)),
    beforeBreadcrumb: (breadcrumb: Breadcrumb) =>
      redactCoordinatesDeep(redactSecretUrlBreadcrumb(breadcrumb, secretPrefixes)),
  };
}
