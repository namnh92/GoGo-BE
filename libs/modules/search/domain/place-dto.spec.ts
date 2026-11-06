import { describe, expect, it } from 'vitest';
import { toPhotos } from './place-dto';

describe('approved provider photo public representation (#786)', () => {
  it('preserves Google ownership and per-photo credits on detail and list photos', () => {
    const authorAttributions = [
      { displayName: 'Lan', uri: 'https://maps.google.com/contrib/lan', photoUri: null },
    ];
    expect(
      toPhotos(
        [
          {
            id: 'photo',
            storageKey: 'places/provider/photo.jpg',
            width: null,
            height: null,
            source: 'google',
            moderation: 'approved',
            attribution: 'Google Maps',
            providerPhoto: {
              authorAttributions,
              googleMapsUri: 'https://www.google.com/maps/photo/one',
            },
          },
        ],
        'https://assets.test',
        'Generic place attribution',
      ),
    ).toEqual([
      {
        id: 'photo',
        url: 'https://assets.test/places/provider/photo.jpg',
        source: 'google',
        attribution: 'Google Maps',
        authorAttributions,
        googleMapsUri: 'https://www.google.com/maps/photo/one',
      },
    ]);
  });
});
