-- Short transactional DDL on a new, empty table. No backfill or hot-table scan.
-- Binary rollback: retain this table and its audit rows; old binaries ignore it.
-- Physical removal requires a later maintenance migration after client traffic
-- drains and editorial data has been exported. Never delete audit history.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE system_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  locale text NOT NULL DEFAULT 'vi',
  deep_link text,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES admin_users(id),
  updated_by uuid NOT NULL REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_announcements_kind_check CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT system_announcements_copy_check CHECK (length(btrim(title)) BETWEEN 1 AND 200 AND length(btrim(body)) BETWEEN 1 AND 10000),
  CONSTRAINT system_announcements_locale_check CHECK (locale = 'vi'),
  CONSTRAINT system_announcements_status_check CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT system_announcements_publication_check CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT system_announcements_expiry_check CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at),
  CONSTRAINT system_announcements_deep_link_check CHECK (deep_link IS NULL OR deep_link ~ '^gogo://(?:(?:place|room|plan)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|invite/[A-Za-z0-9_-]{6,64}|l/[A-Za-z0-9_-]{4,32}|saved|notifications|profile)$')
);
--> statement-breakpoint
CREATE INDEX system_announcements_public_page_idx ON system_announcements (published_at DESC, id DESC) WHERE status = 'published';
--> statement-breakpoint
CREATE INDEX system_announcements_cms_page_idx ON system_announcements (created_at DESC, id DESC);
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
