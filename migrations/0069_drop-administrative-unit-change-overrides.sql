-- GoGo-BE#486 (ADM-012). Drop `administrative_unit_change_overrides`.
--
-- Created in 0051 (ADM-001) as a global override, keyed by `old_code`, that
-- "wins over the upstream mapping at resolve time". #484 rejected that
-- semantics: only the content of a PUBLISHED dataset may change resolver
-- precedence. ADM-011 (#484, migration 0056) replaced it with append-only
-- decisions in an override set, materialised into a new STAGED dataset. No
-- service, repository, script, seed or sibling repo (CMS/Infra/Mobile/Web)
-- ever read or wrote this table. Owner decision 2026-10-02 on #486: drop it in
-- its own migration.
--
-- Guard: refuse to drop a table that holds rows. The issue's precondition is
-- `select count(*) = 0` in every environment; if that is not true the deploy
-- fails here and the data survives for a human to look at.
--
-- Locks: ACCESS EXCLUSIVE on this table only. Nothing references it (no FK
-- points at it; its own FKs point at admin_users, whose lock is brief), and
-- nothing queries it, so there is no queue to wait behind.
--
-- ---------------------------------------------------------------------------
-- Down (re-creates the 0051 shape, empty; there is no data to restore):
--   CREATE TABLE IF NOT EXISTS administrative_unit_change_overrides (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     old_code text NOT NULL,
--     new_code text,
--     change_type administrative_change_type NOT NULL,
--     effective_date date NOT NULL,
--     legal_reference text,
--     reason text NOT NULL,
--     decided_against_version text NOT NULL,
--     created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
--     created_at timestamptz NOT NULL DEFAULT now(),
--     revoked_at timestamptz,
--     revoked_by uuid REFERENCES admin_users(id) ON DELETE SET NULL
--   );
--   CREATE UNIQUE INDEX IF NOT EXISTS administrative_unit_change_overrides_live_unique
--     ON administrative_unit_change_overrides (old_code, COALESCE(new_code, ''), change_type)
--     WHERE revoked_at IS NULL;
--   CREATE INDEX IF NOT EXISTS administrative_unit_change_overrides_old_idx
--     ON administrative_unit_change_overrides (old_code)
--     WHERE revoked_at IS NULL;
-- Application rollback needs no down: no released code touches the table.
DO $$
BEGIN
  IF to_regclass('public.administrative_unit_change_overrides') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.administrative_unit_change_overrides) THEN
      RAISE EXCEPTION 'administrative_unit_change_overrides is not empty; refusing to drop (GoGo-BE#486)';
    END IF;
  END IF;
END
$$;--> statement-breakpoint
DROP INDEX IF EXISTS administrative_unit_change_overrides_live_unique;--> statement-breakpoint
DROP INDEX IF EXISTS administrative_unit_change_overrides_old_idx;--> statement-breakpoint
DROP TABLE IF EXISTS administrative_unit_change_overrides;
