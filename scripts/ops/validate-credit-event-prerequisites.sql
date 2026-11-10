-- Run after 0097 commits; no eligibility or ledger backfill is required in S1.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE reviews VALIDATE CONSTRAINT reviews_credit_epoch_positive;
COMMIT;
