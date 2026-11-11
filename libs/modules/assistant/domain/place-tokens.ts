import { answerMessageValidity } from './place-qa/reference-group';
import { answerQueries, mapPrivateTokens, parseAnswerToken, queryLabel } from './place-qa/tokens';

/** A stored message's `trace` (null included); omit for text read without its row. */
export type StoredTrace = Record<string, unknown> | null;
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

/** Ids worth an identity lookup. A malformed answer message yields none (no unvalidated read). */
export function placeIdsIn(text: string, trace?: StoredTrace): string[] {
  if (answerMessageValidity(text, trace) === 'invalid') return [];
  return [
    ...new Set(
      [...text.matchAll(TOKEN)]
        .map((m) => m[1]!.toLowerCase())
        .concat(answerQueries(text).map((q) => q.placeId)),
    ),
  ];
}

export function hasPlaceTokens(text: string): boolean {
  TOKEN.lastIndex = 0;
  const found = TOKEN.test(text);
  TOKEN.lastIndex = 0;
  return found;
}

/**
 * Each token as its name; an unknown id reads as `fallback`. A message holding
 * an answer reference must pass the whole-message grammar: otherwise the whole
 * text reads as `fallback`, so no writer prose survives next to a reference.
 */
export function renderPlaceTokens(
  text: string,
  names: ReadonlyMap<string, string>,
  fallback: string,
  onUnknown: () => void = () => {},
  trace?: StoredTrace,
): string {
  if (answerMessageValidity(text, trace) === 'invalid') {
    onUnknown();
    return fallback;
  }
  return mapPrivateTokens(text, (token) => {
    const match = new RegExp(`^${OPEN}place:(${UUID})${CLOSE}$`, 'i').exec(token);
    if (match) return names.get(match[1]!.toLowerCase()) || fallback;
    const query = parseAnswerToken(token);
    if (!query) onUnknown();
    return query ? names.get(query.placeId) || fallback : fallback;
  });
}

/** For copies that are themselves stored (the export): the id, never the name. */
export function placeTokensAsIds(
  text: string,
  locale: 'vi' | 'en' = 'vi',
  onUnknown: () => void = () => {},
  trace?: StoredTrace,
): string {
  if (answerMessageValidity(text, trace) === 'invalid') {
    onUnknown();
    return UNKNOWN_PLACE_LABEL[locale];
  }
  const label = locale === 'en' ? 'GoGo place' : 'địa điểm GoGo';
  return mapPrivateTokens(text, (token) => {
    const match = new RegExp(`^${OPEN}place:(${UUID})${CLOSE}$`, 'i').exec(token);
    if (match) return `${label} (${match[1]!.toLowerCase()})`;
    const query = parseAnswerToken(token);
    if (!query) onUnknown();
    return query ? queryLabel(query) : UNKNOWN_PLACE_LABEL[locale];
  });
}

/**
 * Cuts stored text to `max` characters without splitting a token: a cut
 * inside one moves to its start (A-R2-05), so a reader never gets a fragment.
 */
export function truncateTokenSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const open = text.lastIndexOf(OPEN, cut - 1);
  const close = open >= 0 ? text.indexOf(CLOSE, open) : -1;
  if (open >= 0 && (close < 0 || close >= cut)) cut = open;
  return text.slice(0, cut);
}

/**
 * The preview a finalized reply may leave on its conversation. A malformed
 * answer message leaves none (the previous preview stays): its prose is never
 * copied to a second stored place.
 */
export function storedPreview(text: string, trace: StoredTrace, max = 160): string {
  return answerMessageValidity(text, trace) === 'invalid' ? '' : truncateTokenSafe(text, max);
}

export const UNKNOWN_PLACE_LABEL = { vi: 'địa điểm này', en: 'this place' } as const;
