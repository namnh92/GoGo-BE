-- #829 S2: short DDL only. Concurrent indexes and validation are separate ops.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE credit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 UNIQUE (id,key),
 key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$' AND key <> 'message_spent'),
 labels jsonb NOT NULL,
 trigger_event_type text NOT NULL,
 trigger_schema_version integer NOT NULL CHECK (trigger_schema_version > 0),
 condition jsonb NOT NULL,
 condition_version integer NOT NULL DEFAULT 1 CHECK (condition_version = 1),
 audience text NOT NULL CHECK (audience IN ('individual','group')),
 dedup_scope text NOT NULL CHECK (dedup_scope IN ('per_venue','per_source','per_place_subject','per_subject','per_occurrence')),
 amount integer NOT NULL CHECK (amount > 0),
 starts_at timestamptz NOT NULL DEFAULT '-infinity',
 ends_at timestamptz,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
 closed_reason text CHECK (closed_reason IN ('manual','budget_exhausted')),
 max_per_user integer CHECK (max_per_user > 0),
 max_per_group integer CHECK (max_per_group > 0),
 budget_total integer CHECK (budget_total > 0),
 budget_used integer NOT NULL DEFAULT 0 CHECK (budget_used >= 0),
 created_by_admin_id uuid,
 closed_by_admin_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (ends_at IS NULL OR ends_at > starts_at),
 CHECK (budget_total IS NULL OR budget_used <= budget_total)
);
--> statement-breakpoint
INSERT INTO credit_events(id,key,labels,trigger_event_type,trigger_schema_version,condition,audience,dedup_scope,amount,status) VALUES
 ('82900000-0000-4000-8000-000000000001','submission_approved','{"vi":"Đề xuất địa điểm","en":"Place submission"}','place.submission_decided',2,'{"all":[{"fact":"decision","op":"eq","value":"approved"}]}','individual','per_venue',50,'active'),
 ('82900000-0000-4000-8000-000000000002','submission_evidence','{"vi":"Bằng chứng địa điểm","en":"Submission evidence"}','place.submission_evidence_approved',2,'{"all":[]}','individual','per_source',10,'active'),
 ('82900000-0000-4000-8000-000000000003','review_published','{"vi":"Đánh giá địa điểm","en":"Place review"}','review.published',2,'{"all":[{"fact":"target","op":"eq","value":"place"},{"fact":"firstPublication","op":"eq","value":true}]}','individual','per_place_subject',5,'active')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE assistant_credit_ledger
 ADD COLUMN credit_event_id uuid,
 ADD COLUMN entitlement_key text,
 ADD COLUMN group_grant_id uuid,
 ADD COLUMN group_source_key text;
ALTER TABLE assistant_credit_ledger ADD CONSTRAINT assistant_credit_event_reason_fk
 FOREIGN KEY (credit_event_id,reason) REFERENCES credit_events(id,key) NOT VALID;
ALTER TABLE assistant_credit_ledger DROP CONSTRAINT assistant_credit_ledger_reason_check;
ALTER TABLE assistant_credit_ledger DROP CONSTRAINT assistant_credit_ledger_check;
-- NOT VALID skips the historical scan, but enforces every new/updated row.
ALTER TABLE assistant_credit_ledger ADD CONSTRAINT assistant_credit_ledger_check CHECK (
 (reason='submission_approved' AND delta IN (20,50,70) AND submission_id IS NOT NULL
  AND venue_identity IS NOT NULL AND usage_ledger_id IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL
  AND ((credit_event_id IS NULL AND entitlement_key IS NULL)
    OR (credit_event_id='82900000-0000-4000-8000-000000000001' AND entitlement_key IS NOT NULL)))
 OR (reason='message_spent' AND delta=-1 AND usage_ledger_id IS NOT NULL
  AND submission_id IS NULL AND venue_identity IS NULL AND credit_event_id IS NULL
  AND entitlement_key IS NULL AND group_grant_id IS NULL AND group_source_key IS NULL)
 OR (reason <> 'message_spent' AND credit_event_id IS NOT NULL AND entitlement_key IS NOT NULL
  AND delta>0 AND usage_ledger_id IS NULL)
) NOT VALID;
--> statement-breakpoint
CREATE TABLE credit_entitlements (
 event_id uuid NOT NULL REFERENCES credit_events(id),
 key text NOT NULL,
 ledger_id uuid NOT NULL REFERENCES assistant_credit_ledger(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_evaluations (
 event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
 status text NOT NULL CHECK (status IN ('evaluated','quarantined')),
 reason text,
 grants integer NOT NULL DEFAULT 0 CHECK (grants >= 0),
 evaluated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Retention must never discard unpaid or quarantined work while the evaluator is paused.
CREATE FUNCTION retain_pending_credit_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.event_type IN ('place.submission_decided','place.submission_evidence_approved','review.published','room.completed')
   AND NOT EXISTS (SELECT 1 FROM credit_evaluations WHERE event_id=OLD.id AND status='evaluated') THEN
   RETURN NULL;
 END IF;
 RETURN OLD;
END;
$$;
CREATE TRIGGER credit_outbox_retention BEFORE DELETE ON outbox_events
 FOR EACH ROW EXECUTE FUNCTION retain_pending_credit_outbox();
SET LOCAL lock_timeout TO DEFAULT;
