-- AUTOCOMMIT after expansion. These scans do not retain expansion's table DDL locks.
SET lock_timeout = '3s';
SET statement_timeout = '15min';
ALTER TABLE rooms VALIDATE CONSTRAINT rooms_host_version_positive;
ALTER TABLE room_members VALIDATE CONSTRAINT room_members_host_user;
