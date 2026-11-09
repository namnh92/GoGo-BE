import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminUsers } from './cms';

export const systemAnnouncements = pgTable(
  'system_announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Text keys keep the read contract extensible without ALTER TYPE locks.
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    locale: text('locale').notNull().default('vi'),
    deepLink: text('deep_link'),
    status: text('status').$type<'draft' | 'published' | 'archived'>().notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => adminUsers.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => adminUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('system_announcements_kind_check', sql`${t.kind} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check(
      'system_announcements_copy_check',
      sql`length(btrim(${t.title})) between 1 and 200 and length(btrim(${t.body})) between 1 and 10000`,
    ),
    check('system_announcements_locale_check', sql`${t.locale} = 'vi'`),
    check(
      'system_announcements_status_check',
      sql`${t.status} in ('draft', 'published', 'archived')`,
    ),
    check(
      'system_announcements_publication_check',
      sql`${t.status} <> 'published' or ${t.publishedAt} is not null`,
    ),
    check(
      'system_announcements_expiry_check',
      sql`${t.expiresAt} is null or ${t.publishedAt} is null or ${t.expiresAt} > ${t.publishedAt}`,
    ),
    check(
      'system_announcements_deep_link_check',
      sql`${t.deepLink} is null or ${t.deepLink} ~ '^gogo://(?:(?:place|room|plan)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|invite/[A-Za-z0-9_-]{6,64}|l/[A-Za-z0-9_-]{4,32}|saved|notifications|profile)$'`,
    ),
    index('system_announcements_public_page_idx')
      .on(t.publishedAt.desc(), t.id.desc())
      .where(sql`${t.status} = 'published'`),
    index('system_announcements_cms_page_idx').on(t.createdAt.desc(), t.id.desc()),
  ],
);
