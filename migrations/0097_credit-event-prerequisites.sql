-- S1 only: compatible sync writers, no catalogue/ledger change or bulk scan.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE credit_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'sync' CHECK (mode IN ('sync', 'evaluator')),
  epoch integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  first_activated_at timestamptz,
  CONSTRAINT credit_cutover_activation CHECK (
    (epoch = 0 AND first_activated_at IS NULL AND mode = 'sync') OR
    (epoch > 0 AND first_activated_at IS NOT NULL)
  )
);
INSERT INTO credit_cutover(singleton) VALUES (true);
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN credit_epoch integer,
  ADD COLUMN first_published_at timestamptz;
ALTER TABLE reviews ADD CONSTRAINT reviews_credit_epoch_positive
  CHECK (credit_epoch IS NULL OR credit_epoch > 0) NOT VALID;
--> statement-breakpoint
-- Review creation eligibility is immutable; a backfill must never reopen history.
CREATE FUNCTION preserve_review_credit_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credit_epoch IS DISTINCT FROM OLD.credit_epoch THEN
    RAISE EXCEPTION 'review credit_epoch is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reviews_credit_epoch_immutable BEFORE UPDATE OF credit_epoch ON reviews
  FOR EACH ROW EXECUTE FUNCTION preserve_review_credit_epoch();
SET LOCAL lock_timeout TO DEFAULT;
