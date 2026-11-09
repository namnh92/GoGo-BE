-- Run only after 0096 migration has committed (separate short validation locks).
SET lock_timeout = '5s';
ALTER TABLE notification_settings VALIDATE CONSTRAINT notification_quiet_timezone;
ALTER TABLE notification_push_deliveries VALIDATE CONSTRAINT notification_push_deliveries_status_check;
RESET lock_timeout;
