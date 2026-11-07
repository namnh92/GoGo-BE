-- GoGo-BE#796: run AFTER db:migrate returns (DDL committed). Safe to retry.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE assistant_credit_ledger VALIDATE CONSTRAINT assistant_credit_ledger_check;
COMMIT;
