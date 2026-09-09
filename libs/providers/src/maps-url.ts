import { isIP } from 'node:net';

/**
 * PI-BE-003 / FR-INGEST-002 — Google Maps URL parsing with an SSRF-safe
 * redirect follower. Never scrapes HTML: it only extracts identifiers/hints
 * from the URL itself, then hands off to the provider adapter.
 */

const ALLOWED_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'google.com',
  'www.google.com.vn',
  'google.com.vn',
]);

export const MAX_REDIRECTS = 5;
export const REDIRECT_TIMEOUT_MS = 5_000;
/**
 * Ceiling on the whole walk, not just one hop (#505).
 *
 * Six hops at five seconds each is a thirty-second wait this code could sit in,
 * and nothing that works takes it: a real `maps.app.goo.gl` link answers its
 * one redirect in about a second. Meanwhile the mobile client gives up at
 * fifteen and retries, so every second past that is spent resolving a link
 * nobody is waiting for — and the retry pays for the Google search again.
 *
 * The hop cap and the per-hop timeout both stay; this only stops them
 * multiplying.
 */
export const MAX_EXPANSION_MS = 10_000;

export type UrlParseResult =
  | { ok: true; value: MapsUrlHints }
  | { ok: false; reasonCode: 'INVALID_URL' | 'HOST_NOT_ALLOWED' | 'UNSAFE_TARGET' };

/**
 * Google's feature id — the `0x<hex>:0x<hex>` pair that appears as `ftid=` on
 * an application share link and as `!1s…` inside a browser link's `data=`.
 *
 * The second half is the **CID**, the same number Google puts in the
 * `googleMapsUri` it returns from Place Details (`maps.google.com/?cid=…`). It
 * is therefore the one identifier a share link and a provider answer can be
 * compared on — but it is **not** a Places API Place ID and must never be sent
 * as one; there is no endpoint that looks a CID up.
 *
 * Carried as a decimal *string*. A CID is a full 64-bit value and
 * `0x974b8adb8575af98` is larger than `Number.MAX_SAFE_INTEGER`, so parsing it
 * as a number silently rounds — two different places would compare equal.
 */
export type MapsFeatureId = {
  /** As written in the URL, lower-cased: `0x…:0x…`. */
  hex: string;
  /** The CID half, in decimal. Compare with `cidFromGoogleMapsUri`. */
  cid: string;
};

export type MapsUrlHints = {
  /** Provider place id when the URL carries one outright. */
  providerPlaceId?: string;
  /** Free-text name/query extracted from /maps/place/<name> or ?q=. */
  query?: string;
  /**
   * Where the place **is**, when the URL says so outright: `!8m2!3d<lat>!4d<lng>`
   * inside `data=`, or a `?q=<lat>,<lng>` the user typed.
   *
   * Kept apart from the viewport below because the two are not the same claim
   * and were treated as one. `@21.0271386,105.7570553,15z` is where the map was
   * centred when the link was made — for Sheraton Hanoi West that is 1.07 km
   * from the hotel — and scoring a candidate's distance against it asks how far
   * the place is from the edge of somebody's screen.
   */
  placeLat?: number;
  placeLng?: number;
  /**
   * The map viewport centre from `@lat,lng,z`. Good enough to bias a search
   * towards the right city; never evidence of where a place stands.
   */
  viewportLat?: number;
  viewportLng?: number;
  /** `ftid=` or `data=!1s…` — see `MapsFeatureId`. */
  featureId?: MapsFeatureId;
  /** Short links must be expanded before hints are final. */
  needsExpansion: boolean;
  normalizedUrl: string;
};

