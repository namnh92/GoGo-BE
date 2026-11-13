/** #905: UTF-8 bytes of the complete serialized HTTP JSON body, not characters. */
export const MAX_JEV_DECISION_BYTES = 32_768;
export const MAX_JEV_RELEVANCE_BYTES = 16_384;
export const MAX_HAIKU_REQUEST_BYTES = 49_152;
export const MAX_JEV_DECISION_CALLS = 2;
export const MAX_JEV_RELEVANCE_CALLS = 1;
export const MAX_HAIKU_CALLS = 1;

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Same UTF-16 cap as slice(), without leaving half a Unicode codepoint. */
export function codepointSlice(text: string, maxChars: number): string {
  const end = Math.min(text.length, maxChars);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** Keep normal requests byte-identical. On overflow retain the ordered prefix
 * of whole items. Callers supply priority order; ties use a stable lexical sort.
 * Keys/IDs are never shortened into a different identifier. */
export function boundedItems<T>(
  items: readonly T[],
  maxBytes: number,
  compare: (a: T, b: T) => number,
): T[] {
  if (utf8Bytes(JSON.stringify(items)) <= maxBytes) return [...items];
  const sorted = [...items].sort(compare);
  const kept: T[] = [];
  let bytes = 2;
  for (const item of sorted) {
    const size = utf8Bytes(JSON.stringify(item)) + (kept.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    kept.push(item);
    bytes += size;
  }
  return kept;
}

export function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prefix a string within a JSON-escaped UTF-8 byte allowance (incl. quotes). */
export function boundedJsonText(text: string, maxBytes: number): string {
  if (utf8Bytes(JSON.stringify(text)) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(JSON.stringify(codepointSlice(text, mid))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return codepointSlice(text, lo);
}
