-- PROF-BE-013 (#573). Optional date of birth on the account profile: read and written only by
-- the owner through GET/PATCH /me, included in the authenticated export, nulled on account
-- deletion. A calendar date, so `date`, never a timestamp that a time zone could shift.
-- Numbered 0065 because 0063 and 0064 are reserved by open PRs #581 and #582. Drizzle skips a
-- migration whose journal `when` is older than the last one applied, so whichever of these
-- merges after a higher-numbered one must raise its `when` above every applied entry.
-- Additive nullable column with no default and no backfill: an existing account reads null.
-- Application rollback keeps this column. Rehearsal-only down:
-- ALTER TABLE users DROP COLUMN date_of_birth;
ALTER TABLE users ADD COLUMN date_of_birth date;
