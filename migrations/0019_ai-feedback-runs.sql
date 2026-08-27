-- SG-009 (#48) — every AI feedback parse is auditable.
--
-- The guardrail rule requires each result to store the model version, the
-- input snapshot, and the reason codes, so an A/B comparison or an incident
-- review can say what the model was asked and what was thrown away.
--
-- Free text is *not* stored. The member's words are the input, and keeping
-- them would put arbitrary user text in a table nothing needs it in; the
-- length and the outcome are enough to answer "was it understood".
create table if not exists ai_feedback_runs (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  room_id uuid not null references rooms(id) on delete cascade,
  -- Room-scoped member id, not a user id.
  member_id uuid,
  model_version text not null,
  -- accepted | rejected | fallback | disabled | timeout | quota | provider_error
  outcome text not null,
  reason_codes text[] not null default '{}',
  input_length integer not null,
  candidate_count integer not null,
  applied jsonb,
  latency_ms integer not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_feedback_runs_plan_idx on ai_feedback_runs (plan_id, created_at desc);
create index if not exists ai_feedback_runs_outcome_idx on ai_feedback_runs (outcome, created_at desc);

-- Rollback: drop table if exists ai_feedback_runs;
