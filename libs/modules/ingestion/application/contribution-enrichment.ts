import type { Db, SubmissionEnrichment } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { assertValidSelections } from '../../shared/taxonomy-selections';

export function assertContributor(actor: Actor): void {
  if (actor.type !== 'user')
    throw AppError.forbidden('REGISTERED_USER_REQUIRED', 'Registered user required');
}

/** Menu references use #794; receipts remain closed until server-side PII masking exists. */
export async function validateEnrichment(
  db: Pick<Db, 'select'>,
  value: SubmissionEnrichment,
): Promise<void> {
  if (value.photos?.some((photo) => photo.kind === 'bill'))
    throw AppError.serviceUnavailable(
      'SUBMISSION_EVIDENCE_BLOCKED',
      'Receipt evidence requires server-side PII masking',
      false,
    );
  const amenities = Object.keys(value.amenities ?? {});
  await assertValidSelections(db, {
    suitability: value.purposeKeys ?? [],
    mood: value.vibeKeys ?? [],
    amenity: amenities,
    checkin_tag: [...(value.service?.chipKeys ?? []), ...(value.space?.chipKeys ?? [])],
  });
}

/** Do not let Drizzle errors (SQL bound free text in message/cause) reach logs. */
export function contributionStorageFailure(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw AppError.serviceUnavailable(
    'CONTRIBUTION_STORAGE_UNAVAILABLE',
    'Contribution storage unavailable',
  );
}
