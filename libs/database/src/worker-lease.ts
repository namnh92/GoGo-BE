/**
 * BE#539 — a job lease that is correct under PgBouncer transaction pooling.
 *
 * What it replaces: `pg_try_advisory_lock(hashtext($1))` held on a pooled
 * client and released on the same client. Advisory locks belong to the
 * *session*, and `DATABASE_URL` points at Neon's `-pooler` endpoint, so two
 * statements from one client can execute on two different server backends. The
 * unlock then ran against a session that never held the lock, returned false,
 * and said nothing. Observed on DEV: three leaked locks pinned to one idle
 * backend, after which every periodic tick reported `lock_skipped` — no
 * outbox, no campaigns, no heartbeat, container healthy, no error logged, and
 * no way to recover short of terminating the backend by hand.
 *
 * Three properties make a row succeed where a session could not:
 *
 *  - **Single-statement.** Every operation carries its own predicate and holds
 *    no session state, so it is correct on whichever backend runs it.
 *  - **Expiring.** A worker that dies holding a lease blocks its job until
 *    `expires_at`, not forever. There is nothing to clean up by hand.
 *  - **Owner-matched.** Renewal and release both require the holder token, so
 *    a worker that has already lost its lease cannot renew it back, and cannot
 *    release the lease its successor is holding.
 *
 * The holder token is minted per *acquisition*, not per process: the same
 * worker re-acquiring after an expiry is a different holder, which is what
 * stops a stale in-flight renewal from resurrecting a lease someone else took.
 */
import { randomUUID } from 'node:crypto';

/** The one query shape this needs — structural, so tests need no pg. */
export interface LeaseQuery {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface WorkerLeaseOptions {
  /**
   * How long a lease survives without renewal. This is the blast radius of a
   * worker dying mid-job: another replica waits at most this long.
   */
  ttlMs: number;
  /**
   * How often to renew while the job runs. Must be comfortably under `ttlMs`
   * so a single slow renewal does not lose a lease that is still healthy.
   */
  renewEveryMs: number;
  /** Which process holds it — for humans reading the table, never for ownership. */
  workerId?: string;
  /** Injected by tests. */
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Reason codes only; never a query, never a token. */
  report?: (event: string, detail: Record<string, unknown>) => void;
}

export interface HeldLease {
  /**
   * Aborts when the lease is lost — a renewal that found the row taken, gone,
   * or already expired. Work that checks it stops before doing anything a
   * second holder is now also doing.
   */
  readonly signal: AbortSignal;
  /** True until the lease is lost or released. */
  isHeld(): boolean;
  /** Owner-matched, so releasing after loss cannot free someone else's lease. */
  release(): Promise<void>;
}

/**
 * `on conflict ... do update ... where expires_at <= now()` is the whole
 * concurrency control: the row is inserted if absent, taken over only if the
 * previous lease has expired, and otherwise the update matches nothing and
 * `returning` yields no row. One statement, one round trip, no session state.
 */
const ACQUIRE = `
  insert into worker_leases (name, holder, worker_id, expires_at)
  values ($1, $2, $3, now() + make_interval(secs => $4::double precision))
  on conflict (name) do update
    set holder = excluded.holder,
        worker_id = excluded.worker_id,
        acquired_at = now(),
        renewed_at = now(),
        expires_at = excluded.expires_at
    where worker_leases.expires_at <= now()
  returning holder`;

/** Owner-matched and liveness-matched: an expired lease is not renewable. */
const RENEW = `
  update worker_leases
  set expires_at = now() + make_interval(secs => $3::double precision),
      renewed_at = now()
  where name = $1 and holder = $2 and expires_at > now()
  returning holder`;

/**
 * Expire rather than delete: the row stays as the record of who held it last,
 * and the next acquisition is an ordinary takeover of an expired lease.
 */
const RELEASE = `
  update worker_leases
  set expires_at = now()
  where name = $1 and holder = $2 and expires_at > now()
  returning holder`;

export class WorkerLease {
  private readonly ttlSeconds: number;

  constructor(
    private readonly db: LeaseQuery,
    private readonly options: WorkerLeaseOptions,
  ) {
    this.ttlSeconds = options.ttlMs / 1000;
  }

  /** Null when someone else holds an unexpired lease for this job. */
  async tryAcquire(name: string): Promise<HeldLease | null> {
    const holder = randomUUID();
    const { rows } = await this.db.query<{ holder: string }>(ACQUIRE, [
      name,
      holder,
      this.options.workerId ?? null,
      this.ttlSeconds,
    ]);
    if (rows.length === 0) return null;

    const controller = new AbortController();
    const setIntervalFn = this.options.setInterval ?? setInterval;
    const clearIntervalFn = this.options.clearInterval ?? clearInterval;
    let held = true;

    const lose = (reason: string) => {
      if (!held) return;
      held = false;
      clearIntervalFn(timer);
      this.options.report?.('worker_lease_lost', { job: name, reason });
      controller.abort();
    };

    const timer = setIntervalFn(() => {
      void (async () => {
        if (!held) return;
        try {
          const renewed = await this.db.query<{ holder: string }>(RENEW, [
            name,
            holder,
            this.ttlSeconds,
          ]);
          // No row means the lease is no longer ours: it expired while we were
          // slow, or another worker took it over. Either way the job must stop
          // — the other holder is already running it.
          if (renewed.rows.length === 0) lose('not_owner_or_expired');
        } catch {
          // A renewal that could not reach the database is not proof the lease
          // is lost, but it is proof we can no longer defend it. Failing closed
          // is the only choice that cannot produce two runners.
          lose('unreachable');
        }
      })();
    }, this.options.renewEveryMs);
    // Never hold the process open for a renewal timer.
    (timer as unknown as { unref?: () => void }).unref?.();

    return {
      signal: controller.signal,
      isHeld: () => held,
      release: async () => {
        const wasHeld = held;
        held = false;
        clearIntervalFn(timer);
        if (!wasHeld) return; // Lost already; the row belongs to someone else.
        try {
          await this.db.query(RELEASE, [name, holder]);
        } catch {
          // Leaving it to expire is correct and costs at most one TTL. Throwing
          // here would turn a tidy-up failure into a failed job.
          this.options.report?.('worker_lease_release_failed', { job: name });
        }
      },
    };
  }
}
