import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { places } from './places';

/**
 * DB-008 — CMS RBAC/audit/config/collection schema.
 * audit_logs is append-only at the application layer: no update/delete path
 * exists in any repository, and CMS exposes read-only access (FR-CMS-008).
 */

export const adminRole = pgEnum('admin_role', ['editor', 'moderator', 'ops_admin', 'super_admin']);
export const adminStatus = pgEnum('admin_status', ['active', 'suspended']);

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    // Password auth only outside production; production requires SSO/MFA.
    passwordHash: text('password_hash'),
    ssoSubject: text('sso_subject'),
    mfaTotpSecretEnc: text('mfa_totp_secret_enc'),
    displayName: text('display_name').notNull(),
    role: adminRole('role').notNull(),
    status: adminStatus('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_users_email_unique').on(t.email)],
);

export const auditActorType = pgEnum('audit_actor_type', ['admin', 'user', 'system']);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    // Before/after diff of the sensitive write; PII minimized at write time.
    diff: jsonb('diff'),
    requestId: text('request_id'),
    /**
     * Staff IP for admin actions only. It is PII, so user/guest actions never
     * populate it: the justification is staff accountability — telling "that
     * admin did it" apart from "that admin's account was taken over".
     */
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId, t.createdAt),
    index('audit_logs_actor_idx').on(t.actorType, t.actorId, t.createdAt),
  ],
);

export const rankingConfigStatus = pgEnum('ranking_config_status', [
  'draft',
  'approved',
  'active',
  'rolled_back',
]);

/** FR-CMS-007 — versioned ranking/scoring weights with approval + rollback. */
export const rankingConfigs = pgTable(
  'ranking_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    weights: jsonb('weights').$type<Record<string, number>>().notNull(),
    // Allowed min/max per weight — engine rejects configs outside bounds.
    bounds: jsonb('bounds').$type<Record<string, { min: number; max: number }>>().notNull(),
    status: rankingConfigStatus('status').notNull().default('draft'),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    approvedByAdminId: uuid('approved_by_admin_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ranking_configs_key_version_unique').on(t.key, t.version),
    uniqueIndex('ranking_configs_key_active_unique')
      .on(t.key)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  payload: jsonb('payload'),
  description: text('description'),
  updatedByAdminId: uuid('updated_by_admin_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const collectionStatus = pgEnum('collection_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);

export const contentCollections = pgTable(
  'content_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    locale: text('locale').notNull().default('vi'),
    title: text('title').notNull(),
    description: text('description'),
    status: collectionStatus('status').notNull().default('draft'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('content_collections_slug_locale_unique').on(t.slug, t.locale)],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => contentCollections.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('collection_items_unique').on(t.collectionId, t.placeId)],
);
