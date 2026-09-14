/**
 * #588 — an exact position never leaves the process in telemetry.
 *
 * Security rule (.claude/rules/security.md): logs and error reports never carry
 * raw exact location. A device position reaches the API as query parameters
 * (`GET /v1/search?lat=&lng=`, `GET /v1/administrative/locate?lat=&lng=`) or as
 * body fields (`lat`, `lng`, `originLat`, `originLng`), and from there it is
 * copied into whatever telemetry copies the request: the URL, the query string,
 * a captured request body, an outgoing-request breadcrumb's `http.query`, or a
 * Drizzle query error whose message lists the bound parameters.
 *
 * Redaction is by *name*: a coordinate is the value of a coordinate-named key or
 * query parameter. Numbers are never guessed at. The one exception is Drizzle's
 * `params:` list, which carries values without names, so the whole list goes —
 * the query text beside it stays, since it holds placeholders, not values.
 */

export const REDACTED = '[redacted]';

const EXACT_COORDINATE_NAME = /^(?:lat|lng|lon|latitude|longitude)$/i;
/** `originLat`, `destinationLng` — camelCase, so `flat` or `plateau` never match. */
const CAMEL_COORDINATE_SUFFIX = /[a-z0-9](?:Lat|Lng|Lon|Latitude|Longitude)$/;
/** `origin_lat`, `ORIGIN_LNG`. */
const SNAKE_COORDINATE_SUFFIX = /_(?:lat|lng|lon|latitude|longitude)$/i;

export function isCoordinateKey(name: string): boolean {
  return (
    EXACT_COORDINATE_NAME.test(name) ||
    CAMEL_COORDINATE_SUFFIX.test(name) ||
    SNAKE_COORDINATE_SUFFIX.test(name)
  );
}

/**
 * `name=value` inside a URL, a bare query string (`q=cafe&lat=1`) or free text
 * (`Route GET:/v1/search?lat=1&lng=2 not found`). The value stops at the next
 * separator, whitespace or quote, so the text after a URL survives.
 */
const QUERY_PARAMETER = /(^|[?&;\s])([A-Za-z_][\w.-]*)=([^&#\s"'<>]*)/g;
/** `"lat": 10.77` or `"originLng":"106.7"` inside JSON text, e.g. a captured body. */
const JSON_MEMBER =
  /"([A-Za-z_]\w*)"(\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")/g;
/** Drizzle's `DrizzleQueryError` message: `Failed query: …\nparams: 106.7,10.7`. */
const DRIZZLE_PARAMS = /(\bparams:[ \t]*)[^\n]*/g;

export function redactCoordinateText(text: string): string {
  return text
    .replace(QUERY_PARAMETER, (match, lead: string, name: string) =>
      isCoordinateKey(name) ? `${lead}${name}=${REDACTED}` : match,
    )
    .replace(JSON_MEMBER, (match, name: string, colon: string) =>
      isCoordinateKey(name) ? `"${name}"${colon}"${REDACTED}"` : match,
    )
    .replace(DRIZZLE_PARAMS, `$1${REDACTED}`);
}

/**
 * Keys never walked: `sdkProcessingMetadata` holds live SDK objects (scopes,
 * spans) that Sentry strips before sending and still needs intact afterwards.
 */
const OPAQUE_KEYS = new Set(['sdkProcessingMetadata']);
const MAX_DEPTH = 24;

/**
 * A copy of `value` with every coordinate redacted: coordinate-named keys with
 * a primitive value, `[name, value]` pairs, and every string through
 * {@link redactCoordinateText}. Plain data only — class instances come back as
 * plain objects, which is what a telemetry payload is.
 */
export function redactCoordinatesDeep<T>(value: T): T {
  return walk(value, new WeakSet<object>(), 0) as T;
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactCoordinateText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && isCoordinateKey(value[0])) {
      return [value[0], REDACTED];
    }
    return value.map((item) => walk(item, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(key)) out[key] = inner;
    else if (isCoordinateKey(key) && (inner === null || typeof inner !== 'object')) {
      out[key] = inner === null || inner === undefined ? inner : REDACTED;
    } else out[key] = walk(inner, seen, depth + 1);
  }
  return out;
}
