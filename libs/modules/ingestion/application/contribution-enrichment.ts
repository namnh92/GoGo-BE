import type { Db, SubmissionEnrichment } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { assertValidSelections } from '../../shared/taxonomy-selections';

export function assertContributor(actor: Actor): void {
  if (actor.type !== 'user')
    throw AppError.forbidden('REGISTERED_USER_REQUIRED', 'Registered user required');
}

/** Photo ownership and sanitisation run in the private photo pipeline. */
export async function validateEnrichment(
  db: Pick<Db, 'select'>,
  value: SubmissionEnrichment,
): Promise<void> {
  assertBillPhotoConsent(
    value.photos?.some((p) => p.kind === 'bill') ?? false,
    value.billPhotoPublicConsent,
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

/** Required on every request that saves or submits a bill, including retained uploads. */
export function assertBillPhotoConsent(hasBill: boolean, consent?: boolean): void {
  if (hasBill && consent !== true)
    throw AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', [
      {
        field: 'enrichment.billPhotoPublicConsent',
        code: 'consent_required',
        message:
          'Confirm that this bill photo may be shown publicly after moderator approval and that you removed or hid personal information yourself',
      },
    ]);
}
