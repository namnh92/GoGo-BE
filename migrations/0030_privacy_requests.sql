-- BE-CMS-G12 (#255) — the privacy-request compliance ledger.
--
-- The audit log answers "who did what". This table answers a different
-- question — "what requests did we receive, where are they, what is the
-- deadline, how did they end" — and neither can stand in for the other:
-- deriving requests from audit rows undercounts everything support recorded
-- but never executed, and it has no place for a deadline at all.

CREATE TYPE privacy_request_type AS ENUM ('export', 'delete', 'correction');--> statement-breakpoint

CREATE TYPE privacy_request_source AS ENUM ('self_service', 'support', 'cms');--> statement-breakpoint

-- Lifecycle and result are separate columns on purpose. A single enum mixing
-- "acknowledged" with "no_account_found" forces every query to know which
-- values mean "still moving" and which mean "ended, and how".
CREATE TYPE privacy_request_status AS ENUM ('open', 'acknowledged', 'in_progress', 'closed');--> statement-breakpoint

CREATE TYPE privacy_request_outcome AS ENUM (
  'completed',
  'no_account_found',
  'identity_not_verified',
  'rejected',
  'failed'
);--> statement-breakpoint

-- The subject is structured, not free text. A single free-text "subject"
-- field becomes a PII dumping ground the day support pastes a conversation
-- into it; three nullable columns with a discriminator cannot.
CREATE TYPE privacy_subject_type AS ENUM ('user', 'email', 'external');--> statement-breakpoint

CREATE TYPE privacy_identity_status AS ENUM ('matched', 'no_account_found', 'unverified');--> statement-breakpoint

CREATE TYPE privacy_delivery_method AS ENUM ('in_app', 'secure_download', 'other');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type privacy_request_type NOT NULL,
  source privacy_request_source NOT NULL,
  status privacy_request_status NOT NULL DEFAULT 'open',
  outcome privacy_request_outcome,

  subject_type privacy_subject_type NOT NULL,
  -- No FK cascade: after the account is erased this row may deliberately be
  -- the last record that the person existed (see ADR-0011). Plain reference,
  -- and the user row is soft-deleted anyway.
  user_id uuid REFERENCES users(id),
  contact_email text,
  external_reference text,
  identity_status privacy_identity_status NOT NULL,

  -- SLA. Due dates are computed once at write time from per-type
  -- configuration and stored, so "overdue" is a comparison, not a policy
  -- evaluation that has to be repeated identically in every query.
  received_at timestamptz NOT NULL DEFAULT now(),
  ack_due_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  fulfillment_due_at timestamptz NOT NULL,
  extended_due_at timestamptz,
  extension_reason text,
  executed_at timestamptz,
  executed_by_admin_id uuid REFERENCES admin_users(id),
  completed_at timestamptz,
  closed_at timestamptz,

  -- Delivery metadata only. Never the bytes, never a signed URL: the record
  -- outlives any artifact and must not be a way back to the data.
  delivery_method privacy_delivery_method,
  delivered_at timestamptz,

  -- Retention. Stamped at closure (closed_at + policy) rather than derived on
  -- read: the job's WHERE clause stays trivial, policy changes migrate by
  -- UPDATE, and a hold is visible next to the date it is holding.
  retention_at timestamptz,
  retention_hold_at timestamptz,
  retention_hold_by uuid REFERENCES admin_users(id),
  retention_hold_reason text,
  legal_basis text,
  review_at timestamptz,
  hold_until timestamptz,
  released_at timestamptz,
  released_by uuid REFERENCES admin_users(id),

  reason_code text,
  ticket_reference text,
  -- Deliberately short. Operator notes are how privacy systems grow their own
  -- PII; 256 characters holds a ticket id and a sentence, not a conversation.
  operator_note varchar(256),
  created_by_admin_id uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT privacy_requests_subject_shape CHECK (
    (subject_type = 'user' AND user_id IS NOT NULL)
    OR (subject_type = 'email' AND contact_email IS NOT NULL)
    OR (subject_type = 'external' AND external_reference IS NOT NULL)
  ),
  CONSTRAINT privacy_requests_closed_has_outcome CHECK (
    (status = 'closed') = (outcome IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS privacy_requests_status_idx
  ON privacy_requests (status, fulfillment_due_at);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS privacy_requests_user_idx
  ON privacy_requests (user_id) WHERE user_id IS NOT NULL;--> statement-breakpoint

-- The retention job's exact predicate.
CREATE INDEX IF NOT EXISTS privacy_requests_retention_idx
  ON privacy_requests (retention_at)
  WHERE retention_at IS NOT NULL AND retention_hold_at IS NULL;--> statement-breakpoint

-- Long-term reporting that survives the hard delete. One row per month,
-- integer counters only — nothing here can be joined back to a person, which
-- is the property that lets it live forever.
CREATE TABLE IF NOT EXISTS privacy_metrics_monthly (
  month text PRIMARY KEY,
  delete_received integer NOT NULL DEFAULT 0,
  delete_completed integer NOT NULL DEFAULT 0,
  delete_failed integer NOT NULL DEFAULT 0,
  export_received integer NOT NULL DEFAULT 0,
  export_completed integer NOT NULL DEFAULT 0,
  export_failed integer NOT NULL DEFAULT 0,
  correction_received integer NOT NULL DEFAULT 0,
  sla_breached integer NOT NULL DEFAULT 0,
  no_account_found integer NOT NULL DEFAULT 0
);
