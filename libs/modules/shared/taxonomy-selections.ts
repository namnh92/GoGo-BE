import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from './app-error';

/** Stable taxonomy keys grouped by kind, e.g. `{ mood: ['chill'] }`. */
export type TaxonomySelections = Record<string, string[]>;

/**
 * FR-PREF-002 — a selection is a set of stable taxonomy keys grouped by kind,
 * and every key must exist as an active taxonomy of that kind.
 *
 * Shared between a room member's `preference_selections` and the profile's
 * private interests (ADR-0022), so the two can never accept different
 * vocabularies. `allowedKinds`, when given, also refuses a kind the caller does
 * not model: the profile stores `mood` only, and a client that sends
 * `dietary` there is told so rather than silently persisted.
 */
export async function assertValidSelections(
  db: Pick<Db, 'select'>,
  selections: TaxonomySelections,
  allowedKinds?: readonly string[],
): Promise<void> {
  const kinds = Object.keys(selections);
  if (kinds.length === 0) return;

  const errors: { field: string; code: string; message: string }[] = [];
  if (allowedKinds) {
    for (const kind of kinds) {
      if (!allowedKinds.includes(kind)) {
        errors.push({
          field: `selections.${kind}`,
          code: 'unsupported_kind',
          message: `kind not accepted here: ${kind}`,
        });
      }
    }
  }

  const rows = await db
    .select({ kind: schema.taxonomies.kind, key: schema.taxonomies.key })
    .from(schema.taxonomies)
    .where(eq(schema.taxonomies.isActive, true));
  const valid = new Set(rows.map((r) => `${r.kind}:${r.key}`));
  for (const [kind, keys] of Object.entries(selections)) {
    if (allowedKinds && !allowedKinds.includes(kind)) continue;
    for (const key of keys) {
      if (!valid.has(`${kind}:${key}`)) {
        errors.push({
          field: `selections.${kind}`,
          code: 'unknown_key',
          message: `unknown taxonomy key: ${key}`,
        });
      }
    }
  }
  if (errors.length > 0) {
    throw AppError.badRequest('INVALID_TAXONOMY_KEYS', 'Unknown taxonomy selections', errors);
  }
}
