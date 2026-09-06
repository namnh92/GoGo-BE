import { describe, expect, it } from 'vitest';
import { SHARE_SLUG_PATTERN, canonicalShareUrl, newShareSlug, shareLinkTarget } from './share-link';

describe('share link domain (#205)', () => {
  it('mints 22-character base64url slugs that every consumer accepts', () => {
    const slugs = new Set(Array.from({ length: 500 }, newShareSlug));
    expect(slugs.size).toBe(500);
    for (const slug of slugs) {
      expect(slug).toHaveLength(22);
      expect(slug).toMatch(SHARE_SLUG_PATTERN);
      // The mobile parser's tighter bound.
      expect(slug).toMatch(/^[A-Za-z0-9_-]{4,32}$/);
    }
  });

  it('a room invite resolves to the slug as invite code, never to the room id', () => {
    expect(shareLinkTarget('ROOM_INVITE', 'room-uuid', 'Af82XcAf82XcAf82XcAf82')).toEqual({
      inviteCode: 'Af82XcAf82XcAf82XcAf82',
    });
    expect(shareLinkTarget('PLAN', 'plan-uuid', 's')).toEqual({ planId: 'plan-uuid' });
    expect(shareLinkTarget('PLACE', 'place-uuid', 's')).toEqual({ placeId: 'place-uuid' });
  });

  it('builds the canonical URL with nothing but the slug', () => {
    expect(canonicalShareUrl('https://go-dev.gogo.id.vn/', 'Af82Xc')).toBe(
      'https://go-dev.gogo.id.vn/l/Af82Xc',
    );
  });
});
