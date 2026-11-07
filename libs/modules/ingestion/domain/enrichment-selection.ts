import { z } from 'zod';
import type { SubmissionEnrichment } from '@gogo/database';
import { AppError } from '../../shared/app-error';

const distinct = (ids: string[]) => new Set(ids).size === ids.length;
export const enrichmentSelectionSchema = z
  .object({
    keptFactKeys: z
      .array(z.string().min(1).max(128))
      .max(64)
      .refine(distinct, 'Duplicate fact keys'),
    keptPhotoMediaIds: z
      .array(z.string().uuid().toLowerCase())
      .max(5)
      .refine(distinct, 'Duplicate media ids'),
  })
  .strict();
export type EnrichmentSelection = z.infer<typeof enrichmentSelectionSchema>;
export type ContributionFacts = Record<
  string,
  string | number | boolean | NonNullable<SubmissionEnrichment['price']>
>;

/** Stable identity derives from field + taxonomy key, never array position or label. */
export function enrichmentFacts(value: SubmissionEnrichment | null | undefined): ContributionFacts {
  const facts: ContributionFacts = {};
  if (!value) return facts;
  if (value.price) {
    const { min, max, currency, unit } = value.price;
    facts.price = { min, max, currency, unit };
  }
  for (const field of ['purposeKeys', 'vibeKeys'] as const)
    for (const key of value[field] ?? []) facts[`${field}:${key}`] = key;
  for (const [key, present] of Object.entries(value.amenities ?? {}))
    facts[`amenities:${key}`] = present;
  for (const field of ['recommendedDishes', 'visitTips'] as const)
    if (value[field]) facts[field] = value[field];
  for (const field of ['service', 'space'] as const) {
    const rating = value[field];
    if (!rating) continue;
    facts[`${field}.rating`] = rating.rating;
    for (const key of rating.chipKeys) facts[`${field}.chipKeys:${key}`] = key;
  }
  return facts;
}

export function selectEnrichment(
  value: SubmissionEnrichment | null | undefined,
  input: EnrichmentSelection,
) {
  const selection = enrichmentSelectionSchema.parse(input);
  const facts = enrichmentFacts(value);
  const photoIds = value?.photos?.map((p) => p.mediaId.toLowerCase()) ?? [];
  if (
    selection.keptFactKeys.some((key) => !Object.hasOwn(facts, key)) ||
    selection.keptPhotoMediaIds.some((id) => !photoIds.includes(id))
  )
    throw AppError.badRequest(
      'INVALID_ENRICHMENT_SELECTION',
      'Select only items on this contribution',
    );
  const keptFactKeys = [...selection.keptFactKeys].sort();
  const keptPhotoMediaIds = [...selection.keptPhotoMediaIds].sort();
  return {
    facts: Object.fromEntries(keptFactKeys.map((key) => [key, facts[key]!])) as ContributionFacts,
    keptFactKeys,
    keptPhotoMediaIds,
    droppedFactKeys: Object.keys(facts)
      .filter((key) => !keptFactKeys.includes(key))
      .sort(),
    droppedPhotoMediaIds: photoIds.filter((id) => !keptPhotoMediaIds.includes(id)).sort(),
  };
}
