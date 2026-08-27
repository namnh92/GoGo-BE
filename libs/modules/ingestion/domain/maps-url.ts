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

export type UrlParseResult =
  | { ok: true; value: MapsUrlHints }
  | { ok: false; reasonCode: 'INVALID_URL' | 'HOST_NOT_ALLOWED' | 'UNSAFE_TARGET' };

export type MapsUrlHints = {
  /** Provider place id when the URL carries one outright. */
  providerPlaceId?: string;
  /** Free-text name/query extracted from /maps/place/<name> or ?q=. */
  query?: string;
  lat?: number;
  lng?: number;
  /** Short links must be expanded before hints are final. */
  needsExpansion: boolean;
  normalizedUrl: string;
};

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

  const placeId = url.searchParams.get('place_id') ?? url.searchParams.get('placeid');
  if (placeId && /^[\w-]{6,255}$/.test(placeId)) out.providerPlaceId = placeId;

  // /maps/place/<Name>/@lat,lng,z or ?q=<name>
  const nameMatch = /\/maps\/place\/([^/@]+)/.exec(url.pathname);
  if (nameMatch?.[1]) {
    out.query = decodeURIComponent(nameMatch[1]).replace(/\+/g, ' ').trim();
  } else {
    const q = url.searchParams.get('q') ?? url.searchParams.get('query');
    if (q) {
      const coord = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(q.trim());
      if (coord) {
        out.lat = Number(coord[1]);
        out.lng = Number(coord[2]);
      } else {
        out.query = q.trim();
      }
    }
  }

  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname + url.search);
  if (at) {
    out.lat = Number(at[1]);
    out.lng = Number(at[2]);
  }
  return out;
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
): Promise<UrlParseResult> {
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = parseMapsUrl(current);
    if (!parsed.ok) return parsed;
    if (!parsed.value.needsExpansion && (parsed.value.providerPlaceId || parsed.value.query)) {
      return parsed;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS);
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
