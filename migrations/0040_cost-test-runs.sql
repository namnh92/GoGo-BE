-- COST-BE-019 (#378) — epic §28–§30: a test run's cost as a record, not a file.
--
-- `docs/cost-baselines/*.json` (PR3, #336) froze what the pinned scenarios
-- cost and stays frozen: those files are historical evidence and nothing here
-- rewrites them. What they cannot do is be queried, compared across many runs,
-- or hold a provider the scenario author did not name. These two tables are
-- the epic's shape for the same measurement:
--
--   cost_test_runs         one row per run — when it started and ended, the
--                          two snapshots it took, the git sha, a status and
--                          the scope of services it declared relevant (§30).
--   cost_test_run_deltas   one row per (run, provider, service, operation?,
--                          meter, SKU?): usage before, after, delta, and the
--                          estimated cost of the delta priced at list on the
--                          day the run finished. `estimated_cost_delta` is
--                          NULL when the SKU has no verified price (unknown is
--                          not zero); `actual_cost_delta` stays NULL until an
--                          ACTUAL collector exists to fill it.
--
-- Snapshots are sums over `provider_usage_meter_daily` for the environment,
-- keyed by registry ids, so a provider registered tomorrow appears in
-- tomorrow's deltas with no change here (§44.17). Neither run id nor git sha
-- is ever a Prometheus label (§28) — they live in these rows and nowhere else.
--
-- Additive. Down: DROP TABLE cost_test_run_deltas; DROP TABLE cost_test_runs;

CREATE TABLE IF NOT EXISTS cost_test_runs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text        NOT NULL,
  environment          text        NOT NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  baseline_snapshot_at timestamptz NOT NULL DEFAULT now(),
  final_snapshot_at    timestamptz,
  git_sha              text,
  -- running | ok | over_budget | failed
  status               text        NOT NULL CHECK (status IN ('running', 'ok', 'over_budget', 'failed')),
  -- §30: registry service ids the run declares relevant; NULL = all.
  services             jsonb,
  -- §29: the optional budget the run was checked against, as declared.
  budget               jsonb,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_test_runs_env_started_idx
  ON cost_test_runs (environment, started_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cost_test_run_deltas (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id          uuid        NOT NULL REFERENCES cost_test_runs (id) ON DELETE CASCADE,
  provider_id          text        NOT NULL,
  service_id           text        NOT NULL,
  operation_id         text,
  usage_metric_id      text        NOT NULL,
  billing_sku_id       text,
  unit                 text        NOT NULL,
  usage_before         bigint      NOT NULL,
  usage_after          bigint      NOT NULL,
  usage_delta          bigint      NOT NULL,
  -- List-price micros of `usage_delta` under the rule in force at finish;
  -- NULL = price unknown or meter not billed.
  estimated_cost_delta bigint,
  actual_cost_delta    bigint,
  currency             char(3)     NOT NULL,
  basis                text        NOT NULL CHECK (basis IN ('ESTIMATED', 'ACTUAL', 'UNKNOWN')),
  confidence           text        NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW'))
);
--> statement-breakpoint
-- The meter short name repeats across operations (`calls` under every
-- operation), so the key must carry the operation and SKU — nullable, hence
-- COALESCE, as in the usage and cost tables (0038).
CREATE UNIQUE INDEX IF NOT EXISTS cost_test_run_deltas_key
  ON cost_test_run_deltas (
    test_run_id, provider_id, service_id, COALESCE(operation_id, ''), usage_metric_id,
    COALESCE(billing_sku_id, '')
  );
