/** I05 proof material is never telemetry, including nested payloads and text echoes. */
const PRIVATE_KEY =
  /^(?:contextToken|csrfToken|headerProof|cookieProof|x-gogo-invite-context|x-gogo-invite-csrf|__Host-gogo_invite_(?:ctx|csrf))$/i;
const NAMED_VALUE =
  /((?<![\w.-])(?:contextToken|csrfToken|headerProof|cookieProof|x-gogo-invite-context|x-gogo-invite-csrf|__Host-gogo_invite_(?:ctx|csrf))["']?\s*[:=]\s*["']?)[^\s"',;}\]&]+/gi;
export const isInviteProofKey = (key: string): boolean => PRIVATE_KEY.test(key);

/** Decode once, as query parsers do; unlike URLSearchParams, reject invalid escapes/UTF-8. */
function decodeQueryPart(part: string): string {
  return decodeURIComponent(part.replace(/\+/g, ' '));
}

/** Preserve query spelling/order and redact every occurrence of a decoded proof name. */
export function redactInviteProofQuery(query: string): string {
  const lead = query.startsWith('?') ? '?' : '';
  try {
    const redacted = query
      .slice(lead.length)
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const key = eq < 0 ? pair : pair.slice(0, eq);
        const decoded = decodeQueryPart(key);
        // Malformed values also make the query ambiguous: fail closed for the whole query.
        decodeQueryPart(eq < 0 ? '' : pair.slice(eq + 1));
        return isInviteProofKey(decoded) ? `${key}=[redacted]` : pair;
      })
      .join('&');
    return lead + redacted;
  } catch {
    return `${lead}[redacted]`;
  }
}

/** Sentry also supplies query strings as pairs or objects, with raw or decoded names. */
export function redactInviteProofQueryPairs(
  pairs: readonly (readonly [string, string])[],
): [string, string][] {
  try {
    return pairs.map(([key, value]) => [
      key,
      isInviteProofKey(decodeQueryPart(key)) ? '[redacted]' : value,
    ]);
  } catch {
    return [['[redacted]', '[redacted]']];
  }
}

export const redactInviteProofText = (text: string): string =>
  text
    // URL queries and bare query strings embedded in log/error text. Stop before
    // fragments, quotes or whitespace so surrounding diagnostic text survives.
    .replace(/\?[^#\s"'<>]*/g, (query) => redactInviteProofQuery(query))
    .replace(
      /(^|\s)([^?#\s"'<>]*=[^#\s"'<>]*)/g,
      (_match, lead: string, query: string) => `${lead}${redactInviteProofQuery(query)}`,
    )
    .replace(NAMED_VALUE, '$1[redacted]');

export function redactInviteProofsDeep<T>(value: T): T {
  function walk(inner: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (typeof inner === 'string') return redactInviteProofText(inner);
    if (!inner || typeof inner !== 'object' || inner instanceof Error) return inner;
    if (seen.has(inner) || depth >= 24) return '[redacted]';
    seen.add(inner);
    if (Array.isArray(inner)) {
      if (inner.length === 2 && typeof inner[0] === 'string' && isInviteProofKey(inner[0]))
        return [inner[0], '[redacted]'];
      return inner.map((item) => walk(item, seen, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(inner).map(([key, item]) => [
        key,
        isInviteProofKey(key) ? '[redacted]' : walk(item, seen, depth + 1),
      ]),
    );
  }
  return walk(value, new WeakSet(), 0) as T;
}
