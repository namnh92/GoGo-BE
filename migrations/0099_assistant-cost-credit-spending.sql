-- #851 / #832 D1. Short successor DDL; no historical charging/backfill.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM credit_events WHERE key IN ('message_spent','assistant_usage','assistant_usage_adjustment')) THEN
  RAISE EXCEPTION 'Reserved assistant billing catalogue key collision';
 END IF;
END $$;
ALTER TABLE credit_events ADD CONSTRAINT credit_events_billing_keys_check
 CHECK (key NOT IN ('message_spent','assistant_usage','assistant_usage_adjustment')) NOT VALID;
--> statement-breakpoint
CREATE TABLE assistant_credit_spend_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 policy_key text NOT NULL DEFAULT 'legacy_allowance_v1'
  CHECK (policy_key IN ('legacy_allowance_v1','free_then_actual_cost_v1')),
 epoch bigint NOT NULL DEFAULT 0 CHECK (epoch>=0),
 activated_at timestamptz,
 bound_version text,
 CHECK ((policy_key='legacy_allowance_v1' AND epoch=0 AND activated_at IS NULL AND bound_version IS NULL)
  OR (policy_key='free_then_actual_cost_v1' AND epoch>0 AND activated_at IS NOT NULL))
);
INSERT INTO assistant_credit_spend_control(singleton) VALUES(true);
--> statement-breakpoint
ALTER TABLE assistant_usage_ledger
 ADD COLUMN billing_policy text,
 ADD COLUMN billing_epoch bigint,
 ADD COLUMN cost_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN dispatch_closed_at timestamptz,
 ADD COLUMN cost_finalized_at timestamptz;
ALTER TABLE assistant_usage_ledger ADD CONSTRAINT assistant_usage_ledger_cost_revision_check
 CHECK (cost_revision>=0) NOT VALID;
