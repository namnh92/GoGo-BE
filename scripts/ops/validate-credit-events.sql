-- Run after DDL/index commit and final legacy reconciliation, never inside DDL.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE assistant_credit_ledger VALIDATE CONSTRAINT assistant_credit_ledger_check;
ALTER TABLE assistant_credit_ledger VALIDATE CONSTRAINT assistant_credit_event_reason_fk;
COMMIT;