/** `0x<hex>:0x<hex>` → hex + decimal CID, or null when it is not that shape. */
export function parseFeatureId(raw: string): MapsFeatureId | null {
  const m = /^0x([0-9a-f]{1,16}):0x([0-9a-f]{1,16})$/i.exec(raw.trim());
  if (!m) return null;
  // BigInt, not Number: a CID uses the full 64 bits and `parseInt` rounds
  // anything past 2^53, which would make two different places compare equal.
  return {
    hex: `0x${m[1]!.toLowerCase()}:0x${m[2]!.toLowerCase()}`,
    cid: BigInt(`0x${m[2]}`).toString(),
  };
}

/**
 * The CID out of a `googleMapsUri` as Place Details returns it
 * (`https://maps.google.com/?cid=10901959998421970840&…`), in decimal.
 *
 * `null` whenever Google did not put one there — which is an ordinary answer,
 * not a failure. A place with no comparable CID simply resolves the normal way.
 */
export function cidFromGoogleMapsUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  const cid = parsed.searchParams.get('cid');
  return cid !== null && /^\d{1,20}$/.test(cid) ? cid : null;
}

function isPrivateHost(host: string): boolean {
  // URL.hostname keeps IPv6 brackets — strip before any IP classification,
  // otherwise ::1 falls through to the allowlist branch as a plain name.
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    return true;
  }
  const v = isIP(h);
  if (v === 4) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      a >= 224
    );
  }
  if (v === 6) {
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  }
  return false;
}

/** Hostname allowlist — subdomain spoofs like `google.com.evil.tld` fail. */
export function isAllowedMapsHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host.toLowerCase().replace(/\.$/, ''));
}

export function parseMapsUrl(input: string): UrlParseResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reasonCode: 'INVALID_URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reasonCode: 'INVALID_URL' };
  }
  if (isPrivateHost(url.hostname)) return { ok: false, reasonCode: 'UNSAFE_TARGET' };
  if (!isAllowedMapsHost(url.hostname)) return { ok: false, reasonCode: 'HOST_NOT_ALLOWED' };

  const hints = extractHints(url);
  const isShort =
    url.hostname === 'maps.app.goo.gl' ||
    (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps'));
  return {
    ok: true,
    value: {
      ...hints,
      needsExpansion: isShort && !hints.providerPlaceId,
      normalizedUrl: url.toString(),
    },
  };
}

function extractHints(url: URL): Omit<MapsUrlHints, 'needsExpansion' | 'normalizedUrl'> {
  const out: Omit<MapsUrlHints, 'needsExpansion' | 'normalizedUrl'> = {};

  // `query_place_id` is what Google's own Maps URL format puts on the
  // `?api=1&query=…` share link — the shape the Share button produces for a
  // search result. Reading only `place_id` threw that id away and sent an
  // authoritative match down the fuzzy text-search path (#311).
  const placeId =
    url.searchParams.get('place_id') ??
    url.searchParams.get('placeid') ??
    url.searchParams.get('query_place_id');
  if (placeId && PLACE_ID_RE.test(placeId)) out.providerPlaceId = placeId;

  // /maps/place/<Name>/@lat,lng,z or ?q=<name>
  const nameMatch = /\/maps\/place\/([^/@]+)/.exec(url.pathname);
  if (nameMatch?.[1]) {
    out.query = decodeQuerySegment(nameMatch[1]);
  } else {
    const q = url.searchParams.get('q') ?? url.searchParams.get('query');
    if (q) {
      const trimmed = q.trim();
      // `?q=place_id:ChIJ…` — Google's own Maps URLs format. An id stated
      // outright, so it is read as one rather than searched for as text.
      const idInQuery = /^place_id:([\w-]{6,255})$/.exec(trimmed);
      const coord = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
      if (idInQuery && !out.providerPlaceId) {
        out.providerPlaceId = idInQuery[1]!;
      } else if (coord) {
        // A coordinate the user asked for *is* the place they mean.
        out.placeLat = Number(coord[1]);
        out.placeLng = Number(coord[2]);
      } else {
        out.query = trimmed;
      }
    }
  }

  const featureId = readFeatureId(url);
  if (featureId) out.featureId = featureId;

  const place = readPlaceCoordinate(url);
  if (place) {
    out.placeLat = place.lat;
    out.placeLng = place.lng;
  }

  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname + url.search);
  if (at) {
    out.viewportLat = Number(at[1]);
    out.viewportLng = Number(at[2]);
  }
  return out;
}

