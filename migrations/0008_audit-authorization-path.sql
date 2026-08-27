-- SEC-002: which rule let a CMS write through — exact_role, rank_read, or
-- super_admin_bypass. Counting the last one answers "is the role model matching
-- the work, or being routed around?" without needing a metrics backend.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS authorization_path text;
