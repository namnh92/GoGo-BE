-- GoGo-BE#228, ADR-0029. A plan stop is required or optional; only the host
-- sets it, and every historical stop stays required.
--
-- Additive: ADD COLUMN with a constant DEFAULT is a catalogue-only change on
-- Postgres 11+ (no table rewrite, a brief ACCESS EXCLUSIVE for the catalogue
-- update only). Plan `totals` JSON is not rewritten: a totals object without
-- the required/optional split reads as required = existing totals, optional = 0.
--
-- Lock wait is bounded (F-04): if a long transaction holds plan_stops, the
-- ALTER gives up after 5s with SQLSTATE 55P03 instead of queueing every plan
-- read behind it. The migrator runs all pending files in one transaction, so
-- the whole run rolls back and nothing changes; retry the deploy once the
-- holder is gone (pg_stat_activity / pg_locks on plan_stops). The timeout is
-- reset right after so later files in the same run keep the server default.
--
-- Rollback (ADR-0029 §Rollback): install the rollback guard before deploying
-- an older API, keep the column. Rehearsal-only down:
-- ALTER TABLE plan_stops DROP COLUMN is_optional;
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE plan_stops ADD COLUMN IF NOT EXISTS is_optional boolean NOT NULL DEFAULT false;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
