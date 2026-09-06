import { randomBytes } from 'node:crypto';

/**
 * LNK-BE-002 (#205) — the canonical share link, `https://<share-host>/l/{slug}`.
 *
 * P0 types are issued; COLLECTION and REFERRAL are reserved contract
 * (spec §13) and refused at creation until their targets exist.
 */
export const SHARE_LINK_TYPES = ['ROOM_INVITE', 'PLAN', 'PLACE', 'COLLECTION', 'REFERRAL'] as const;
export type ShareLinkType = (typeof SHARE_LINK_TYPES)[number];

export const ISSUED_SHARE_LINK_TYPES: readonly ShareLinkType[] = ['ROOM_INVITE', 'PLAN', 'PLACE'];

export type ShareLinkProvider = 'NONE' | 'TENJIN';

/** Matches the edge worker (`{6,64}`) and the mobile parser (`{4,32}`). */
export const SHARE_SLUG_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * 128 bits, base64url, 22 characters — the same entropy as a room invite code,
 * because for a ROOM_INVITE the slug *is* the invite code (FR-LINK-004 hands the
 * client `gogo://invite/{inviteCode}`). No PII, no business identifier, nothing
 * to enumerate: 2^128 keeps a resolve endpoint safe from guessing without
 * relying on the rate limit alone.
 */
export function newShareSlug(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * What the client does with a resolved link (spec §13 `DeepLinkAction`). The
 * target never carries more than the client needs to route: a ROOM_INVITE
 * yields the code to join with, not the room; a PLAN yields the plan id, and
 * the plan endpoint authorises membership.
 */
export type ShareLinkTarget =
  | { inviteCode: string }
  | { planId: string }
  | { placeId: string }
  | { collectionId: string }
  | { code: string };

export function shareLinkTarget(
  type: ShareLinkType,
  targetId: string,
  slug: string,
): ShareLinkTarget {
  switch (type) {
    case 'ROOM_INVITE':
      return { inviteCode: slug };
    case 'PLAN':
      return { planId: targetId };
    case 'PLACE':
      return { placeId: targetId };
    case 'COLLECTION':
      return { collectionId: targetId };
    case 'REFERRAL':
      return { code: targetId };
  }
}

export function canonicalShareUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/l/${slug}`;
}
