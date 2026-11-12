import { QA_COPY, type QaCopyKey } from './copy';
import {
  answerQueries,
  answerTextValidity,
  hasAnswerReference,
  parseAnswerToken,
  REFERENCE_ID,
  referenceOnlyText,
  type AnswerValidity,
} from './tokens';
/** Stored in trace.placeAnswerGroup. Frames hold tokens/card ids, never hydrated values.
 * A producer MUST persist route=place_qa before any group frames are buffered.
 * Commit the complete group before readers release any fact-bearing frame.
 */
export type PlaceAnswerGroup = Readonly<{
  v: 1;
  kind: 'answer' | 'compare' | 'clarification' | 'notice';
  message?: QaCopyKey;
  legacyArea?: true;
  prompt?: 'place_choice' | 'place_confirm';
  cards: readonly string[];
  sources: readonly string[];
  options: readonly (
    | Readonly<{ id: string; query: string }>
    | Readonly<{ id: string; placeId: string }>
    | Readonly<{ id: string; none: true }>
  )[];
}>;
/** A fenced turn that ended before producing a group reads as the fixed load-error notice. */
export const UNPRODUCED_GROUP: PlaceAnswerGroup = Object.freeze({
  v: 1,
  kind: 'notice',
  message: 'read_error',
  cards: [],
  sources: [],
  options: [],
});
export function isPlaceAnswerRow(row: {
  text: string;
  trace?: Record<string, unknown> | null;
}): boolean {
  return (
    row.trace?.route === 'place_qa' ||
    row.trace?.streamRoute === 'place_qa' ||
    row.trace?.placeAnswerGroup !== undefined ||
    hasAnswerReference(row.text)
  );
}
/**
 * The one whole-message validator behind every read surface (SSE, history,
 * CMS, search snippet, stored preview, export), so they cannot diverge.
 * With the stored row's `trace` (null included) the full grammar applies:
 * reference-only text, kind-specific coverage, no zero-query answer/compare
 * group, no source query absent from the text. Without it (`undefined`: a
 * truncated preview or a lone frame, which cannot carry coverage) only the
 * text half applies. `invalid` is neutralized whole, with no lookup.
 */
export function answerMessageValidity(
  text: string,
  trace?: Record<string, unknown> | null,
): AnswerValidity {
  if (trace === undefined) return answerTextValidity(text);
  if (!isPlaceAnswerRow({ text, trace })) return 'none';
  return parseReferenceGroup(trace?.placeAnswerGroup, text) ? 'valid' : 'invalid';
}
export function parseReferenceGroup(value: unknown, text: string): PlaceAnswerGroup | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as PlaceAnswerGroup;
  if (
    Object.keys(g).some(
      (k) =>
        !['v', 'kind', 'prompt', 'cards', 'sources', 'options', 'message', 'legacyArea'].includes(
          k,
        ),
    ) ||
    g.v !== 1 ||
    !['answer', 'compare', 'clarification', 'notice'].includes(g.kind) ||
    !Array.isArray(g.cards) ||
    !Array.isArray(g.sources) ||
    !Array.isArray(g.options) ||
    g.options.length > (g.kind === 'clarification' ? 4 : 3) ||
    g.sources.length > 8 ||
    // Only references and their separators; writer prose is never data.
    !referenceOnlyText(text)
  )
    return null;
  if (g.kind === 'notice')
    return g.message &&
      Object.hasOwn(QA_COPY, g.message) &&
      !text &&
      !g.cards.length &&
      !g.sources.length &&
      !g.options.length &&
      !g.prompt &&
      !g.legacyArea
      ? Object.freeze(g)
      : null;
  if (
    g.message !== undefined ||
    (g.legacyArea !== undefined && (g.legacyArea !== true || g.kind !== 'clarification'))
  )
    return null;
  if (
    g.prompt !== undefined &&
    (g.kind !== 'clarification' || !['place_choice', 'place_confirm'].includes(g.prompt))
  )
    return null;
  const max = g.kind === 'clarification' ? 3 : 2;
  if (
    g.cards.length > max ||
    new Set(g.cards).size !== g.cards.length ||
    g.cards.some((id) => typeof id !== 'string' || !REFERENCE_ID.test(id))
  )
    return null;
  if (g.kind === 'answer' && g.cards.length > 1) return null;
  if (g.kind === 'compare' && g.cards.length !== 2) return null;
  if (g.sources.some((t) => typeof t !== 'string' || !parseAnswerToken(t))) return null;
  if (
    g.options.some((o) => {
      if (!o || typeof o.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(o.id)) return true;
      if ('query' in o)
        return (
          Object.keys(o).length !== 2 ||
          typeof o.query !== 'string' ||
          !parseAnswerToken(o.query) ||
          g.kind === 'clarification'
        );
      if ('placeId' in o)
        return (
          Object.keys(o).length !== 2 || !g.cards.includes(o.placeId) || g.kind !== 'clarification'
        );
      return (
        !('none' in o) ||
        o.none !== true ||
        Object.keys(o).length !== 2 ||
        g.kind !== 'clarification'
      );
    }) ||
    new Set(g.options.map((o) => o.id)).size !== g.options.length
  )
    return null;
  const textQueries = answerQueries(text);
  const queries = [
    ...textQueries,
    ...g.sources.map((t) => parseAnswerToken(t)!),
    ...g.options.flatMap((o) => ('query' in o ? [parseAnswerToken(o.query)!] : [])),
  ];
  if (g.kind === 'clarification' && queries.length) return null;
  if (
    g.kind !== 'clarification' &&
    (!textQueries.length || !g.cards.every((id) => textQueries.some((q) => q.placeId === id)))
  )
    return null;
  // Compare semantic queries rather than serialized argument order.
  if (
    g.sources.some((token) => {
      const source = parseAnswerToken(token)!;
      return !textQueries.some((query) =>
        ['placeId', 'locale', 'topic', 'day', 'date', 'd', 'tz', 'k', 's', 'n'].every(
          (key) => query[key as keyof typeof query] === source[key as keyof typeof source],
        ),
      );
    })
  )
    return null;
  if (queries.some((q) => !g.cards.includes(q.placeId))) return null;
  // A hidden identity reference cannot widen the authorized group.
  const ids = [...text.matchAll(/\uE000place:([^\uE001]+)\uE001/g)].map((m) => m[1]!);
  if (ids.some((id) => !g.cards.includes(id))) return null;
  if (g.kind === 'clarification' && (!g.cards.length || !g.cards.every((id) => ids.includes(id))))
    return null;
  return Object.freeze(g);
}
