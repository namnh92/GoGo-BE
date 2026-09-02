-- COST-BE-016 (#368) — the canonical, provider-agnostic usage and cost tables
-- from the Cost Observability epic (§9 usage, §11 cost).
--
-- `provider_usage_daily` (#335) stays exactly as it is: it is Google-shaped —
-- one row per operation with three fixed quantities — and the ledger, the ops
-- API and the budget guard all read it. What it cannot hold is a meter that
-- is not "a call": Upstash commands, R2 class-A operations, Neon compute
-- hours, Actions minutes. Nor can it say *which* meter a number is, which is
-- how "12 requests" and "50 matrix elements" ended up looking like the same
-- kind of thing (#332).
--
-- `provider_usage_meter_daily` is one row per (day, environment, provider,
-- service, operation, meter, SKU, source). The ledger dual-writes into it from
-- this migration on (source = 'ledger'); other collectors write their own
-- source. Several meters for one runtime operation is the point, not an
-- accident: Routes writes `calls` (request, not billed) and
-- `billable_elements` (matrix_element, billed) for the same call.
--
-- `provider_cost_daily` is money, kept apart from usage (epic §8): a row says
-- what an amount is *for*, on what *basis* (ACTUAL from an invoice, ESTIMATED
-- from usage × a pricing rule, FIXED, MANUAL), with what confidence, from which
-- source, priced under which pricing version. Unknown cost is the absence of a
-- row, never a zero row. Two sources for the same spend are two rows, and the
-- reader applies ACTUAL > ESTIMATED > UNKNOWN (epic §12) — nothing sums them.
--
-- `operation_id`, `billing_sku_id` and `usage_metric_id` are nullable as the
-- epic says (a service-level meter has no operation; an invoice line has no
-- meter), so uniqueness uses COALESCE expressions and the upserts name the
-- same expressions in ON CONFLICT.
--
-- Additive. Nothing reads these yet except the estimator job and tests.
-- Down:
--   DROP TABLE provider_cost_daily;
--   DROP TABLE provider_usage_meter_daily;

CREATE TABLE IF NOT EXISTS provider_usage_meter_daily (
  -- UTC day the usage happened (epic §16). A provider that bills on another
  -- day boundary records `billing_timezone` in metadata; nothing here mixes them.
  day               date        NOT NULL,
  environment       text        NOT NULL,
  -- Registry ids (libs/modules/cost/domain/registry.ts). Immutable strings.
  provider_id       text        NOT NULL,
  service_id        text        NOT NULL,
  operation_id      text,
  -- The meter's short metric: calls | requests | billable_elements | commands…
  usage_metric_id   text        NOT NULL,
  billing_sku_id    text,
  -- Integer. Extrapolated Prometheus values are not accounting (epic §10).
  quantity          bigint      NOT NULL DEFAULT 0,
  unit              text        NOT NULL,
  -- Which collector wrote it. `ledger` for the in-process metrics ledger.
  source            text        NOT NULL,
  confidence        text        NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  -- The provider's own "as of" for the figure, when it has one.
  source_as_of      timestamptz,
  collected_at      timestamptz NOT NULL DEFAULT now(),
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_usage_meter_daily_quantity_nonneg CHECK (quantity >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS provider_usage_meter_daily_key
  ON provider_usage_meter_daily (
    day, environment, provider_id, service_id,
    COALESCE(operation_id, ''), usage_metric_id, COALESCE(billing_sku_id, ''), source
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_usage_meter_daily_env_day_idx
  ON provider_usage_meter_daily (environment, day);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS provider_cost_daily (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  day               date        NOT NULL,
  environment       text        NOT NULL,
  provider_id       text        NOT NULL,
  service_id        text        NOT NULL,
  operation_id      text,
  usage_metric_id   text,
  billing_sku_id    text,
  billable_quantity bigint,
  billable_unit     text,
  -- Original billing currency micros. Never FX-converted in place (epic §17).
  amount_micros     bigint      NOT NULL,
  currency          char(3)     NOT NULL,
  basis             text        NOT NULL CHECK (basis IN ('ACTUAL', 'ESTIMATED', 'FIXED', 'MANUAL')),
  confidence        text        NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  source            text        NOT NULL,
  -- The pricing-rule version an ESTIMATED row was computed with; null otherwise.
  pricing_version   text,
  source_as_of      timestamptz,
  collected_at      timestamptz NOT NULL DEFAULT now(),
  -- Set when an ACTUAL row has been compared to its ESTIMATED twin (epic §26).
  reconciled_at     timestamptz,
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_cost_daily_amount_nonneg CHECK (amount_micros >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS provider_cost_daily_key
  ON provider_cost_daily (
    day, environment, provider_id, service_id,
    COALESCE(operation_id, ''), COALESCE(usage_metric_id, ''), COALESCE(billing_sku_id, ''),
    source, basis
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_cost_daily_env_day_idx
  ON provider_cost_daily (environment, day);
