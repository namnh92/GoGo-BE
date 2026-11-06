/** GoGo-BE#787 — public taxonomy keys; labels belong to client i18n. */
export const SUBMISSION_REJECTION_REASONS = [
  'duplicate_place',
  'incorrect_location',
  'permanently_closed',
  'not_public_place',
  'inappropriate_content',
  'other',
] as const;

export type SubmissionRejectionReason = (typeof SUBMISSION_REJECTION_REASONS)[number];

export function isSubmissionRejectionReason(value: unknown): value is SubmissionRejectionReason {
  return SUBMISSION_REJECTION_REASONS.some((key) => key === value);
}
