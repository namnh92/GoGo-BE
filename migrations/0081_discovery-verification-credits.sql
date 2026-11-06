ALTER TABLE place_submissions ADD COLUMN submission_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE FUNCTION increment_submission_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.submission_revision := OLD.submission_revision + 1; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER submission_revision_before_update BEFORE UPDATE ON place_submissions FOR EACH ROW EXECUTE FUNCTION increment_submission_revision();
--> statement-breakpoint
ALTER TABLE places ADD COLUMN identity_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE place_verifications (
 place_id uuid PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('verified','unverified')),
 identity_revision integer NOT NULL,
 evidence_type text,
 evidence_reference text,
 verified_at timestamptz,
 decided_by_admin_id uuid,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (status <> 'verified' OR (evidence_type IS NOT NULL AND evidence_reference IS NOT NULL AND evidence_type IN ('site_visit','official_registry','venue_document') AND length(trim(evidence_reference)) > 0 AND verified_at IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION invalidate_venue_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.name IS DISTINCT FROM OLD.name OR NEW.address_text IS DISTINCT FROM OLD.address_text
    OR NOT ST_Equals(NEW.geom, OLD.geom) THEN
   NEW.identity_revision := OLD.identity_revision + 1;
   INSERT INTO audit_logs(actor_type,action,resource_type,resource_id,diff)
     SELECT 'system','place.verification_invalidated','place',OLD.id::text,jsonb_build_object('identityRevision',NEW.identity_revision,'previousVersion',version)
     FROM place_verifications WHERE place_id=OLD.id AND status='verified';
   UPDATE place_verifications SET status='unverified', verified_at=NULL,
     evidence_type=NULL, evidence_reference=NULL, decided_by_admin_id=NULL,
     version=version+1, updated_at=clock_timestamp() WHERE place_id=OLD.id;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER places_invalidate_verification BEFORE UPDATE ON places FOR EACH ROW EXECUTE FUNCTION invalidate_venue_verification();
--> statement-breakpoint
ALTER TABLE assistant_usage_ledger ADD COLUMN allowance_source text NOT NULL DEFAULT 'daily' CHECK (allowance_source IN ('daily','credit'));
--> statement-breakpoint
CREATE TABLE assistant_credit_accounts (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 balance integer NOT NULL DEFAULT 0 CHECK(balance >= 0)
);
--> statement-breakpoint
-- Source identifiers intentionally have no FK: deduplication survives source erasure/purge.
CREATE TABLE assistant_credit_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 delta integer NOT NULL,
 reason text NOT NULL CHECK(reason IN ('submission_approved','message_spent')),
 submission_id uuid,
 venue_identity text,
 usage_ledger_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((reason='submission_approved' AND delta=50 AND submission_id IS NOT NULL AND venue_identity IS NOT NULL AND usage_ledger_id IS NULL)
 OR (reason='message_spent' AND delta=-1 AND usage_ledger_id IS NOT NULL AND submission_id IS NULL AND venue_identity IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_credit_submission_unique ON assistant_credit_ledger(submission_id) WHERE reason='submission_approved';
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_credit_venue_unique ON assistant_credit_ledger(venue_identity) WHERE reason='submission_approved';
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_credit_spend_unique ON assistant_credit_ledger(usage_ledger_id) WHERE reason='message_spent';
--> statement-breakpoint
CREATE INDEX assistant_credit_user_history ON assistant_credit_ledger(user_id,created_at,id);
