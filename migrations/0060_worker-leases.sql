-- BE#539 — a job lease that survives PgBouncer.
--
-- `AdvisoryLock` used `pg_try_advisory_lock` / `pg_advisory_unlock`, which are
-- **session**-scoped. `DATABASE_URL` points at Neon's `-pooler` endpoint, i.e.
-- PgBouncer in transaction pooling, where consecutive statements on one client
-- can land on different server backends. So the lock was taken on one session
-- and the unlock ran on another: the unlock returned false, silently, and the
-- lock leaked onto a backend nobody would look at again.
--
-- Observed on DEV 2026-09-09: three leaked locks pinned to one idle backend
-- 44 minutes old, after which *every* periodic tick logged `lock_skipped`.
-- No outbox, no campaigns, no ingest, no heartbeat — with the container
-- healthy and not one error line. Restarting the worker could not fix it,
-- because the lock lived on a server backend PgBouncer owned.
--
-- A row does what a session cannot. Every operation below is a single
-- statement that carries its own predicate, so it is correct no matter which
-- backend executes it, and the lease expires on its own — a worker that dies
-- holding one blocks the job for at most `expires_at`, with nobody to page.
--
-- Down:
--   DROP TABLE IF EXISTS worker_leases;
CREATE TABLE IF NOT EXISTS "worker_leases" (
  -- The job name. One row per job, forever; contention is an UPDATE, not an
  -- INSERT race.
  "name" text PRIMARY KEY,
  -- Fresh per acquisition, not per process. Renewal and release both match on
  -- it, so a worker that lost its lease and is still running cannot renew or
  -- release the lease its successor now holds.
  "holder" uuid NOT NULL,
  -- Which process, for reading the table during an incident. Never used to
  -- decide ownership: two acquisitions by the same worker are still different
  -- holders.
  "worker_id" text,
  "acquired_at" timestamptz DEFAULT now() NOT NULL,
  "renewed_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
-- Reading the table during an incident is "which job is stuck and since when",
-- so the index is on the answer rather than on the key.
CREATE INDEX IF NOT EXISTS "worker_leases_expires_idx" ON "worker_leases" USING btree ("expires_at");
