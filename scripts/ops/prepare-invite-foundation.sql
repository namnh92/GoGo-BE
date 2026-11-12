-- Run with psql -X -v ON_ERROR_STOP=1, autocommit, AFTER db:migrate.
-- Never pass -1 / --single-transaction. Interrupted same-name invalid index:
-- DROP INDEX CONCURRENTLY users_host_share_id_unique; then rerun this file.
-- Runtime readiness checks reject a missing, invalid or incompatible index.
SET lock_timeout = '3s';
SET statement_timeout = '5min';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_host_share_id_unique ON users(host_share_id);
ALTER TABLE users VALIDATE CONSTRAINT users_host_share_id_format;
ALTER TABLE rooms VALIDATE CONSTRAINT rooms_invitation_epoch_nonnegative;
ALTER TABLE room_invites VALIDATE CONSTRAINT room_invites_epoch_nonnegative;
ALTER TABLE share_links VALIDATE CONSTRAINT share_links_epoch_nonnegative;
ALTER TABLE share_links VALIDATE CONSTRAINT share_links_path_metadata;
RESET lock_timeout;
RESET statement_timeout;
