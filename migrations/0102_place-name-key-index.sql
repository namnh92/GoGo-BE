-- #857: deliberately no index build inside the migration transaction.
-- Mandatory post-deploy ops: scripts/ops/index-place-name-key.sql, AUTOCOMMIT.
-- resolvePlaceName checks exact index shape/validity/readiness on every read and
-- fails closed until ops succeeds. This also covers previously applied 0102.
-- Recovery: DROP INDEX CONCURRENTLY places_name_key_idx, then rerun that script.
SELECT 1;
