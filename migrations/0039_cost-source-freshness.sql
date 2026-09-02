-- COST-BE-017 (#369) — source freshness for the Cost Center (epic §23) and the
-- collector scheduler's bookkeeping (epic §19, §22).
--
-- One row per (environment, collector). It answers "when did this source last
-- give us a number, and can we still trust it" — which is a different question
-- from "what was the number". The numbers live in the usage and cost tables;
-- this row is what turns their absence into a status.
--
--   FRESH        succeeded within `stale_after_s`
--   STALE        has succeeded, but not recently enough
--   UNAVAILABLE  the last attempt failed and nothing usable is on record
--   UNKNOWN      never attempted (the collector is registered, that is all)
--
-- `consecutive_failures` drives bounded backoff between ticks: a source that
-- is down is asked again later, not in a loop (epic §22). `calls_day` /
-- `calls_count` enforce a collector's `maxCallsPerDay` across restarts — a
-- counter in memory would reset with the process and a paid collector could
-- exceed its declared budget after a redeploy (epic §20).
--
-- MEASURED ZERO != NOT MEASURED (epic §23): nothing here ever rewrites a
-- persisted usage row. A source going STALE changes how its numbers are
-- labelled, never the numbers.
--
-- Additive. Down: DROP TABLE cost_source_freshness;

CREATE TABLE IF NOT EXISTS cost_source_freshness (
  environment          text        NOT NULL,
  -- The collector's registered id — a literal in source, never user input.
  source_id            text        NOT NULL,
  provider_id          text        NOT NULL,
  service_id           text,
  last_successful_at   timestamptz,
  last_attempt_at      timestamptz,
  -- The provider's own "as of" for the last successful figure, if it has one.
  source_as_of         timestamptz,
  stale_after_s        integer     NOT NULL,
  status               text        NOT NULL CHECK (status IN ('FRESH', 'STALE', 'UNAVAILABLE', 'UNKNOWN')),
  -- A status code, never a message or payload.
  last_error_code      text,
  consecutive_failures integer     NOT NULL DEFAULT 0,
  calls_day            date,
  calls_count          integer     NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, source_id)
);
