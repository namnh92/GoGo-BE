/** Only server-processed private derivatives use the BFF read door. */
export const SUBMISSION_PHOTO_PREFIX = 'submission-photos/';
export const isSubmissionPhotoKey = (key: string) => key.startsWith(SUBMISSION_PHOTO_PREFIX);
export const communityPhotoUrl = (placeId: string, mediaId: string) =>
  `/v1/places/${placeId}/photos/${mediaId}/content`;
