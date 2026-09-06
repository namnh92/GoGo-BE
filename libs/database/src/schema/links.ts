import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { roomInvites } from './rooms';

/**
 * LNK-BE-001 (#204) — canonical share links, `https://<share-host>/l/{slug}`.
 *
 * The slug is the only thing in a public URL: no user, room or plan id in a
 * query string (FR-LINK-001). It is stored hashed, the way an invite code is
 * (`room_invites.code_hash`), because for a `ROOM_INVITE` the slug *is* the
 * invite code — the app joins with it — and a table of plain slugs next to a
 * table of hashed invite codes would hash nothing. Lookup is by `slug_hash`;
 * the plaintext is returned once, at creation.
 *
 * Provider-agnostic on purpose (FR-LINK-003): switching attribution vendors
 * touches `provider` and `provider_tracking_url`, never the slug or the target.
 */
export const shareLinkType = pgEnum('share_link_type', [
  'ROOM_INVITE',
  'PLAN',
  'PLACE',
  // P1 contract — reserved so the enum, the client router and the edge cache
  // table agree on the vocabulary before either ships.
  'COLLECTION',
  'REFERRAL',
]);

export const shareLinkProvider = pgEnum('share_link_provider', ['NONE', 'TENJIN']);

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 hex of the slug. Never the slug. */
    slugHash: text('slug_hash').notNull(),
    type: shareLinkType('type').notNull(),
    /**
     * What the link points at: `rooms.id` for ROOM_INVITE, `plans.id`,
     * `places.id`, later a collection id or an opaque referral code. Text, not
     * uuid, so the referral contract can hold a code. Authorised *after* the
     * slug resolves, never before (FR-LINK-002).
     */
    targetId: text('target_id').notNull(),
    /**
     * ROOM_INVITE only: the invite this link joins through. Revoking the link
     * revokes the invite; a spent or expired invite makes the link answer 410.
     */
    inviteId: uuid('invite_id').references(() => roomInvites.id, { onDelete: 'cascade' }),
    /** Who minted it — the only actor besides a room host who may revoke it. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    provider: shareLinkProvider('provider').notNull().default('NONE'),
    /**
     * The attribution vendor's click URL with the canonical link as its deferred
     * target. Lives here and nowhere else (spec §6) — never on a room, plan,
     * place or notification.
     */
    providerTrackingUrl: text('provider_tracking_url'),
    /** UTM-style facts the sharer's surface supplied; bounded vocabularies. */
    source: text('source'),
    medium: text('medium'),
    campaign: text('campaign'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('share_links_slug_hash_unique').on(t.slugHash),
    index('share_links_target_idx').on(t.type, t.targetId),
    index('share_links_creator_idx').on(t.createdByUserId),
    index('share_links_expires_idx').on(t.expiresAt),
  ],
);
