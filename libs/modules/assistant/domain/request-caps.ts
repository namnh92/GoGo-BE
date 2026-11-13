import { codepointSlice, lexical, utf8Bytes, type DecisionCriterion } from '@gogo/providers';

export const MAX_RESOLVED_BYTES = 4096;

/** Oversized resolved state: settled > assumed > open > labels, lexical ties.
 * Keep a prefix of existing values only; object keys are atomic. Byte accounting
 * includes JSON escaping and punctuation. This never mutates stored state. */
export function boundedResolved(value: DecisionCriterion): DecisionCriterion {
  if (utf8Bytes(JSON.stringify(value)) <= MAX_RESOLVED_BYTES) return value;
  return prefix(value, MAX_RESOLVED_BYTES);
}

function prefix(value: DecisionCriterion, budget: number): DecisionCriterion {
  if (utf8Bytes(JSON.stringify(value)) <= budget) return value;
  if (typeof value === 'string') {
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (utf8Bytes(JSON.stringify(codepointSlice(value, mid))) <= budget) lo = mid;
      else hi = mid - 1;
    }
    return codepointSlice(value, lo);
  }
  if (Array.isArray(value)) {
    const sorted = value.every((v) => typeof v === 'string')
      ? [...value].sort((a, b) => lexical(a as string, b as string))
      : value;
    const kept: DecisionCriterion[] = [];
    let used = 2;
    for (const item of sorted) {
      const size = utf8Bytes(JSON.stringify(item)) + (kept.length ? 1 : 0);
      if (used + size > budget) break;
      kept.push(item);
      used += size;
    }
    return kept;
  }
  if (value && typeof value === 'object') {
    const priority = ['settled', 'assumed', 'open', 'labels'];
    const rank = (key: string) => {
      const i = priority.indexOf(key);
      return i < 0 ? priority.length : i;
    };
    const kept: Record<string, DecisionCriterion> = {};
    let used = 2;
    for (const key of Object.keys(value).sort((a, b) => rank(a) - rank(b) || lexical(a, b))) {
      const overhead = utf8Bytes(JSON.stringify(key)) + 1 + (Object.keys(kept).length ? 1 : 0);
      const available = budget - used - overhead;
      // Enough for any empty container/string; don't fabricate primitive values.
      if (available < 2) break;
      const original = value[key]!;
      if (
        (typeof original === 'number' || typeof original === 'boolean' || original === null) &&
        utf8Bytes(JSON.stringify(original)) > available
      )
        break;
      const item = prefix(original, available);
      Object.defineProperty(kept, key, { value: item, enumerable: true });
      used += overhead + utf8Bytes(JSON.stringify(item));
    }
    return kept;
  }
  return value;
}
