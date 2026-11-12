import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { rooms } from './rooms';

/** I03: immutable generations, including CLOSED history. No plaintext credential. */
export const roomInviteCodes = pgTable(
  'room_invite_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    invitationEpoch: bigint('invitation_epoch', { mode: 'bigint' }).notNull(),
    codeLookup: text('code_lookup').notNull(),
    codeCiphertext: text('code_ciphertext').notNull(),
    encryptionKeyVersion: text('encryption_key_version').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    reservationState: text('reservation_state').notNull().default('OPEN'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
    // Historical membership identifier, like room_invites; may outlive membership erasure.
    createdByMemberId: uuid('created_by_member_id').notNull(),
  },
  (t) => [
    uniqueIndex('room_invite_codes_open_lookup_unique')
      .on(t.codeLookup)
      .where(sql`${t.reservationState} = 'OPEN'`),
    uniqueIndex('room_invite_codes_open_room_unique')
      .on(t.roomId)
      .where(sql`${t.reservationState} = 'OPEN'`),
    index('room_invite_codes_history_idx').on(t.roomId, t.issuedAt),
    check('room_invite_codes_epoch_nonnegative', sql`${t.invitationEpoch} >= 0`),
    check('room_invite_codes_lookup_format', sql`${t.codeLookup} ~ '^[0-9a-f]{64}$'`),
    check('room_invite_codes_ciphertext_format', sql`${t.codeCiphertext} ~ '^[A-Za-z0-9_-]{46}$'`),
    check(
      'room_invite_codes_key_version_format',
      sql`${t.encryptionKeyVersion} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    check(
      'room_invite_codes_lifetime',
      sql`${t.expiresAt} > ${t.issuedAt} and ${t.expiresAt} <= ${t.issuedAt} + interval '48 hours'`,
    ),
    check(
      'room_invite_codes_reservation_state',
      sql`(
    (${t.reservationState} = 'OPEN' and ${t.revokedAt} is null and ${t.releasedAt} is null and ${t.releaseReason} is null) or
    (${t.reservationState} = 'CLOSED' and ${t.releasedAt} is not null and ${t.releasedAt} >= ${t.issuedAt}
      and ${t.releaseReason} is not null and ${t.releaseReason} in ('EXPIRY','START','CLOSE','ROTATE','REVOKE')
      and (${t.revokedAt} is null or (${t.revokedAt} >= ${t.issuedAt} and ${t.revokedAt} <= ${t.releasedAt})))
  )`,
    ),
  ],
);
