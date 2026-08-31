-- BE-CMS-G9 (#248) — staff account lifecycle.
--
-- A temporary password is only a credential the holder must not keep. Issuing
-- one without recording that it must be replaced leaves an administrator-known
-- password in place indefinitely, which is worse than the lockout it was meant
-- to fix: two people now know it, and only one of them is in the audit trail.
--
-- Stored as a timestamp rather than a boolean, so the audit answers *when* the
-- obligation started as well as that it exists. NULL means nothing is owed.
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS must_change_password_at timestamptz;
