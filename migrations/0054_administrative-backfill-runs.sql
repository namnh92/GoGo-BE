-- ADM-008 (#461) / ADR-0019 — the ledger of geometry-only enrichment runs.
--
-- A backfill over the whole catalogue is not one transaction and must not be:
-- it walks the places table in batches, each batch commits on its own, and a
-- failure halfway through has to leave the successful half committed. That
-- makes the run itself a durable object rather than a process — something a
-- second invocation can resume, something an operator can ask "what did that
-- do" of a week later, and something a per-place audit row can point back to.
--
-- Counters live in one jsonb column rather than a dozen integer columns. They
-- are read as a set, they will grow another bucket the first time the resolver
-- learns a new outcome, and a migration per counter is not a good trade.
--
-- `pinned_dataset_version` and `pinned_boundary_version` are the point of the
-- table. A run is bound to the exact versions it started against; if the active
-- version changes underneath it the run stops rather than writing half its rows
-- against one dataset and half against another. They are written once, at
-- start, and never updated: a run whose pin could be edited is a run whose
-- recorded scope means nothing.
--
-- Resuming continues against the versions recorded here **and only while they
-- are still the active ones**. A stopped run whose versions never come back is
-- closed as `abandoned`, so a run that will not finish is never left looking
-- like one that might.
--
-- ---------------------------------------------------------------------------
-- Down:
--   DROP TABLE administrative_backfill_runs;
--   DROP TYPE administrative_backfill_status;
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE administrative_backfill_status AS ENUM (
    'running', 'completed', 'failed', 'cancelled', 'stopped_version_changed', 'abandoned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS administrative_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status administrative_backfill_status NOT NULL DEFAULT 'running',
  -- The default everywhere: a run that writes must be asked to write.
  dry_run boolean NOT NULL DEFAULT true,
  dataset_version_id uuid NOT NULL
    REFERENCES administrative_dataset_versions(id) ON DELETE RESTRICT,
  pinned_dataset_version text NOT NULL,
  pinned_boundary_version text,
  -- What was asked for: place ids, batch size, row cap, rematch authorisation.
  scope jsonb NOT NULL,
  -- Last place id committed. Resume starts strictly after it, so a batch that
  -- committed is never re-processed and a batch that did not is.
  cursor text,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bounded: the ids a retry would target, capped so one bad release cannot
  -- turn a run row into a hundred-thousand-element array.
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS administrative_backfill_runs_started_idx
  ON administrative_backfill_runs (started_at DESC);

-- Finding the run to resume: the newest one that has not finished.
CREATE INDEX IF NOT EXISTS administrative_backfill_runs_open_idx
  ON administrative_backfill_runs (status, started_at DESC)
  WHERE status IN ('running', 'stopped_version_changed');
