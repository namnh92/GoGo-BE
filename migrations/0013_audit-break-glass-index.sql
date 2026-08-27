-- BE-IMP-010 — the incident-review query.
--
-- `GET /cms/audit?breakGlass=true` filters on a jsonb key, which no existing
-- index covers: audit_logs_resource_idx and audit_logs_actor_idx both lead
-- with columns this query does not constrain. Emergency takedowns are a tiny
-- fraction of the table, so a partial index stays small no matter how large
-- the log grows, and it carries the sort key so the page comes back ordered.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migrator runs each file in a
-- transaction, where CONCURRENTLY is not allowed. It takes a write lock on
-- audit_logs for the build. That is acceptable now (the table is empty — the
-- database is not provisioned yet, #21); once the log is large this index
-- should be built out-of-band with CONCURRENTLY and this migration marked
-- applied, rather than held inside a deploy.
create index if not exists audit_logs_break_glass_idx
  on audit_logs (created_at desc, id desc)
  where diff->>'breakGlass' = 'true';

-- Rollback: drop index if exists audit_logs_break_glass_idx;