const PLACE_ID_RE = /^[\w-]{6,255}$/;

/** `%20`/`+` both mean a space in these path segments; `+` survives decoding. */
function decodeQuerySegment(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A stray `%` is not a reason to lose the name.
  }
  return decoded.replace(/\+/g, ' ').trim();
}

/**
 * The feature id, from either shape a real share link uses.
 *
 * `ftid=0x…:0x…` is what the Google Maps **application** writes. `!1s0x…:0x…`
 * inside `data=` is what a **browser** link writes for the same place. Reading
 * one and not the other is why the two clients behaved differently for what is
 * the same place and the same identifier.
 */
function readFeatureId(url: URL): MapsFeatureId | null {
  const param = url.searchParams.get('ftid');
  if (param) {
    const parsed = parseFeatureId(param);
    if (parsed) return parsed;
  }
  const data = url.searchParams.get('data') ?? dataFromPath(url.pathname);
  if (!data) return null;
  // `!1s` also introduces plain strings elsewhere in `data`; only the
  // `0x…:0x…` shape is a feature id, and the pattern is what says so.
  const m = /!1s(0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16})/i.exec(data);
  return m ? parseFeatureId(m[1]!) : null;
}

/**
 * `!8m2!3d<lat>!4d<lng>` — Google's own marker for *the place this link is
 * about*, and the reason a browser link can be resolved precisely.
 *
 * The `!8m2` prefix is required rather than matching `!3d`/`!4d` anywhere:
 * those pair up in directions and in several other `data` sections, where they
 * are a waypoint or a camera target and not this place.
 */
function readPlaceCoordinate(url: URL): { lat: number; lng: number } | null {
  const data = url.searchParams.get('data') ?? dataFromPath(url.pathname);
  if (!data) return null;
  const m = /!8m2!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(data);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { lat, lng }
    : null;
}

/** `/maps/place/<name>/@…/data=!4m…` keeps `data` in the path, not the query. */
function dataFromPath(pathname: string): string | null {
  const m = /\/data=([^/?#]+)/.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export type Fetcher = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; method: 'HEAD' | 'GET' },
) => Promise<{ status: number; headers: { get(name: string): string | null }; url?: string }>;

/**
 * Manual redirect walk: each hop is re-validated against the allowlist and
 * the private-IP guard, so an open redirect on an allowed host cannot pivot
 * into the internal network.
 */
export async function expandShortLink(
  input: string,
  fetcher: Fetcher,
  maxRedirects = MAX_REDIRECTS,
  budgetMs = MAX_EXPANSION_MS,
): Promise<UrlParseResult> {
  let current = input;
  const deadline = Date.now() + budgetMs;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = parseMapsUrl(current);
    if (!parsed.ok) return parsed;
    if (!parsed.value.needsExpansion && (parsed.value.providerPlaceId || parsed.value.query)) {
      return parsed;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reasonCode: 'INVALID_URL' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REDIRECT_TIMEOUT_MS, remaining));
    let res: Awaited<ReturnType<Fetcher>>;
    try {
      res = await fetcher(current, {
        redirect: 'manual',
        signal: controller.signal,
        method: 'HEAD',
      });
    } catch {
      return { ok: false, reasonCode: 'INVALID_URL' };
    } finally {
      clearTimeout(timer);
    }

    const location = res.headers.get('location');
    if (!location) {
      // No further hop: whatever we parsed is final.
      const final = parseMapsUrl(res.url ?? current);
      return final.ok ? { ok: true, value: { ...final.value, needsExpansion: false } } : final;
    }
    current = new URL(location, current).toString();
  }
  return { ok: false, reasonCode: 'INVALID_URL' };
}
