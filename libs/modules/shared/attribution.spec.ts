import { describe, expect, it } from 'vitest';
import { GOOGLE_ATTRIBUTION } from '@gogo/providers';
import { normalizeGoogleAttribution } from './attribution';

/**
 * COST-BE-006 (#339) — one obligation, one sentence.
 *
 * Three wordings for Google's attribution shipped side by side: the adapter
 * stamped `Data © Google` onto every provider row, the area autocomplete
 * answered `Powered by Google`, and policy asks for `Google Maps`. Which one a
 * user saw depended on which screen they were on.
 */
describe('normalizeGoogleAttribution', () => {
  it('is the wording policy asks for', () => {
    expect(GOOGLE_ATTRIBUTION).toBe('Google Maps');
  });

  it.each(['Data © Google', 'Powered by Google'])('rewrites the legacy wording %s', (legacy) => {
    expect(normalizeGoogleAttribution(legacy)).toBe(GOOGLE_ATTRIBUTION);
  });

  it('tolerates the whitespace a stored row may carry', () => {
    expect(normalizeGoogleAttribution('  Data © Google ')).toBe(GOOGLE_ATTRIBUTION);
  });

  it('is idempotent — the canonical wording passes through unchanged', () => {
    expect(normalizeGoogleAttribution(GOOGLE_ATTRIBUTION)).toBe(GOOGLE_ATTRIBUTION);
  });

  it('leaves another provider alone', () => {
    // The same bug in the other direction: an attribution belonging to somebody
    // other than Google is their obligation, and rewriting it would be a
    // licence breach wearing a consistency fix.
    expect(normalizeGoogleAttribution('Data © Fake Provider')).toBe('Data © Fake Provider');
    expect(normalizeGoogleAttribution('© OpenStreetMap contributors')).toBe(
      '© OpenStreetMap contributors',
    );
  });

  it('passes absence through as absence, never as a wording', () => {
    // A row with no attribution has none. Substituting Google's here would
    // claim a source the place does not have.
    expect(normalizeGoogleAttribution(null)).toBeNull();
    expect(normalizeGoogleAttribution(undefined)).toBeUndefined();
    expect(normalizeGoogleAttribution('')).toBe('');
  });
});
