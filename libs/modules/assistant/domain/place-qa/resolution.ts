import { normalizeVietnamese } from '../../../search/domain/normalize';

export const PLACE_QA_RETRIEVAL_THRESHOLD = 0.3;
export const PLACE_QA_WEAK_THRESHOLD = 0.35;
export const PLACE_QA_CANDIDATE_LIMIT = 8;

export type PlaceNameArea =
  | { kind: 'current'; datasetVersion: string; provinceCode: string; communeCode?: string | null }
  | { kind: 'legacy' }
  | { kind: 'unresolved' };
export type PlaceNameCandidate = { id: string; exact: boolean; score: number };
export type PlaceNameMatches = {
  candidates: readonly PlaceNameCandidate[];
  overflow: boolean;
  areaMismatch: boolean;
};
export type PlaceNameResolution = PlaceNameMatches & {
  kind: 'answer' | 'choice' | 'confirm' | 'narrow' | 'not_found';
  row: 2 | 3 | 4 | 5 | 6;
};

/**
 * Whole-name spelling variants only. No stopword/area-word removal or
 * bag-of-words equality. En/em dashes and typographic apostrophes fold like
 * PostgreSQL unaccent. The other approved equivalence is the possessive of one
 * digit-bearing brand token: `4p's` = `4ps` = `4p s`. Other characters,
 * unrelated apostrophes and punctuation included, are kept as typed, so the
 * whole folded name is always a member of its own variant set.
 */
export function placeNameVariants(span: string): string[] {
  // Mirror the stored f_unaccent punctuation before probing the indexed key.
  // Keep the dash (and its spacing): deleting it would invent exact matches.
  const folded = normalizeVietnamese(span)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019\u201B\u02BC]/g, "'");
  if (!folded) return [];
  const brands = [...folded.matchAll(/(\b[a-z]*\d[a-z]*)(?:'s|s|\s+s)\b/g)];
  // Several brand tokens would need 3^n spellings. No equivalence is applied
  // then: other spellings stay fuzzy (confirm), which can never fake uniqueness.
  if (brands.length !== 1) return [folded];
  const brand = brands[0]!;
  const head = folded.slice(0, brand.index) + brand[1]!;
  const rest = folded.slice(brand.index + brand[0].length);
  // All three forms from any one of them: exact uniqueness cannot depend on
  // which equivalent spelling the user typed.
  return [...new Set([`${head}'s${rest}`, `${head}s${rest}`, `${head} s${rest}`])];
}

/** Errors are thrown by the read port, never represented as an empty match set. */
export function resolvePlaceNameOutcome(
  matches: PlaceNameMatches,
  options: { area?: PlaceNameArea; ambiguous?: boolean } = {},
): PlaceNameResolution {
  const candidates = [...matches.candidates].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
  const result = (
    kind: PlaceNameResolution['kind'],
    row: PlaceNameResolution['row'],
    list = candidates,
  ): PlaceNameResolution => ({ ...matches, kind, row, candidates: list });
  if (options.ambiguous || options.area?.kind === 'unresolved') return result('narrow', 2);
  const exact = candidates.filter((c) => c.exact);
  // Owner decision 2026-11-12 (BE#875), amending rev3 §4.3: the
  // complete exact channel wins over fuzzy/FTS overflow. Exact families
  // larger than the three-card choice still require an area.
  if (exact.length > 3 || (!exact.length && matches.overflow)) return result('narrow', 2);
  if (matches.areaMismatch) {
    const elsewhere = exact.length
      ? exact
      : candidates.filter((c) => c.score >= Math.fround(PLACE_QA_WEAK_THRESHOLD));
    return elsewhere.length
      ? result('choice', 4, elsewhere.slice(0, 3))
      : result('not_found', 6, []);
  }
  if (exact.length === 1)
    return result(options.area?.kind === 'legacy' ? 'confirm' : 'answer', 3, exact);
  if (exact.length > 1) return result('choice', 4, exact.slice(0, 3));
  // pg_trgm returns float4: SQL 0.35 arrives as 0.3499999940395355 after
  // float8 promotion. Compare in its native precision so equality is included.
  const fuzzy = candidates.filter((c) => c.score >= Math.fround(PLACE_QA_WEAK_THRESHOLD));
  return fuzzy.length ? result('confirm', 5, fuzzy.slice(0, 3)) : result('not_found', 6, []);
}
