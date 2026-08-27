-- CMS-001 (#62) — the second factor was not behaving like one.
--
-- Three problems this fixes, plus per-account lockout in the service layer:
--
-- 1. The column is named `mfa_totp_secret_enc` but held the raw secret. An
--    attacker with a database dump already has the password hashes; the TOTP
--    secret is the thing that is supposed to still stop them, and in plaintext
--    it stopped nothing.
--
-- 2. Enrollment wrote the secret and switched MFA on in the same step, with no
--    proof the admin could actually generate a code. In production, where MFA
--    is required, that locks the account out of its own console.
--
-- 3. A TOTP code stayed valid for the whole of its 30-second step, so an
--    intercepted code could be replayed within it.

alter table admin_users
  -- Enrolled but not yet proven. Promoted to mfa_totp_secret_enc only after a
  -- code generated from it verifies.
  add column if not exists mfa_totp_pending_enc text,
  -- Highest TOTP step already consumed. A code from that step or earlier is
  -- refused even while it is still inside its validity window.
  add column if not exists mfa_totp_last_step bigint,
  add column if not exists mfa_enrolled_at timestamptz;

-- Existing secrets are plaintext and cannot be encrypted here (the key lives
-- in the application, not the database). They are moved back to pending so the
-- next login is refused and the admin re-enrolls, rather than silently
-- carrying a plaintext secret forward under a column name that claims
-- otherwise. There are no production admins yet (#21), so this costs nothing
-- now and would be a deliberate, announced re-enrollment later.
update admin_users
set mfa_totp_pending_enc = null,
    mfa_totp_secret_enc = null
where mfa_totp_secret_enc is not null;

-- Rollback:
--   alter table admin_users
--     drop column if exists mfa_totp_pending_enc,
--     drop column if exists mfa_totp_last_step,
--     drop column if exists mfa_enrolled_at;
