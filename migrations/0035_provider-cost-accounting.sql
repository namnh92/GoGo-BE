-- PR2 (#335) — durable provider usage accounting and the hard budget.
--
-- Numbered 0035, not 0034: 0034 is claimed by the parallel R3a branch
-- (GoGo-BE#347, candidate coordinates), which is a separate PR by decision.
-- Whichever lands first keeps its number; nothing here depends on that one.
--
-- Until now every Google call was counted in an in-process registry
-- (`libs/observability/src/registry.ts`) that resets on deploy, and mirrored
-- into Grafana Cloud Free, which keeps 14 days. Neither can answer "what did
-- we spend this month" and neither can stop a runaway job: a counter is not an
-- interlock.
--
-- Two tables, never one. `provider_usage_daily` records what happened and is
-- written after the fact by a buffered ledger; `provider_budget_daily` records
-- what is allowed and is written before the call inside one atomic statement.
-- Merging them would make an accounting write a prerequisite of every provider
-- call — the coupling the plan's §2.3 exists to avoid — and would let a
-- best-effort write become the thing that authorises spend.
--
-- Both are additive. Nothing reads them yet except the CMS ops surface, and
-- rollback is dropping them.

create table if not exists provider_usage_daily (
  -- UTC. Attributed to the day the call happened, not the day it was flushed:
  -- a buffer that spans midnight must not move yesterday's calls into today.
  day               date        not null,
  -- One database and one Grafana stack serve several deployments. Without this
  -- a DEV console would quietly add production spend to its own numbers.
  environment       text        not null,
  -- The adapter's `method` label, not the billing SKU. Routes bills as
  -- `routes.computeRouteMatrix` while its requests arrive as
  -- `google.routeMatrix`; #332 folded those onto one operation and this column
  -- keeps that fold. One operation, one row.
  operation         text        not null,
  -- Attempted and succeeded are separate facts. Google bills a served
  -- response, so a 429 or a breaker trip is a call that happened and cost
  -- nothing; a table that stored only one of them could not tell the
  -- difference between an expensive day and a broken one.
  calls_attempted   integer     not null default 0,
  calls_succeeded   integer     not null default 0,
  -- A third, independent quantity: 1 per successful Places call, one per
  -- *matrix element* for Routes, 0 for Sheets. bigint because a route matrix
  -- is quadratic in stops.
  billable_units    bigint      not null default 0,
  updated_at        timestamptz not null default now(),
  constraint provider_usage_daily_pkey primary key (day, environment, operation),
  constraint provider_usage_daily_non_negative check (
    calls_attempted >= 0 and calls_succeeded >= 0 and billable_units >= 0
  ),
  -- Succeeded can never exceed attempted. If it does, the ledger is
  -- double-counting and the number it produces is worse than no number.
  constraint provider_usage_daily_succeeded_le_attempted check (calls_succeeded <= calls_attempted)
);

--> statement-breakpoint
-- The reporting reads are "this environment, this month" and "this
-- environment, today", both of which start from (environment, day).
create index if not exists provider_usage_daily_env_day_idx
  on provider_usage_daily (environment, day desc);

--> statement-breakpoint
create table if not exists provider_budget_daily (
  day                  date        not null,
  -- Who is spending: `google.places.refresh`, `google.places.import`, …
  -- Ceilings are per scope, so one runaway job cannot eat another's budget.
  scope                text        not null,
  operation            text        not null,
  reserved_calls       integer     not null default 0,
  reserved_units       bigint      not null default 0,
  -- List price x units, with NO free-tier and NO volume-discount deduction.
  -- Google aggregates free caps per billing account per SKU per month across
  -- every linked project and GoGo cannot see that; an over-generous estimate
  -- of "free tier remaining" would authorise a paid call, and whether the
  -- scheduler may spend money is a safety property, not an estimate.
  reserved_cost_micros bigint      not null default 0,
  updated_at           timestamptz not null default now(),
  constraint provider_budget_daily_pkey primary key (day, scope, operation),
  constraint provider_budget_daily_non_negative check (
    reserved_calls >= 0 and reserved_units >= 0 and reserved_cost_micros >= 0
  )
);

--> statement-breakpoint
-- Every reservation aggregates over one (day, scope) before it decides.
create index if not exists provider_budget_daily_day_scope_idx
  on provider_budget_daily (day, scope);
