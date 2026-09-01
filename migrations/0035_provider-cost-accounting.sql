-- COST-BE-002 (#335) — measure Google spend, and cap it.
--
-- Until now the only record of what GoGo spends at Google was an in-memory
-- counter that resets on every deploy (`libs/observability/src/registry.ts`),
-- shipped to a Grafana Cloud free tier that keeps 14 days. That is enough to
-- watch a graph and not enough to answer "what did last month cost" or to stop
-- a runaway job. Both tables here are additive; nothing reads differently
-- until the ledger flag is on.
--
-- Two tables rather than one, because they have different truth conditions.
-- `provider_usage_daily` records what happened and may lag by a flush window.
-- `provider_budget_daily` records what has been authorised, is written before
-- the call, and must never be optimistic — an over-generous budget row is an
-- invoice, an over-generous usage row is only a wrong graph.
--
-- Down:
--   DROP TABLE IF EXISTS provider_budget_daily;
--   DROP TABLE IF EXISTS provider_usage_daily;

CREATE TABLE IF NOT EXISTS provider_usage_daily (
  day              date        NOT NULL,
  -- GoGo's own split. Google aggregates per billing account, not per
  -- environment, so anything derived from this is labelled as an estimate.
  environment      text        NOT NULL,
  -- The billing label (`places_provider_cost_units{sku}`), not the request
  -- label: Routes bills as `routes.computeRouteMatrix` and requests as
  -- `google.routeMatrix`, and keying on the latter would split one operation's
  -- calls from its money.
  operation        text        NOT NULL,
  calls_attempted  integer     NOT NULL DEFAULT 0,
  calls_succeeded  integer     NOT NULL DEFAULT 0,
  -- One per successful Places call; one per matrix *element* for Routes, which
  -- is why this is a bigint and not an integer.
  billable_units   bigint      NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, environment, operation)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS provider_usage_daily_day_idx ON provider_usage_daily (day);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS provider_budget_daily (
  day                  date        NOT NULL,
  -- Which spender is being capped: 'google.places.refresh', '…import', …
  scope                text        NOT NULL,
  operation            text        NOT NULL,
  reserved_calls       integer     NOT NULL DEFAULT 0,
  reserved_units       bigint      NOT NULL DEFAULT 0,
  -- List price × units, in USD micros, with NO free-tier or volume-discount
  -- deduction. Google pools free caps per billing account per SKU per month
  -- across every linked project and GoGo cannot see that pool, so a wrong
  -- "still free" estimate must never be able to authorise a paid call.
  reserved_cost_micros bigint      NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, scope, operation)
);
