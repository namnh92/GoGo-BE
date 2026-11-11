-- #853 / #832 D2. No policy switch, activation, bound certification or backfill.
SET LOCAL lock_timeout = '5s';
ALTER TABLE assistant_usage_calls ADD COLUMN correlation_id uuid;
-- Receipt history deduplicates authoritative versioned evidence.
-- No source FK: the accounting identity survives source retention and erasure.
CREATE TABLE assistant_usage_receipts (
 usage_ledger_id uuid NOT NULL,
 call_index integer NOT NULL CHECK(call_index>=0),
 receipt_revision bigint NOT NULL CHECK(receipt_revision>0),
 fingerprint text NOT NULL,
 direct_cost_usd numeric NOT NULL CHECK(direct_cost_usd>=0 AND direct_cost_usd<'Infinity'::numeric),
 upstream_cost_usd numeric NOT NULL CHECK(upstream_cost_usd>=0 AND upstream_cost_usd<'Infinity'::numeric),
 fee_cost_usd numeric NOT NULL CHECK(fee_cost_usd>=0 AND fee_cost_usd<'Infinity'::numeric),
 final boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(usage_ledger_id,call_index,fingerprint)
);
CREATE TABLE assistant_credit_billing_incidents (
 usage_ledger_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('invalid_cost','receipt_conflict','bound_or_finality','account_invariant')),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 PRIMARY KEY(usage_ledger_id,reason)
);
-- Incident identity is scrubbed accounting only. Erasure never clears a global
-- billing safety block; resolution requires an audited billing correction.
CREATE TABLE assistant_credit_bound_artifacts (
 version text PRIMARY KEY,
 environment text NOT NULL CHECK(environment IN ('dev','staging','production')),
 bound_usd numeric NOT NULL CHECK(bound_usd>0 AND bound_usd<'Infinity'::numeric),
 description jsonb NOT NULL,
 validated_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>validated_at),
 revoked_at timestamptz
);
-- Existing-outbox index is built CONCURRENTLY by the existing ops index phase,
-- outside this short migration transaction. Readiness checks its exact shape.
SET LOCAL lock_timeout TO DEFAULT;
