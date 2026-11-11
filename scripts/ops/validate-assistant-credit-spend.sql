-- Post-commit validation, no backfill or repair. ON_ERROR_STOP is mandatory.
\set ON_ERROR_STOP on
\ir index-assistant-credit-spend.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE assistant_usage_ledger VALIDATE CONSTRAINT assistant_usage_ledger_cost_revision_check;
ALTER TABLE assistant_credit_ledger VALIDATE CONSTRAINT assistant_credit_ledger_check;
ALTER TABLE assistant_credit_ledger VALIDATE CONSTRAINT assistant_credit_event_reason_fk;
ALTER TABLE credit_events VALIDATE CONSTRAINT credit_events_billing_keys_check;
DO $$ BEGIN
 IF (SELECT count(*) FROM assistant_credit_spend_control)<>1 THEN RAISE EXCEPTION 'Missing control'; END IF;
 IF EXISTS(SELECT 1 FROM credit_events WHERE key IN ('message_spent','assistant_usage','assistant_usage_adjustment')) THEN RAISE EXCEPTION 'Reserved key'; END IF;
 IF EXISTS(SELECT 1 FROM (SELECT user_id,sum(delta)::numeric AS total FROM assistant_credit_ledger WHERE user_id IS NOT NULL GROUP BY user_id) l
  FULL JOIN assistant_credit_accounts a USING(user_id) WHERE coalesce(a.balance,0)<>coalesce(l.total,0)) THEN RAISE EXCEPTION 'Wallet/ledger mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM (SELECT user_id,sum(held_credits)::numeric AS held FROM assistant_credit_turns WHERE user_id IS NOT NULL GROUP BY user_id) t
  LEFT JOIN assistant_credit_accounts a USING(user_id) WHERE held<0 OR held>coalesce(a.balance,0)) THEN RAISE EXCEPTION 'Hold/balance mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM assistant_credit_turns WHERE applied_cost_revision>cost_revision
  OR (state IN ('pending','reconciling','quarantined') AND finalized_at IS NULL AND applied_credits::bigint+held_credits<>reserved_ceiling)
  OR (finalized_at IS NOT NULL AND held_credits<>0)) THEN RAISE EXCEPTION 'Turn invariant'; END IF;
 IF (SELECT count(*) FROM credit_events WHERE trigger_schema_version=2 AND condition_version=1 AND audience='individual' AND (
  (id='82900000-0000-4000-8000-000000000001'::uuid AND key='submission_approved' AND amount=50 AND trigger_event_type='place.submission_decided' AND dedup_scope='per_venue' AND condition='{"all":[{"fact":"decision","op":"eq","value":"approved"}]}'::jsonb)
  OR (id='82900000-0000-4000-8000-000000000002'::uuid AND key='submission_evidence' AND amount=10 AND trigger_event_type='place.submission_evidence_approved' AND dedup_scope='per_source' AND condition='{"all":[]}'::jsonb)
  OR (id='82900000-0000-4000-8000-000000000003'::uuid AND key='review_published' AND amount=5 AND trigger_event_type='review.published' AND dedup_scope='per_place_subject' AND condition='{"all":[{"fact":"target","op":"eq","value":"place"},{"fact":"firstPublication","op":"eq","value":true}]}'::jsonb)
 ))<>3 THEN RAISE EXCEPTION 'Seed mismatch'; END IF;
END $$;
COMMIT;

DO $$ BEGIN
 IF to_regclass('assistant_credit_billing_incidents') IS NOT NULL THEN
  ALTER TABLE assistant_credit_billing_incidents VALIDATE CONSTRAINT assistant_credit_billing_incidents_reason_check;
 END IF;
END $$;

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('assistant_usage_calls') AND conname='assistant_usage_calls_billable_cost_usd_check') THEN
  ALTER TABLE assistant_usage_calls VALIDATE CONSTRAINT assistant_usage_calls_billable_cost_usd_check;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('assistant_credit_turns') AND conname='assistant_credit_turns_recovery_attempts_check') THEN
  ALTER TABLE assistant_credit_turns VALIDATE CONSTRAINT assistant_credit_turns_recovery_attempts_check;
 END IF;
END $$;
