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
