-- BE-CMS-G4d (#225) — Trust & Safety rule definitions.
--
-- Deliberately not a rule builder. `conditions` is jsonb, but the shape it may
-- hold is closed and enumerated per rule type in
-- `libs/modules/cms/domain/safety-rule-conditions.ts`, validated on every
-- write. There is no expression language here, nothing is evaluated as code,
-- and no operator exists that the server did not ship — a free-form condition
-- DSL is how this screen becomes ungovernable, and how a console write becomes
-- remote code execution.
--
-- These are definitions. Nothing evaluates them yet; the enforcement path is
-- separate work, and every automated decision it makes must carry the rule's
-- `reason_code` so a human reviewer can trace why.
CREATE TYPE safety_rule_type AS ENUM (
  'spam',
  'abusive_content',
  'blocked_words',
  'review_abuse',
  'user_abuse',
  'repeated_reports',
  'rate_limit'
);--> statement-breakpoint

CREATE TYPE safety_rule_trigger AS ENUM (
  'review_created',
  'review_updated',
  'report_created',
  'checkin_created',
  'place_submitted',
  'user_registered'
);--> statement-breakpoint

CREATE TYPE safety_rule_action AS ENUM (
  'flag_for_review',
  'auto_hide',
  'require_moderation',
  'suspend_user',
  'block_action'
);--> statement-breakpoint

CREATE TYPE safety_rule_severity AS ENUM ('low', 'medium', 'high', 'critical');--> statement-breakpoint

CREATE TYPE safety_rule_status AS ENUM ('draft', 'active', 'disabled');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS safety_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  rule_type safety_rule_type NOT NULL,
  trigger safety_rule_trigger NOT NULL,
  -- Closed, typed per rule_type at the application boundary. Never an
  -- expression, never evaluated.
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  action safety_rule_action NOT NULL,
  severity safety_rule_severity NOT NULL DEFAULT 'medium',
  status safety_rule_status NOT NULL DEFAULT 'draft',
  -- Lower runs first, so two rules matching one event resolve the same way
  -- every time rather than by insertion order.
  priority integer NOT NULL DEFAULT 100,
  -- Machine-readable "why", stamped on every decision the rule causes, so an
  -- automated action can be traced back by a person reviewing it.
  reason_code text NOT NULL,
  created_by_admin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT safety_rules_name_unique UNIQUE (name),
  CONSTRAINT safety_rules_reason_code_format CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT safety_rules_priority_range CHECK (priority BETWEEN 0 AND 1000)
);--> statement-breakpoint

-- The evaluator's lookup when it lands: active rules for one trigger, in the
-- order they must run.
CREATE INDEX IF NOT EXISTS safety_rules_active_idx
  ON safety_rules (trigger, priority, id)
  WHERE status = 'active';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS safety_rules_list_idx
  ON safety_rules (created_at DESC, id DESC);

-- Rollback:
--   DROP TABLE IF EXISTS safety_rules;
--   DROP TYPE safety_rule_status;
--   DROP TYPE safety_rule_severity;
--   DROP TYPE safety_rule_action;
--   DROP TYPE safety_rule_trigger;
--   DROP TYPE safety_rule_type;
