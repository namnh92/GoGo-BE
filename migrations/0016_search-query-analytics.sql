-- SE-006 (#36) — query analytics without a per-request log.
--
-- Zero-result was already measurable (`search.zero_result` outbox events), but
-- nothing recorded what searching normally looks like, so there was no
-- denominator: "40 zero-results today" means nothing without "out of how many".
--
-- Aggregated per day per normalized query rather than one row per request.
-- That is the cheaper shape *and* the more private one: a daily counter has no
-- actor on it at all, so there is nothing to join a query back to a person
-- with. Raw per-request search logs are deliberately not kept.
create table if not exists search_query_daily (
  day date not null,
  -- The normalized query, which is user-entered free text and can therefore
  -- contain anything. It is stored truncated, never with an actor, and the
  -- read endpoint hides terms below a k-anonymity floor so a term only one
  -- person searched is not readable as an individual's search.
  query_normalized text not null,
  has_query boolean not null,
  searches integer not null default 0,
  zero_results integer not null default 0,
  results_sum bigint not null default 0,
  latency_ms_sum bigint not null default 0,
  primary key (day, query_normalized)
);

-- The dashboard reads "worst queries today", so day-first with the zero-result
-- count as the second key.
create index if not exists search_query_daily_day_idx
  on search_query_daily (day desc, zero_results desc);

-- Rollback: drop table if exists search_query_daily;
