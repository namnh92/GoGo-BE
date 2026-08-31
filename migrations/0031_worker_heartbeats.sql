-- Worker liveness, written by the worker itself.
--
-- The console used to infer "worker alive" from BullMQ: a queue with work and
-- no connected consumer was the shape of a dead worker. The worker no longer
-- uses BullMQ (#262), so that inference had nothing left to read and reported
-- healthy unconditionally. A heartbeat the worker writes stops being written
-- exactly when the worker stops — which is the evidence a dead-man switch is
-- built on, not a weakness of it.
--
-- One row per worker process, keyed by hostname (the container id under
-- compose). Rows are tiny and are overwritten in place; nothing accumulates.
--
-- Down: DROP TABLE worker_heartbeats;
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