--> statement-breakpoint
CREATE TABLE assistant_credit_turns (
 usage_ledger_id uuid PRIMARY KEY,
 user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 message_id uuid,
 conversation_id uuid,
 accepted_at timestamptz NOT NULL,
 free_day date,
 policy_key text NOT NULL CHECK (policy_key IN ('legacy_allowance_v1','free_then_actual_cost_v1')),
 policy_epoch bigint NOT NULL CHECK (policy_epoch>=0),
 funding_source text NOT NULL CHECK (funding_source IN ('free','credit')),
 reserved_ceiling integer NOT NULL CHECK (reserved_ceiling>=0),
 held_credits integer NOT NULL CHECK (held_credits>=0),
 applied_credits integer NOT NULL CHECK (applied_credits>=0),
 bound_version text,
 cost_revision bigint NOT NULL DEFAULT 0 CHECK (cost_revision>=0),
 applied_cost_revision bigint NOT NULL DEFAULT 0 CHECK (applied_cost_revision>=0 AND applied_cost_revision<=cost_revision),
 state text NOT NULL CONSTRAINT assistant_credit_turns_state_values_check CHECK (state IN ('pending','reconciling','settled','quarantined','erased')),
 finalized_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 next_reconcile_at timestamptz,
 lease_owner text,
 lease_expires_at timestamptz,
 retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count>=0),
 CONSTRAINT assistant_credit_turns_funding_check CHECK (
  (funding_source='free' AND free_day IS NOT NULL AND reserved_ceiling=0 AND held_credits=0 AND applied_credits=0 AND bound_version IS NULL)
  OR (funding_source='credit' AND free_day IS NULL AND reserved_ceiling>=1 AND bound_version IS NOT NULL AND applied_credits<=reserved_ceiling)),
 CONSTRAINT assistant_credit_turns_state_check CHECK (
  (state='erased' AND user_id IS NULL AND message_id IS NULL AND conversation_id IS NULL AND held_credits=0)
  OR (funding_source='free' AND state='settled' AND finalized_at IS NOT NULL)
  OR (funding_source='credit' AND (
   (state IN ('pending','reconciling','quarantined') AND finalized_at IS NULL AND applied_credits::bigint+held_credits=reserved_ceiling)
   OR (state IN ('settled','quarantined') AND finalized_at IS NOT NULL AND held_credits=0))))
);
CREATE INDEX assistant_credit_turns_held ON assistant_credit_turns(user_id) WHERE held_credits>0;
CREATE INDEX assistant_credit_turns_reconcile ON assistant_credit_turns(state,next_reconcile_at);
CREATE INDEX assistant_credit_turns_conversation ON assistant_credit_turns(user_id,conversation_id,accepted_at,usage_ledger_id);
--> statement-breakpoint
-- Lossless per-call evidence; D2 supplies the producer.
CREATE TABLE assistant_usage_calls (
 usage_ledger_id uuid NOT NULL,
 call_index integer NOT NULL CHECK (call_index>=0),
 provider text NOT NULL,
 model text NOT NULL,
 dispatch_state text NOT NULL DEFAULT 'intent' CHECK (dispatch_state IN ('intent','dispatched','ambiguous','closed')),
 provider_request_id text,
 provider_generation_id text,
 direct_cost_usd numeric CHECK (direct_cost_usd>=0 AND direct_cost_usd<'Infinity'::numeric),
 upstream_cost_usd numeric CHECK (upstream_cost_usd>=0 AND upstream_cost_usd<'Infinity'::numeric),
 fee_cost_usd numeric CHECK (fee_cost_usd>=0 AND fee_cost_usd<'Infinity'::numeric),
 receipt_fingerprint text,
 receipt_revision bigint CHECK (receipt_revision>0),
 cost_state text NOT NULL DEFAULT 'unknown' CHECK (cost_state IN ('unknown','complete','final','quarantined')),
 created_at timestamptz NOT NULL DEFAULT now(),
 dispatched_at timestamptz,
 finalized_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(usage_ledger_id,call_index)
);
CREATE UNIQUE INDEX assistant_usage_calls_receipt_unique ON assistant_usage_calls(provider,usage_ledger_id,call_index,receipt_fingerprint) WHERE receipt_fingerprint IS NOT NULL;
--> statement-breakpoint
ALTER TABLE assistant_credit_ledger ADD COLUMN cost_revision bigint;
ALTER TABLE assistant_credit_ledger DROP CONSTRAINT assistant_credit_ledger_check;
ALTER TABLE assistant_credit_ledger ADD CONSTRAINT assistant_credit_ledger_check CHECK (
 (reason='submission_approved' AND delta IN (20,50,70) AND submission_id IS NOT NULL
  AND venue_identity IS NOT NULL AND usage_ledger_id IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL AND cost_revision IS NULL
  AND ((credit_event_id IS NULL AND entitlement_key IS NULL)
    OR (credit_event_id='82900000-0000-4000-8000-000000000001' AND entitlement_key IS NOT NULL)))
 OR (reason='message_spent' AND delta<0 AND usage_ledger_id IS NOT NULL AND (cost_revision IS NULL OR cost_revision>0)
  AND submission_id IS NULL AND venue_identity IS NULL AND credit_event_id IS NULL
  AND entitlement_key IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL)
 OR (reason='assistant_usage_adjustment' AND delta<>0 AND usage_ledger_id IS NOT NULL AND cost_revision>0 AND cost_revision IS NOT NULL
  AND submission_id IS NULL AND venue_identity IS NULL AND credit_event_id IS NULL
  AND entitlement_key IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL)
 OR (reason NOT IN ('message_spent','assistant_usage','assistant_usage_adjustment') AND credit_event_id IS NOT NULL AND entitlement_key IS NOT NULL
  AND delta>0 AND usage_ledger_id IS NULL AND cost_revision IS NULL)
) NOT VALID;
SET LOCAL lock_timeout TO DEFAULT;
