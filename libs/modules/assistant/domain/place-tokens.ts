/**
 * GoGo-BE#717 A-R-04 — a reply never stores a place's name. A place's name
 * may be provider-derived, and CLAUDE.md forbids new persistent Google
 * content, so every persisted copy of a reply (the message text, its frames,
 * the live buffer, the conversation preview) names a place by a token holding
 * its id only. Every read renders the token to today's name from verified
 * data. Place ids may be stored indefinitely; names never are.
 *
 * The delimiters are private-use code points: a model or a user cannot type
 * them by accident, and model output has them stripped before tokens are
 * inserted, so only the server ever writes one.
 */
const OPEN = '';
const CLOSE = '';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN = new RegExp(`${OPEN}place:(${UUID})${CLOSE}`, 'gi');
const DELIMITERS = new RegExp(`[${OPEN}${CLOSE}]`, 'g');

export function placeToken(placeId: string): string {
  return `${OPEN}place:${placeId}${CLOSE}`;
}

/** Removes the token delimiters from text the server did not write. */
export function stripTokenDelimiters(text: string): string {
  return text.replace(DELIMITERS, '');
}

export function placeIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]!.toLowerCase()))];
}

export function hasPlaceTokens(text: string): boolean {
  TOKEN.lastIndex = 0;
  const found = TOKEN.test(text);
  TOKEN.lastIndex = 0;
  return found;
}

/** Each token as its name; an unknown id reads as `fallback`. */
export function renderPlaceTokens(
  text: string,
  names: ReadonlyMap<string, string>,
  fallback: string,
): string {
  return text.replace(TOKEN, (_m, id: string) => names.get(id.toLowerCase()) || fallback);
}

export const UNKNOWN_PLACE_LABEL = { vi: 'địa điểm này', en: 'this place' } as const;
