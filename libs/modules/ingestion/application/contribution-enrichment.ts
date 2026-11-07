import type { Db, SubmissionEnrichment } from '@gogo/database';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { assertValidSelections } from '../../shared/taxonomy-selections';

export function assertContributor(actor: Actor): void {
  if (actor.type !== 'user')
    throw AppError.forbidden('REGISTERED_USER_REQUIRED', 'Registered user required');
}

/** #794 must replace this fail-closed gate with transactional owner claim + sanitise.
 * Never accept raw URLs, client masking flags or client approval state. */
export async function validateEnrichment(
  db: Pick<Db, 'select'>,
  value: SubmissionEnrichment,
): Promise<void> {
  if (value.photos?.length)
    throw AppError.serviceUnavailable(
      'SUBMISSION_EVIDENCE_BLOCKED',
      'Private sanitised evidence requires #794',
      false,
    );
  const amenities = Object.keys(value.amenities ?? {});
  const supported = [
    'car_parking',
    'power_at_each_table',
    'pets_allowed',
    'separate_smoking_area',
    'open_after_23',
    'tables_over_six',
  ];
  if (
    amenities.some((k) => !supported.includes(k)) ||
    value.service?.chipKeys.some((k) => !k.startsWith('service_')) ||
    value.space?.chipKeys.some((k) => !k.startsWith('space_'))
  ) {
    throw AppError.badRequest('INVALID_TAXONOMY_KEYS', 'Unsupported wizard taxonomy group');
  }
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
