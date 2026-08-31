/**
 * The queues `apps/worker` consumes.
 *
 * Duplicated deliberately rather than imported: the API must not depend on the
 * worker package, and `check:boundaries` enforces that. The cost of the
 * duplication is a name drifting, and the symptom is visible — a queue that
 * silently stops appearing on the ops screen — which is why the names live in
 * one named constant here rather than inline at the call site.
 */
export const WORKER_QUEUES = ['gogo-outbox', 'gogo-privacy', 'gogo-ingest'] as const;
