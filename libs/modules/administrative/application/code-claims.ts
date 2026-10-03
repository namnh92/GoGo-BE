import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import type { Executor } from './unit-lookup';

/**
 * GoGo-BE#440 F-07 — editorial claims on a place's administrative codes.
 *
 * A `place_field_provenance` row for `province_code` / `commune_code` says "an
 * editor asserted this code, with this evidence, and the resolver adopted it".
 * It is the current provenance of the stored value only while that is true. A
 * machine derivation, a reviewer's different decision, or a clear makes it
 * obsolete, and every writer of the codes removes it through here — the row
 * carries no value of its own, so an obsolete claim left behind would go on
 * vouching for a code it never saw. Removed claims are returned so the writer
 * can keep them in its audit row: history, never current provenance.
 *
 * Codes the resolver derived carry their provenance in the mapping columns
 * (method, dataset, boundary version) and the mapping audit; no editorial row
 * is ever written for them.
 */
export const CODE_CLAIM_FIELDS = ['province_code', 'commune_code'] as const;
export type CodeClaimField = (typeof CODE_CLAIM_FIELDS)[number];

export type CodePair = { provinceCode: string | null; communeCode: string | null };

export type SupersededClaim = {
  field: string;
  sourceType: string;
  sourceReference: string | null;
  actorId: string | null;
  verifiedAt: string;
};

/** Fields whose stored value differs between two states of the pair. */
export function changedCodeFields(before: CodePair, after: CodePair): CodeClaimField[] {
  const changed: CodeClaimField[] = [];
  if ((before.provinceCode ?? null) !== (after.provinceCode ?? null)) changed.push('province_code');
  if ((before.communeCode ?? null) !== (after.communeCode ?? null)) changed.push('commune_code');
  return changed;
}

/** Deletes the named claims and returns what they said. */
export async function dropCodeClaims(
  executor: Executor,
  placeId: string,
  fields: readonly CodeClaimField[],
): Promise<SupersededClaim[]> {
  if (fields.length === 0) return [];
  const removed = await (executor as Db)
    .delete(schema.placeFieldProvenance)
    .where(
      and(
        eq(schema.placeFieldProvenance.placeId, placeId),
        inArray(schema.placeFieldProvenance.field, [...fields]),
      ),
    )
    .returning();
  return removed.map((r) => ({
    field: r.field,
    sourceType: r.sourceType,
    sourceReference: r.sourceReference,
    actorId: r.actorId,
    verifiedAt: r.verifiedAt.toISOString(),
  }));
}
