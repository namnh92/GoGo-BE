-- COST-BE-034 (#415) — billing semantics on every cost row (ADR-0015).
--
-- A forecast that takes the month's total so far, divides by the elapsed
-- days and multiplies by the days in the month treats every row as usage.
-- It is not: a Play Console registration is paid once, an Apple Developer
-- fee once a year, a VPS once a month. Those must never be extrapolated from
-- "how much of the month has passed", and an annual fee must never be
-- averaged into a month it is not invoiced in.
--
-- So every row now says what kind of charge it is:
--
--   cost_kind       USAGE      — usage × price; the only kind a forecast may
--                                extrapolate from elapsed-period consumption
--                   RECURRING  — a subscription; billing_cadence says how often
--                   ONE_TIME   — paid once, counted once, never a run-rate input
--   billing_cadence MONTHLY | ANNUAL, required exactly when RECURRING
--   period_amount_micros  the full charge of the period a RECURRING row
--                         belongs to (the monthly fee, the annual fee), so a
--                         reader can tell what is still to come this period
--                         without extrapolating
--
-- Backfill, in precedence order, from what the rows already say:
--   ESTIMATED / ACTUAL     → USAGE (no FIXED_* pricing rule exists in the seed;
--                            the estimator stamps those RECURRING from now on)
--   FIXED (monitoring)     → RECURRING MONTHLY, period = metadata.knownMonthlyMicros
--   MANUAL (manual items)  → from metadata.period written by the materialiser:
--                            ONE_TIME → ONE_TIME; MONTHLY → RECURRING MONTHLY;
--                            YEARLY → RECURRING ANNUAL; period = metadata.amountMicros
--   anything else          → ONE_TIME (counted once, extrapolated never — the
--                            conservative reading of a row nobody classified)
--
-- Manual rows were spread per day (a monthly fee ÷ days in month). The
-- materialiser now writes one row per charge day at the full amount; the
-- worker's first daily pass after this deploy (and any CMS write) rebuilds
-- every manual row. Until then the spread rows are classified from their
-- metadata and count only as money that landed: the forecast reads what is
-- still to come from the items' billing dates, never from these rows.
--
-- Additive. Down:
--   ALTER TABLE provider_cost_daily
--     DROP CONSTRAINT provider_cost_daily_recurring_declares_period_amount,
--     DROP CONSTRAINT provider_cost_daily_recurring_declares_cadence,
--     DROP CONSTRAINT provider_cost_daily_billing_cadence,
--     DROP CONSTRAINT provider_cost_daily_cost_kind,
--     DROP COLUMN period_amount_micros, DROP COLUMN billing_cadence, DROP COLUMN cost_kind;

ALTER TABLE provider_cost_daily
  ADD COLUMN IF NOT EXISTS cost_kind text,
  ADD COLUMN IF NOT EXISTS billing_cadence text,
  ADD COLUMN IF NOT EXISTS period_amount_micros bigint;
--> statement-breakpoint
UPDATE provider_cost_daily
SET cost_kind = 'USAGE'
WHERE cost_kind IS NULL AND basis IN ('ESTIMATED', 'ACTUAL');
--> statement-breakpoint
UPDATE provider_cost_daily
SET cost_kind = 'RECURRING',
    billing_cadence = 'MONTHLY',
    period_amount_micros = COALESCE(
      NULLIF(metadata->>'knownMonthlyMicros', '')::bigint,
      amount_micros
    )
WHERE cost_kind IS NULL AND basis = 'FIXED';
--> statement-breakpoint
UPDATE provider_cost_daily
SET cost_kind = CASE metadata->>'period'
                  WHEN 'ONE_TIME' THEN 'ONE_TIME'
                  WHEN 'MONTHLY'  THEN 'RECURRING'
                  WHEN 'YEARLY'   THEN 'RECURRING'
                END,
    billing_cadence = CASE metadata->>'period'
                        WHEN 'MONTHLY' THEN 'MONTHLY'
                        WHEN 'YEARLY'  THEN 'ANNUAL'
                      END,
    period_amount_micros = CASE
      WHEN metadata->>'period' IN ('MONTHLY', 'YEARLY')
        THEN COALESCE(NULLIF(metadata->>'amountMicros', '')::bigint, amount_micros)
    END
WHERE cost_kind IS NULL AND basis = 'MANUAL'
  AND metadata->>'period' IN ('ONE_TIME', 'MONTHLY', 'YEARLY');
--> statement-breakpoint
UPDATE provider_cost_daily
SET cost_kind = 'ONE_TIME', billing_cadence = NULL, period_amount_micros = NULL
WHERE cost_kind IS NULL;
--> statement-breakpoint
ALTER TABLE provider_cost_daily ALTER COLUMN cost_kind SET NOT NULL;
--> statement-breakpoint
ALTER TABLE provider_cost_daily
  ADD CONSTRAINT provider_cost_daily_cost_kind
    CHECK (cost_kind IN ('USAGE', 'RECURRING', 'ONE_TIME')),
  ADD CONSTRAINT provider_cost_daily_billing_cadence
    CHECK (billing_cadence IS NULL OR billing_cadence IN ('MONTHLY', 'ANNUAL')),
  ADD CONSTRAINT provider_cost_daily_recurring_declares_cadence
    CHECK ((cost_kind = 'RECURRING') = (billing_cadence IS NOT NULL)),
  ADD CONSTRAINT provider_cost_daily_recurring_declares_period_amount
    CHECK (cost_kind <> 'RECURRING' OR period_amount_micros IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_cost_daily_env_kind_day_idx
  ON provider_cost_daily (environment, cost_kind, day);
