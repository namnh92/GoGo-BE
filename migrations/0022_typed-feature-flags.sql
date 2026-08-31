-- BE-CMS-G3 (#221) — an app flag gets a type, an environment and a platform.
--
-- The row was `key + enabled + opaque payload`, so a minimum app version, a
-- result limit and an iOS-only maintenance switch all had to be smuggled
-- through `payload` and interpreted by whoever read it. The console could not
-- express any of the three dimensions the product needs, and a malformed
-- version was somebody's crash rather than a 400.
--
-- The type and the default live in code (`libs/modules/shared/feature-flags.ts`)
-- next to whatever reads the flag; only the two scoping dimensions are stored,
-- because those are what an operator sets.
--
-- Existing rows keep working: they become the `(all, all)` override, which is
-- what every resolution falls back to, so the import kill switch behaves
-- exactly as it did before this ran.
CREATE TYPE feature_flag_environment AS ENUM ('all', 'dev', 'staging', 'production');--> statement-breakpoint

CREATE TYPE feature_flag_platform AS ENUM ('all', 'ios', 'android', 'web');--> statement-breakpoint

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS environment feature_flag_environment NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS platform feature_flag_platform NOT NULL DEFAULT 'all';--> statement-breakpoint

-- A flag is now identified by what it applies to, not by its name alone:
-- `minimum_app_version` on iOS in production is a different row from the
-- unscoped one. The old primary key made that impossible to store.
ALTER TABLE feature_flags DROP CONSTRAINT IF EXISTS feature_flags_pkey;--> statement-breakpoint

ALTER TABLE feature_flags
  ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key, environment, platform);--> statement-breakpoint

-- Resolution reads every row for one key and picks the most specific match, so
-- the lookup is by key.
CREATE INDEX IF NOT EXISTS feature_flags_key_idx ON feature_flags (key);

-- Rollback (only while no key has more than one row, which is the case for
-- every row this migration created):
--   DROP INDEX IF EXISTS feature_flags_key_idx;
--   DELETE FROM feature_flags WHERE environment <> 'all' OR platform <> 'all';
--   ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_pkey;
--   ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);
--   ALTER TABLE feature_flags DROP COLUMN environment, DROP COLUMN platform;
--   DROP TYPE feature_flag_platform;
--   DROP TYPE feature_flag_environment;
