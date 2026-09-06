-- LNK-BE-001 (#204) — canonical share links: https://<share-host>/l/{slug}.
-- (Numbered 0045 in the combined history: it merges after the push-delivery
-- migration; see the note above the type definitions.)
--
-- One table, provider-agnostic. The public URL carries a random slug and
-- nothing else (FR-LINK-001); the target is authorised after the slug
-- resolves, never encoded in the link (FR-LINK-002).
--
-- The slug is stored as a SHA-256 hash, not in clear. For a ROOM_INVITE the
-- slug doubles as the invite code the app joins with, and room_invites already
-- keeps codes hashed — a plaintext slug column beside it would undo that.
-- Lookup is by slug_hash; the slug is shown once, at creation.
--
-- provider records which attribution vendor a link was minted with. The
-- vendor's click URL is deliberately NOT a column: it carries the canonical
-- link, and the canonical link carries the slug — the very credential slug_hash
-- exists to keep out of the table. It is composed at resolve time from the
-- slug the caller presents (spec §6, FR-LINK-003).
--
-- Down:
--   DROP TABLE share_links;
--   DROP TYPE share_link_provider;
--   DROP TYPE share_link_type;
-- No other table references share_links; no data elsewhere depends on it.

-- Idempotent on purpose. The two provider chains (push #193, links #204–#206)
-- were developed side by side and each applied its own migration to its own
-- test databases. Drizzle applies a journal entry only when its `when` exceeds
-- the newest applied one, so the migration merged second must carry the larger
-- `when` — and a database that already ran this one under its earlier `when`
-- will run it again. Every statement here tolerates that.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'share_link_type') THEN
    CREATE TYPE share_link_type AS ENUM ('ROOM_INVITE', 'PLAN', 'PLACE', 'COLLECTION', 'REFERRAL');
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'share_link_provider') THEN
    CREATE TYPE share_link_provider AS ENUM ('NONE', 'TENJIN');
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug_hash text NOT NULL,
  type share_link_type NOT NULL,
  -- rooms.id / plans.id / places.id today; text so a referral code fits later.
  target_id text NOT NULL,
  -- ROOM_INVITE only. Cascade: an invite that is deleted takes its link with it.
  invite_id uuid REFERENCES room_invites(id) ON DELETE CASCADE,
  -- Creator, kept for revoke authorisation. Account deletion leaves the link
  -- revocable by the room host and otherwise expiring on its own.
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider share_link_provider NOT NULL DEFAULT 'NONE',
  source text,
  medium text,
  campaign text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS share_links_slug_hash_unique ON share_links (slug_hash);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS share_links_target_idx ON share_links (type, target_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS share_links_creator_idx ON share_links (created_by_user_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS share_links_expires_idx ON share_links (expires_at);
