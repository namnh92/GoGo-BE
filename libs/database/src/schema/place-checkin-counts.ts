import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { places } from './places';
import { stopCheckins } from './plans';

// Maintained only by migration 0082's triggers. Visits cascade with their source;
// room identities disappear with their last visit, including erasure cascades.
export const placeCheckinVisits = pgTable('place_checkin_visits', {
  checkinId: uuid('checkin_id')
    .primaryKey()
    .references(() => stopCheckins.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  placeId: uuid('place_id').notNull(),
  roomId: uuid('room_id').notNull(),
});

export const placeCheckinRooms = pgTable(
  'place_checkin_rooms',
  {
    placeId: uuid('place_id').notNull(),
    roomId: uuid('room_id').notNull(),
    checkinCount: integer('checkin_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.placeId, t.roomId] }),
    check('place_checkin_rooms_checkin_count_check', sql`${t.checkinCount} >= 0`),
  ],
);

export const placeCheckinCounts = pgTable(
  'place_checkin_counts',
  {
    placeId: uuid('place_id')
      .primaryKey()
      .references(() => places.id, { onDelete: 'cascade' }),
    groupCount: integer('group_count').notNull(),
  },
  (t) => [check('place_checkin_counts_group_count_check', sql`${t.groupCount} >= 0`)],
);
