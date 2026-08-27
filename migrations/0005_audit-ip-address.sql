-- BE-IMP-007: staff IP on admin audit rows.
-- Nullable and not backfilled: rows written before this migration genuinely
-- have no IP, and inventing one would be worse than leaving it empty.
-- Recorded for admin actors only — see libs/modules/shared/audit.ts for why.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address text;
