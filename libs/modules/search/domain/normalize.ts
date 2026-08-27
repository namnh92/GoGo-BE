/**
 * SE-002 — Vietnamese query normalization, mirrored with the SQL side
 * (f_unaccent + lower in migration 0001). Both sides must agree so the
 * trigram/FTS comparison happens in the same space.
 */
export function normalizeVietnamese(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Builds a websearch-style query string, guarding against tsquery syntax abuse. */
export function toSearchQuery(input: string): string {
  return normalizeVietnamese(input)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
