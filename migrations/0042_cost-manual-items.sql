-- COST-BE-023 (#382) — epic §27, manual / fixed costs.
--
-- The record an operator edits: a named fee under a registry provider and
-- service (one that declares MANUAL_COST), an amount per period, an
-- effective range. Nothing reads this table to report spend. The worker and
-- the CMS write path materialise every item into `provider_cost_daily` as
-- basis = MANUAL, confidence = HIGH, source = 'manual_cost_items:<id>' — one
-- row per covered day up to today — and rebuild those rows on every change,
-- so the Cost Center, budgets and `spend()` see a subscription the way they
-- see an invoice, and per-test deltas (usage-based) never see it at all.
--
-- `environment` mirrors `cost_budgets`: an item belongs to the deployment
-- whose CMS entered it. `currency` is the item's own; rows keep it.
--
-- Additive. Down:
--   DELETE FROM provider_cost_daily WHERE source LIKE 'manual_cost_items:%';
--   DROP TABLE manual_cost_items;

CREATE TABLE IF NOT EXISTS manual_cost_items (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    text        NOT NULL,
  provider_id    text        NOT NULL,
  service_id     text        NOT NULL,
  name           text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  amount_micros  bigint      NOT NULL CHECK (amount_micros >= 0),
  currency       char(3)     NOT NULL DEFAULT 'USD',
  period         text        NOT NULL CHECK (period IN ('ONE_TIME', 'MONTHLY', 'YEARLY')),
  effective_from date        NOT NULL,
  effective_to   date,
  note           text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manual_cost_items_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS manual_cost_items_env_service_idx
  ON manual_cost_items (environment, provider_id, service_id);
