/**
 * #588 — an exact position never leaves the process in telemetry text.
 *
 * Security rule (.claude/rules/security.md): logs and error reports never carry
 * raw exact location. This module is the *pattern* half of that boundary. The
 * *structural* half lives where the telemetry is assembled: Sentry never
 * captures request bodies and keeps only allowlisted request fields and headers
 * (`apps/api/src/sentry.ts`); the request log keeps only method, URL, host and
 * remote address (`logger.ts`). What remains to scan is text the operator needs:
 * URLs and query strings, exception messages, breadcrumb messages and data.
 *
 * What this module redacts, and nothing else:
 *
 * - by name: the value of a coordinate-named key or query parameter (`lat`,
 *   `lng`, `lon`, `latitude`, `longitude`, camelCase `…Lat`/`…Lng`, snake_case
 *   `…_lat`/`…_lng`), and the whole value of a key that holds positions in any
 *   shape (`coordinates`, `bbox`, `bounds`, `viewport`, `latlng`, `ll`, `geom`,
 *   `geometry`, `point`), in URLs, query strings, free text, JSON text, objects
 *   and `[name, value]` pairs;
 * - by shape: a decimal coordinate pair with at least three decimals on both
 *   sides separated by `,` or `%2C` (Google Maps `@lat,lng`, `q=lat,lng`, CSV
 *   cells), Google Maps data parameters `!3d…!4d…`, WKT/EWKT geometries
 *   (`POINT(…)`, `SRID=4326;POLYGON((…))`, to the end of the line when cut
 *   off), Drizzle's unnamed `params:` list, and PostgreSQL row echoes
 *   (`Failing row contains (…)`, `Key (…)=(…)`).
 *
 * Not redacted: a lone number with no coordinate name and no partner (`10.77`
 * in free text), and pairs coarser than three decimals (about 110 m).
 *
 * Cost: every pattern and scanner here is linear in the input; the performance
 * test in `telemetry-redaction.spec.ts` feeds 100 kB adversarial strings.
 */

export const REDACTED = '[redacted]';

const EXACT_COORDINATE_NAME = /^(?:lat|lng|lon|latitude|longitude)$/i;
/** `originLat`, `destinationLng` — camelCase, so `flat` or `plateau` never match. */
const CAMEL_COORDINATE_SUFFIX = /[a-z0-9](?:Lat|Lng|Lon|Latitude|Longitude)$/;
/** `origin_lat`, `ORIGIN_LNG`. */
const SNAKE_COORDINATE_SUFFIX = /_(?:lat|lng|lon|latitude|longitude)$/i;
/** Keys whose whole value is a position or a set of positions, whatever its shape. */
const COORDINATE_CONTAINER_NAME =
  /^(?:coordinates|bbox|bounds|viewport|latlng|ll|geom|geometry|point)$/i;

export function isCoordinateKey(name: string): boolean {
  return (
    EXACT_COORDINATE_NAME.test(name) ||
    CAMEL_COORDINATE_SUFFIX.test(name) ||
    SNAKE_COORDINATE_SUFFIX.test(name)
  );
}

export function isCoordinateContainerKey(name: string): boolean {
  return COORDINATE_CONTAINER_NAME.test(name);
}

function isRedactedName(name: string): boolean {
  return isCoordinateKey(name) || isCoordinateContainerKey(name);
}

/**
 * `name=value` inside a URL, a bare query string (`q=cafe&lat=1`) or free text
 * (`Route GET:/v1/search?lat=1&lng=2 not found`). The value stops at the next
 * separator, whitespace or quote, so the text after a URL survives.
 */
