import { describe, expect, it } from 'vitest';
import { isPublicKey, publicCatalogueUrl, publicMediaUrl } from './media-url';

const BASE = 'https://assets-dev.gogo.id.vn';

describe('public media URLs', () => {
  it('composes a URL for a key on the public host', () => {
    expect(publicMediaUrl(BASE, 'avatars/abc.webp')).toBe(`${BASE}/avatars/abc.webp`);
    expect(publicMediaUrl(`${BASE}/`, '/avatars/abc.webp')).toBe(`${BASE}/avatars/abc.webp`);
  });

  it('answers null where media hosting is not configured', () => {
    expect(publicMediaUrl('', 'avatars/abc.webp')).toBeNull();
    expect(publicMediaUrl(BASE, null)).toBeNull();
  });
});

describe('catalogue URLs (ADR-0005)', () => {
  it('recognises the prefixes that route to the public bucket', () => {
    expect(isPublicKey('places/actor/one.jpg')).toBe(true);
    expect(isPublicKey('banners/actor/one.jpg')).toBe(true);
    expect(isPublicKey('campaigns/actor/one.jpg')).toBe(true);
  });

  it('does not treat private media as public', () => {
    // Check-in and bill photos stay behind a signed GET: publishing somebody's
    // evening or their receipt is not a delivery decision.
    expect(isPublicKey('u/user/actor/one.jpg')).toBe(false);
    expect(isPublicKey('tmp/avatars/actor/one.jpg')).toBe(false);
    // A key that merely mentions a public word is not on a public prefix.
    expect(isPublicKey('u/user/actor/places/one.jpg')).toBe(false);
  });

  it('resolves a catalogue key against the public host', () => {
    expect(publicCatalogueUrl(BASE, 'places/actor/one.jpg')).toBe(`${BASE}/places/actor/one.jpg`);
  });

  /*
   * The legacy shape. Catalogue uploads were presigned against the private
   * bucket under `u/`, and the read URL was composed against the public host
   * regardless — so these keys resolved and returned 404 in every environment.
   * A null says "not readable", which is true and which the console renders as
   * an absence; a URL that 404s is indistinguishable from a broken deploy.
   */
  it('reports a legacy private-bucket key as unreadable, not as a 404 URL', () => {
    expect(publicCatalogueUrl(BASE, 'u/admin/actor/one.jpg')).toBeNull();
  });
});

/*
 * The consumer path composes place photo URLs too (`toPhotos`), and it had the
 * same shape of bug: a legacy key became a URL that 404s, which on a phone is a
 * broken tile in a search result rather than a missing one.
 */
import { toPhotos } from '../search/domain/place-dto';

describe('consumer place photos', () => {
  const row = (storageKey: string) => ({
    id: `m-${storageKey}`,
    storageKey,
    width: 100,
    height: 100,
    source: 'manual' as const,
    moderation: 'approved',
  });

  it('offers a photo that is on the public host', () => {
    const photos = toPhotos([row('places/actor/one.jpg')], BASE);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.url).toBe(`${BASE}/places/actor/one.jpg`);
  });

  it('omits a legacy private-bucket photo rather than serving a dead URL', () => {
    expect(toPhotos([row('u/admin/actor/one.jpg')], BASE)).toHaveLength(0);
  });

  it('still returns nothing when media hosting is not configured', () => {
    expect(toPhotos([row('places/actor/one.jpg')], '')).toHaveLength(0);
  });
});
