import { z } from 'zod';

/**
 * GoGo-BE#280 — the evidence one contact value carries. Structural only: the
 * meaning (independent source, no Google reference, not in the future) is
 * checked by `validateEvidence`, which every write path shares, so a missing
 * property is reported there with the same code a sheet row would get.
 */
export const contactEvidenceSchema = z
  .object({
    sourceType: z.string().max(40).optional(),
    sourceReference: z.string().max(2000).optional(),
    collectedAt: z.string().max(64).optional(),
  })
  .strict();

export const contactProvenanceSchema = z
  .object({
    addressText: contactEvidenceSchema.optional(),
    phone: contactEvidenceSchema.optional(),
    website: contactEvidenceSchema.optional(),
  })
  .strict();
