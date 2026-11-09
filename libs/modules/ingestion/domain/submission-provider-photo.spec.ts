import { describe, expect, it } from 'vitest';
import {
  submissionPhotoView,
  submissionProviderPhotoSchema,
  updateDeadline,
} from './submission-provider-photo';

export const storedPhoto = {
  provider: 'google' as const,
  storageKey: 'places/provider/11111111-1111-4111-8111-111111111111.jpg',
  contentType: 'image/jpeg' as const,
  width: null,
  height: null,
  fetchedAt: '2026-11-09T00:00:00.000Z',
  sourceReference: 'ChIJ-822',
  attribution: 'Google Maps' as const,
  authorAttributions: [{ displayName: 'Lan', uri: null, photoUri: null }],
  googleMapsUri: null,
};
describe('ADR-0052 submission photo projection', () => {
  it('returns a CDN photo with credits, omits private retention facts and original dimensions', () => {
    const photo = submissionPhotoView(storedPhoto, 'https://assets.test');
    expect(photo).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      source: 'google',
      attribution: 'Google Maps',
      authorAttributions: storedPhoto.authorAttributions,
    });
    expect(JSON.stringify(photo)).not.toMatch(
      /storageKey|sourceReference|retiredAt|deleteAfter|width|height/,
    );
    expect(submissionPhotoView(storedPhoto, '')).toBeUndefined();
  });
  it('rejects any attempt to store a Google photo name, retrieval URL or extra key', () => {
    expect(
      submissionProviderPhotoSchema.safeParse({
        ...storedPhoto,
        photoName: 'places/x/photos/secret',
      }).success,
    ).toBe(false);
    expect(
      submissionProviderPhotoSchema.safeParse({
        ...storedPhoto,
        storageKey: 'https://google.test/photo?key=secret',
      }).success,
    ).toBe(false);
  });
  it('shows rejected photo strictly before the deadline; all reasons share seven days', () => {
    const decided = '2026-11-09T00:00:00.000Z';
    const deadline = Date.parse(updateDeadline('rejected', decided)!);
    expect(
      submissionPhotoView(storedPhoto, 'https://assets.test', 'rejected', decided, deadline - 1),
    ).toBeDefined();
    expect(
      submissionPhotoView(storedPhoto, 'https://assets.test', 'rejected', decided, deadline),
    ).toBeUndefined();
    expect(
      submissionPhotoView(storedPhoto, 'https://assets.test', 'rejected', decided, deadline + 1),
    ).toBeUndefined();
    expect(updateDeadline('pending', decided)).toBeUndefined();
    expect(updateDeadline('approved', decided)).toBeUndefined();
    expect(updateDeadline('rejected', decided)).toBe('2026-11-16T00:00:00.000Z');
  });
});
