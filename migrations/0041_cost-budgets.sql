-- COST-BE-020 (#379) — epic §32, the monthly budget engine's one table.
--
-- Not to be confused with `provider_budget_daily` (0035): that is the hard
-- reservation guard a job consults *before* spending, per scope, per day, and
-- it stays exactly as it is. This is the number an operator sets for a month
-- — "total $50", "google $30", "google.places $20" — that the Cost Center
-- reports against: used, remaining, projected. It stops nothing by itself.
--
-- Scope is generic (epic §32 "budget logic must not know provider
-- internals"): TOTAL has no scope id; PROVIDER and SERVICE carry a registry
-- id. One row per (environment, scope) — COALESCE in the key because TOTAL's
-- scope id is NULL.
--
-- Additive. Down: DROP TABLE cost_budgets;

CREATE TABLE IF NOT EXISTS cost_budgets (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   text        NOT NULL,
  scope_kind    text        NOT NULL CHECK (scope_kind IN ('TOTAL', 'PROVIDER', 'SERVICE')),
  scope_id      text,
  month_micros  bigint      NOT NULL CHECK (month_micros >= 0),
  currency      char(3)     NOT NULL DEFAULT 'USD',
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_budgets_scope_id_matches_kind CHECK (
    (scope_kind = 'TOTAL' AND scope_id IS NULL) OR (scope_kind <> 'TOTAL' AND scope_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cost_budgets_key
  ON cost_budgets (environment, scope_kind, COALESCE(scope_id, ''));
