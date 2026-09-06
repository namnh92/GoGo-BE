import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * SEC-004 (#445) — the client address the share-link Worker saw, and the only
 * circumstances under which this API believes it.
 *
 * The share-link Worker sits between a visitor and `GET /v1/share-links/{slug}`
 * and calls the API server-to-server, so without help every click looks like it
 * came from a Cloudflare egress address. That turns the route's rate limit into
 * a ceiling shared by the whole product while distinguishing no visitor from
 * any other — the worst of both.
 *
 * The obvious repair is the wrong one. Trusting `X-Forwarded-For` on an origin
 * that can be reached directly means trusting attacker-controlled input, which
 * is *worse* than having no per-client limit at all: it hands out an unlimited
 * supply of fresh buckets to anyone who can type a header.
 *
 * So the rule here is that a forwarded header is worth exactly the
 * authentication of the hop that set it:
 *
 *   1. the value arrives under a GoGo-specific name, never `X-Forwarded-For`,
 *      so it can never be confused with something another proxy — or the
 *      visitor — might have set;
 *   2. it counts only when the request also carries the shared token the Worker
 *      holds, compared in constant time;
 *   3. **both headers are removed from every request either way**, before any
 *      guard, handler or serializer can observe them. Strip first, then decide
 *      — never decide and leave the header lying there for the next reader to
 *      trust by accident;
 *   4. what survives is `req.edgeClientIp`, and it is consulted by exactly one
 *      rate-limit spec. It is never an input to authorization, geolocation,
 *      auditing or a log line.
 *
 * When no token is configured — which is every environment today — nothing is
 * ever trusted and the header is still stripped. The safe state is the default,
 * not something a deploy has to remember to switch on.
 */

/** Cloudflare sets `CF-Connecting-IP` at the edge; the Worker relays it here. */
export const EDGE_CLIENT_IP_HEADER = 'x-gogo-client-ip';
/** The Worker's proof that it is the Worker. */
export const EDGE_AUTH_HEADER = 'x-gogo-edge-auth';

/** Shorter than this is not a secret, whatever it is. */
export const EDGE_AUTH_TOKEN_MIN_LENGTH = 32;

type HeaderBag = Record<string, string | string[] | undefined>;

export type EdgeAwareRequest = {
  headers: HeaderBag;
  /** Set only for a request whose edge hop authenticated. */
  edgeClientIp?: string | undefined;
};

/**
 * Digest before comparing, so the comparison is constant-time in the value
 * *and* independent of length — `timingSafeEqual` throws on a length mismatch,
 * and branching on that would leak the token's size.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** A header sent twice arrives as an array. Two answers is not an answer. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The address, if this request proved it may name one.
 *
 * Exported for the unit tests; the hook below is what runs in production.
 */
export function vettedEdgeClientIp(headers: HeaderBag, expectedToken: string): string | null {
  if (!expectedToken) return null;

  const presented = single(headers[EDGE_AUTH_HEADER]);
  if (presented === null || !tokenMatches(presented, expectedToken)) return null;

  const claimed = single(headers[EDGE_CLIENT_IP_HEADER]);
  if (claimed === null) return null;
  // A zone id is a local interface name and is meaningless coming from a remote
  // peer — and `node:net`'s isIP accepts one, so `::1%eth0` and `::1%eth1` would
  // be two buckets for one address. Refused before the parse rather than after.
  if (claimed.includes('%')) return null;
  // No trimming either: a value with whitespace was not produced by the Worker,
  // and accepting a sloppy one is how ` 1.2.3.4` and `1.2.3.4` become two
  // buckets for one visitor.
  return isIP(claimed) === 0 ? null : claimed;
}

/**
 * Fastify `onRequest` hook. Register it before anything that reads headers.
 */
export function createEdgeClientIpHook(expectedToken: string) {
  return function stripAndVet(req: EdgeAwareRequest): void {
    const vetted = vettedEdgeClientIp(req.headers, expectedToken);
    // Unconditional, and after the read: a spoofed header must not survive to
    // be picked up by a serializer, a future guard, or a proxy library that
    // happens to know this name.
    delete req.headers[EDGE_CLIENT_IP_HEADER];
    delete req.headers[EDGE_AUTH_HEADER];
    if (vetted !== null) req.edgeClientIp = vetted;
  };
}