const QUERY_PARAMETER = /(^|[?&;\s])([A-Za-z_][\w.-]*)=([^&#\s"'<>]*)/g;
/** `"lat": 10.77` or `"originLng":"106.7"` inside JSON text, e.g. a message. */
const JSON_MEMBER =
  /"([A-Za-z_]\w*)"(\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")/g;
/** A JSON key followed by its colon; the value is measured by {@link jsonValueEnd}. */
const JSON_KEY = /"([A-Za-z_]\w*)"\s*:\s*/g;
/** Drizzle's `DrizzleQueryError` message: `Failed query: …\nparams: 106.7,10.7`. */
const DRIZZLE_PARAMS = /(\bparams:[ \t]*)[^\n]*/g;
/**
 * The head of a WKT/EWKT geometry up to its opening parenthesis: `POINT(`,
 * `SRID=4326;POINT Z (`, `MULTIPOLYGON(`. Every quantifier is bounded, so a
 * failed attempt costs a constant; the parenthesised body is measured by
 * {@link balancedEnd}, which is linear. (An unbounded `\s*(?:ZM|Z|M)?\s*` took
 * 16 s on 100 kB of spaces after `POINT`.)
 */
const WKT_HEAD =
  /\b(?:SRID=\d{1,10};[ \t]{0,8})?(?:MULTI)?(?:POINT|LINESTRING|POLYGON|GEOMETRYCOLLECTION)(?:[ \t]{0,8}(?:ZM|Z|M))?[ \t]{0,8}\(/gi;
/** Google Maps data parameters: `…!8m2!3d10.7769!4d106.7009`. */
const MAPS_DATA_POSITION = /!3d-?\d+(?:\.\d+)?!4d-?\d+(?:\.\d+)?/g;
/**
 * `10.776912,106.700981`, `@10.7769,106.7009,17z`, `%4010.7769%2C106.7009` — an
 * encoded `@` ends in a digit, so it is allowed explicitly before the pair.
 */
const COORDINATE_PAIR =
  /(?:(?<=%40)|(?<![\w.]))-?\d{1,3}\.\d{3,}\s*(?:,|%2C)\s*-?\d{1,3}\.\d{3,}(?![\w.])/gi;
/** PostgreSQL detail for a NOT NULL/CHECK violation echoes the whole row. */
const PG_FAILING_ROW = /(\bFailing row contains )\([^\n]*/g;
/** PostgreSQL detail for a unique/foreign-key violation: `Key (cols)=(values)`. */
const PG_KEY_HEAD = /\bKey \(/g;

export function redactCoordinateText(text: string): string {
  const named = redactJsonContainers(text)
    .replace(QUERY_PARAMETER, (match, lead: string, name: string) =>
      isRedactedName(name) ? `${lead}${name}=${REDACTED}` : match,
    )
    .replace(JSON_MEMBER, (match, name: string, colon: string) =>
      isCoordinateKey(name) ? `"${name}"${colon}"${REDACTED}"` : match,
    )
    .replace(DRIZZLE_PARAMS, `$1${REDACTED}`)
    .replace(MAPS_DATA_POSITION, `!3d${REDACTED}!4d${REDACTED}`)
    .replace(COORDINATE_PAIR, REDACTED)
    .replace(PG_FAILING_ROW, `$1(${REDACTED})`);
  return redactPgKeyValues(redactWktGeometries(named));
}

/**
 * The index just past the `)` that closes the `(` at `open`, or `-1` when the
 * line ends first. One pass over the characters, so linear.
 */
function balancedEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return -1;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline < 0 ? text.length : newline;
}

/**
 * `POINT(106.7 10.7)` → `POINT([redacted])`. A geometry cut off before its
 * closing parenthesis is redacted to the end of its line. The search resumes
 * after whatever was consumed, so the whole pass stays linear.
 */
function redactWktGeometries(text: string): string {
  let out = '';
  let last = 0;
  WKT_HEAD.lastIndex = 0;
  for (let match = WKT_HEAD.exec(text); match; match = WKT_HEAD.exec(text)) {
    const open = match.index + match[0].length - 1;
    const end = balancedEnd(text, open);
    const stop = end < 0 ? lineEnd(text, open) : end;
    out += `${text.slice(last, open)}(${REDACTED}${end < 0 ? '' : ')'}`;
    last = stop;
    WKT_HEAD.lastIndex = Math.max(stop, match.index + 1);
  }
  return out + text.slice(last);
}

/** `Key (lat, lng)=(10.7, 106.7)` → `Key (lat, lng)=([redacted])`, linearly. */
function redactPgKeyValues(text: string): string {
  let out = '';
  let last = 0;
  PG_KEY_HEAD.lastIndex = 0;
  for (let match = PG_KEY_HEAD.exec(text); match; match = PG_KEY_HEAD.exec(text)) {
    const columnsOpen = match.index + match[0].length - 1;
    const columnsEnd = balancedEnd(text, columnsOpen);
    if (columnsEnd < 0) {
      PG_KEY_HEAD.lastIndex = lineEnd(text, columnsOpen);
      continue;
    }
    if (text[columnsEnd] !== '=' || text[columnsEnd + 1] !== '(') {
      PG_KEY_HEAD.lastIndex = columnsEnd;
      continue;
    }
    const valuesOpen = columnsEnd + 1;
    const valuesEnd = balancedEnd(text, valuesOpen);
    const stop = valuesEnd < 0 ? lineEnd(text, valuesOpen) : valuesEnd;
    out += `${text.slice(last, valuesOpen)}(${REDACTED}${valuesEnd < 0 ? '' : ')'}`;
    last = stop;
    PG_KEY_HEAD.lastIndex = Math.max(stop, match.index + 1);
  }
  return out + text.slice(last);
}

/** `"coordinates": [[106.7, 10.7], …]` and `"bounds": {…}` in JSON text, whole value. */
function redactJsonContainers(text: string): string {
  let out = '';
  let last = 0;
  JSON_KEY.lastIndex = 0;
  for (let match = JSON_KEY.exec(text); match; match = JSON_KEY.exec(text)) {
    if (!isCoordinateContainerKey(match[1] ?? '')) continue;
    const start = match.index + match[0].length;
    const end = jsonValueEnd(text, start);
    if (end <= start) continue;
    out += `${text.slice(last, start)}"${REDACTED}"`;
    last = end;
    JSON_KEY.lastIndex = end;
  }
  return out + text.slice(last);
}

/**
 * The index just past the JSON value starting at `start`. An unterminated array,
 * object or string (a truncated body inside a message) runs to the end of the
 * text, so a cut-off coordinate list is still redacted.
 */
function jsonValueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '[' || first === '{') {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  if (first === '"') {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    return text.length;
  }
  const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(start, start + 64));
  return number ? start + number[0].length : start;
}

/**
 * Keys never walked: `sdkProcessingMetadata` holds live SDK objects (scopes,
 * spans) that Sentry strips before sending and still needs intact afterwards.
 */
const OPAQUE_KEYS = new Set(['sdkProcessingMetadata']);
const MAX_DEPTH = 24;

/**
 * A copy of `value` with every coordinate redacted: coordinate-named keys with a
 * primitive value, container keys whatever their value, `[name, value]` pairs,
 * and every string through {@link redactCoordinateText}. Plain data only —
 * class instances come back as plain objects, which is what a telemetry payload
 * is.
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
    if (value.length === 2 && typeof value[0] === 'string' && isRedactedName(value[0])) {
      return [value[0], REDACTED];
    }
    return value.map((item) => walk(item, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(key)) out[key] = inner;
    else if (isCoordinateContainerKey(key)) {
      out[key] = inner === null || inner === undefined ? inner : REDACTED;
    } else if (isCoordinateKey(key) && (inner === null || typeof inner !== 'object')) {
      out[key] = inner === null || inner === undefined ? inner : REDACTED;
    } else out[key] = walk(inner, seen, depth + 1);
  }
  return out;
}
