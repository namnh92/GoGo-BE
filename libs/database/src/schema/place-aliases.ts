import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { places } from './places';
import { adminUsers } from './cms';

/** CMS staff identity is separate from consumer users; hard deletion anonymizes attribution. */
export const placeAliases = pgTable(
  'place_aliases',
  {
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    aliasNormalized: text('alias_normalized').notNull(),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sourceType: text('source_type').notNull(),
    sourceReference: text('source_reference').notNull(),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'place_aliases_place_normalized_unique',
      columns: [t.placeId, t.aliasNormalized],
    }),
    index('place_aliases_normalized_trgm_idx').using('gin', t.aliasNormalized.op('gin_trgm_ops')),
    index('place_aliases_normalized_idx').on(t.aliasNormalized),
    check(
      'place_aliases_alias_valid',
      sql`char_length(${t.alias}) between 1 and 120 and btrim(${t.alias}) <> '' and ${t.alias} !~ '[[:cntrl:]]' and ${t.aliasNormalized} <> ''`,
    ),
    check(
      'place_aliases_source_valid',
      sql`${t.sourceType} = 'editorial' and char_length(btrim(${t.sourceReference})) between 1 and 500`,
    ),
  ],
);
