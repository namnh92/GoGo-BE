-- #853 policy A, owner 2026-11-11. Additive successor: no activation or TTL release.
SET LOCAL lock_timeout = '5s';
ALTER TABLE assistant_usage_calls
 ADD COLUMN finality_policy text,
 ADD COLUMN billable_cost_usd numeric;
ALTER TABLE assistant_usage_calls ADD CONSTRAINT assistant_usage_calls_billable_cost_usd_check
 CHECK(billable_cost_usd>=0 AND billable_cost_usd<'Infinity'::numeric) NOT VALID;
ALTER TABLE assistant_credit_turns
 ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN recovery_next_at timestamptz;
ALTER TABLE assistant_credit_turns ADD CONSTRAINT assistant_credit_turns_recovery_attempts_check
 CHECK(recovery_attempts BETWEEN 0 AND 5) NOT VALID;
ALTER TABLE assistant_credit_billing_incidents DROP CONSTRAINT assistant_credit_billing_incidents_reason_check;
ALTER TABLE assistant_credit_billing_incidents ADD CONSTRAINT assistant_credit_billing_incidents_reason_check
 CHECK(reason IN ('invalid_cost','receipt_conflict','bound_or_finality','account_invariant','receipt_missing')) NOT VALID;
-- Existing complete calls are promoted per usage by reconciliation, without GET
-- or a table-wide historical UPDATE. Validate the small incident catalogue in ops.
SET LOCAL lock_timeout TO DEFAULT;
