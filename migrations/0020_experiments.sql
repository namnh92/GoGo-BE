-- SG-010 (#49) — A/B assignment with an audit trail and a kill switch.
--
-- The assignment itself is computed, not stored: a hash of
-- (experiment key, subject id) is stable, so the same room always lands in
-- the same variant without a lookup, and a lost row cannot silently reassign
-- someone mid-experiment. What is stored is the *definition* — which lets an
-- experiment be turned off — and the variant each run actually used, which is
-- what makes the result auditable afterwards.
create table if not exists experiments (
  key text primary key,
  description text,
  -- The kill switch. Disabling sends every subject to the control variant on
  -- the next request; it does not delete the assignment history.
  enabled boolean not null default false,
  -- Variant name -> weight. Control is whatever the engine does today, so an
  -- experiment that is off and an experiment whose control won look the same
  -- to the pipeline, which is the point.
  variants jsonb not null,
  created_by_admin_id uuid references admin_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table suggestion_runs
  -- Which experiment variant produced this run. Null means no experiment was
  -- active, which is different from "control" and worth telling apart.
  add column if not exists experiment_key text,
  add column if not exists experiment_variant text,
  -- Cost/latency budget (#49): what the run actually spent.
  add column if not exists latency_ms integer;

create index if not exists suggestion_runs_experiment_idx
  on suggestion_runs (experiment_key, experiment_variant, created_at desc)
  where experiment_key is not null;

-- Rollback:
--   drop table if exists experiments;
--   alter table suggestion_runs
--     drop column if exists experiment_key,
--     drop column if exists experiment_variant,
--     drop column if exists latency_ms;
