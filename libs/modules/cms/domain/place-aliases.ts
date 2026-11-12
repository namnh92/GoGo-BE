import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { validateEvidence, type ContactEvidenceInput } from '../../shared/place-contact';
import { contactEvidenceSchema } from '../../shared/place-contact-schema';
import { normalizeVietnamese } from '../../search/domain/normalize';

// Validate BEFORE trim: a trailing newline is invalid too. Error text never echoes input.
const alias = z
  .string()
  .max(120)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && normalizeVietnamese(value).length > 0,
    'Alias must be non-empty plain text without control characters',
  );
export const placeAliasesSchema = z.array(alias).max(20);
export const aliasProvenanceSchema = contactEvidenceSchema;
export type AliasWriteInput = {
  aliases?: string[] | undefined;
  aliasProvenance?: ContactEvidenceInput | undefined;
  expectedUpdatedAt?: string | undefined;
};

/** One independent source must support the entire replacement batch. */
export function planAliasWrite(input: AliasWriteInput) {
  if (input.aliases === undefined) {
    if (input.aliasProvenance !== undefined) {
      throw AppError.badRequest('VALIDATION_FAILED', 'aliasProvenance requires aliases');
    }
    return undefined;
  }
  const parsed = placeAliasesSchema.safeParse(input.aliases);
  if (!parsed.success || input.expectedUpdatedAt === undefined) {
    throw AppError.badRequest(
      'VALIDATION_FAILED',
      'Aliases require valid bounded text and expectedUpdatedAt',
    );
  }
  const evidence = validateEvidence(input.aliasProvenance, {
    sourceType: 'aliasProvenance.sourceType',
    sourceReference: 'aliasProvenance.sourceReference',
    collectedAt: 'aliasProvenance.collectedAt',
  });
  if (!evidence.ok) {
    throw AppError.badRequest(
      'VALIDATION_FAILED',
      'Independent alias evidence required',
      evidence.issues,
    );
  }
  if (evidence.value.sourceType !== 'editorial') {
    throw AppError.badRequest(
      'VALIDATION_FAILED',
      'Aliases require an independent editorial source',
    );
  }
  const entries = new Map<string, string>();
  for (const value of parsed.data)
    entries.set(
      normalizeVietnamese(value)
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/[\u2018\u2019\u201B\u02BC]/g, "'"),
      value.trim(),
    );
  return {
    entries: [...entries].map(([aliasNormalized, alias]) => ({ alias, aliasNormalized })),
    evidence: evidence.value,
  };
}
