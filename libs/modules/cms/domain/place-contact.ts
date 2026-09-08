/**
 * Moved to `libs/modules/shared/place-contact.ts` (PI-BE-025).
 *
 * The bulk import needs the same normalization the console uses — one phone
 * written three ways is one phone, whichever door it came through — and
 * `ingestion` importing `cms` would be a cycle, because `cms` already imports
 * `ingestion`. `shared` is the layer both already depend on.
 *
 * Re-exported here so nothing that referenced the old path has to move with it.
 */
export {
  normalizePhone,
  normalizeWebsite,
  type ContactIssue,
  type NormalizedPhone,
  type NormalizedWebsite,
} from '../../shared/place-contact';
