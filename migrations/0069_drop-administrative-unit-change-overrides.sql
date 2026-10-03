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
-- fails here and the data survives for a human to look at. The table is
-- locked ACCESS EXCLUSIVE *before* the check and the lock is held through the
-- DROP (drizzle runs every pending migration in one transaction), so no
-- concurrent writer can commit a row between "empty" and DROP.
--
-- Locks and timeout: ACCESS EXCLUSIVE on this table (nothing references it,
-- nothing reads it). DROP also takes a lock on `admin_users` to remove the FK
-- triggers, and that one *can* queue behind a long transaction on admin_users
-- (e.g. a slow CMS auth query) — and while it waits, new admin_users queries
-- queue behind it. `lock_timeout = 5s` bounds that wait: if any lock is not
-- granted within 5s, this migration (and the whole deploy transaction) aborts
-- with `canceling statement due to lock timeout`, nothing is dropped, and the
-- deploy can simply be retried. The timeout is reset to the session default at
-- the end so later migrations in the same transaction are unaffected.
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
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.administrative_unit_change_overrides') IS NOT NULL THEN
    LOCK TABLE public.administrative_unit_change_overrides IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.administrative_unit_change_overrides) THEN
      RAISE EXCEPTION 'administrative_unit_change_overrides is not empty; refusing to drop (GoGo-BE#486)';
    END IF;
  END IF;
END
$$;--> statement-breakpoint
DROP INDEX IF EXISTS administrative_unit_change_overrides_live_unique;--> statement-breakpoint
DROP INDEX IF EXISTS administrative_unit_change_overrides_old_idx;--> statement-breakpoint
DROP TABLE IF EXISTS administrative_unit_change_overrides;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
