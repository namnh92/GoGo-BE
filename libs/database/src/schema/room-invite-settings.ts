import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One setting per primary database. Admin identity is historical, without a foreign key. */
export const roomInviteSettings = pgTable(
  'room_invite_settings',
  {
    id: smallint('id').primaryKey(),
    ttlSeconds: integer('ttl_seconds').notNull().default(86400),
    version: bigint('version', { mode: 'bigint' }).notNull().default(1n),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (t) => [
    check('room_invite_settings_singleton', sql`${t.id} = 1`),
    check('room_invite_settings_ttl_positive', sql`${t.ttlSeconds} > 0`),
    check('room_invite_settings_version_positive', sql`${t.version} > 0`),
  ],
);
