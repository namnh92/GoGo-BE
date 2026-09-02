import { GOOGLE_ATTRIBUTION } from '@gogo/providers';

/**
 * COST-BE-006 (#339) — one wording for Google's attribution, at read time.
 *
 * Three strings for one obligation shipped side by side: the adapter stamped
 * `Data © Google` onto every provider row it wrote, the area autocomplete
 * answered `Powered by Google`, and policy asks for `Google Maps`. Which one a
 * user saw depended on which screen they were on.
 *
 * Normalising on read rather than rewriting the stored rows is a deliberate
 * choice and it has a cost worth naming: `place_provider_sources.attribution`
 * keeps the string it was written with, so anyone reading that column directly
 * — a SQL console, a future export, a report — still sees the old wording, and
 * every future reader has to remember to come through here. The trade is that
 * no migration touches provider-derived content while ADR-0006 §9.6 is
 * unsigned, and the user-facing wording is consistent from this commit rather
 * than from whenever PR7/PR8 next re-fetches each row.
 *
 * Unknown text is returned untouched. A non-Google provider's attribution is
 * its own obligation, and rewriting it would be the same bug in the other
 * direction.
 */
const LEGACY_GOOGLE_ATTRIBUTIONS = new Set(['Data © Google', 'Powered by Google']);

export function normalizeGoogleAttribution<T extends string | null | undefined>(
  stored: T,
): T | string {
  if (!stored) return stored;
  return LEGACY_GOOGLE_ATTRIBUTIONS.has(stored.trim()) ? GOOGLE_ATTRIBUTION : stored;
}
