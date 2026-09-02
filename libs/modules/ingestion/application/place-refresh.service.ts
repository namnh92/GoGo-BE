import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type PlaceProviderPort,
} from '@gogo/providers';
import { writeAudit } from '../../shared/audit';
import { flagEnvironmentOf, resolveFlag, type FlagEnvironment } from '../../shared/feature-flags';
import type {
  BudgetLimits,
  ProviderBudgetService,
} from '../../cost/application/provider-budget.service';
import {
  classifyLiveness,
  scheduleFor,
  type RefreshAnswer,
  type RefreshOutcome,
} from '../domain/place-refresh';

/**
 * PR7 / COST-BE-007 (#340) — `gogo:worker:place-refresh`.
 *
 * `place_provider_sources.refresh_after` has been written since the first
 * ingestion migration (`fetched_at + 30d`) and read by nothing. This job is
 * what reads it: once per tick it asks Google, for a bounded number of rows
 * that are due, the cheapest question there is — *does this Place ID still
 * resolve, and has it moved?* That is the IDs-Only mask, which Google bills at
 * $0 (plan §0.1 D6).
 *
 * Four independent bounds, because a scheduled spender needs every one of them
 * and the absence of any single one is how a job like this becomes an invoice:
 *
 * 1. **Kill switch** — `place_refresh.enabled`, resolved per tick, with
 *    `FLAG_PLACE_REFRESH` as the deploy-time default. Off means no provider
 *    call at all, not a smaller batch.
 * 2. **Hard budget** — a `provider_budget_daily` reservation on scope
 *    `google.places.refresh` before the first call of the tick. The guard is
 *    default-deny: an unconfigured ceiling refuses, so a fresh environment
 *    runs this job and spends nothing until someone sets its numbers.
 * 3. **Batch limit** — a fixed number of rows per tick, whatever the backlog.
 * 4. **Deadline** — a wall-clock budget per tick, so a slow provider cannot
 *    let one tick run into the next (the runner also serialises ticks, and a
 *    Postgres advisory lock keeps two replicas apart).
 *
 * Nothing here writes provider content. The only Google-derived value it
 * stores is a successor **Place ID** (SST §3, ADR-0006 §9.3); a liveness answer
 * carries nothing else, which is what makes phase 1 policy-safe while
 * ADR-0006 §9.6 is unsigned. Closure is not decided here and cannot be: with no
 * `businessStatus` in the answer, this job never writes `closed`,
 * `temporarily_closed` — or a status derived from `FUTURE_OPENING`, which it
 * has no way to learn.
 */

/** Rows per tick. Bounded by the daily ceilings too; this bounds one tick. */
export const REFRESH_BATCH_SIZE = 20;

/**
 * Wall-clock budget per tick, derived rather than configured: the adapter
 * allows 5s per attempt and retries twice, so 15s is one call's worst case and
 * the batch's worst case is the product. A tick that hits it stops and leaves
 * the rest due — the next tick picks them up in the same order.
 */
export const REFRESH_CALL_BUDGET_MS = 15_000;

const GOOGLE_PROVIDER = 'google_places';
const REFRESH_SCOPE = 'google.places.refresh' as const;
const REFRESH_OPERATION = 'google.details.liveness';

type DueRow = {
  id: string;
  placeId: string;
  externalId: string;
  refreshAttempts: number;
  transientFailures: number;
};

export type PlaceRefreshReport = {
  /** What the tick as a whole did. */
  tick: 'disabled' | 'nothing_due' | 'refused_budget' | 'ran';
  attempted: number;
  succeeded: number;
  moved: number;
  invalidIdentity: number;
  dormant: number;
  /** Rows pushed out of the way because the provider, not the row, failed. */
  deferred: number;
  /** Set when the tick stopped early. */
  stoppedBy?: 'provider_error' | 'deadline' | 'refused_budget';
  refusal?: string;
  errorCode?: string;
};

export type PlaceRefreshOptions = {
  appEnv: string;
  /** Deploy-time default when no `feature_flags` row matches. */
  flagDefault: boolean;
  limits: BudgetLimits;
  batchSize?: number;
  deadlineMs?: number;
  /** Injected in tests; production passes nothing. */
  now?: () => Date;
};

export class PlaceRefreshService {
  private readonly environment: FlagEnvironment;
  private readonly batchSize: number;
  private readonly deadlineMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly provider: PlaceProviderPort,
    private readonly budget: ProviderBudgetService,
    private readonly metrics: MetricsPort,
    private readonly options: PlaceRefreshOptions,
  ) {
    this.environment = flagEnvironmentOf(options.appEnv);
    this.batchSize = options.batchSize ?? REFRESH_BATCH_SIZE;
    this.deadlineMs = options.deadlineMs ?? this.batchSize * REFRESH_CALL_BUDGET_MS;
    this.now = options.now ?? (() => new Date());
  }

  async tick(): Promise<PlaceRefreshReport> {
    const report: PlaceRefreshReport = {
      tick: 'ran',
      attempted: 0,
      succeeded: 0,
      moved: 0,
      invalidIdentity: 0,
      dormant: 0,
      deferred: 0,
    };

    if (!(await this.enabled())) {
      this.count('disabled');
      return { ...report, tick: 'disabled' };
    }

    const rows = await this.dueRows();
    if (rows.length === 0) {
      this.count('deferred_not_due');
      return { ...report, tick: 'nothing_due' };
    }

    const startedAt = Date.now();
    for (const row of rows) {
      if (Date.now() - startedAt >= this.deadlineMs) {
        this.count('deadline');
        report.stoppedBy = 'deadline';
        break;
      }

      /**
       * One reservation per call, immediately before it.
       *
       * Plan §2.5 words this as "reserve N, then select N", and PR7 first
       * shipped it as one reservation for the whole batch. That is wrong in
       * the one case a hard budget exists for. Reservations are never refunded
       * (a call that failed still consumed Google quota), so a tick that
       * reserves twenty and stops on the first row's outage has spent twenty
       * and asked once — and because the rows stay due, the next tick does it
       * again. An afternoon of quota errors would eat a day's ceiling in a few
       * hours of one-call ticks. Reserving per call keeps the ledger equal to
       * the calls that happened, which is the property the guard was for.
       */
      const reservation = await this.budget.reserve(
        { scope: REFRESH_SCOPE, operation: REFRESH_OPERATION, calls: 1, units: 1 },
        this.options.limits,
      );
      if (!reservation.ok) {
        this.count('refused_budget');
        report.refusal = reservation.reason;
        // Refused before any call is a refused tick; refused part-way is a
        // tick that ran and hit its ceiling. Both leave the rest due.
        if (report.attempted === 0) return { ...report, tick: 'refused_budget' };
        report.stoppedBy = 'refused_budget';
        break;
      }

      report.attempted += 1;
      this.count('attempted');
      const answer = await this.ask(row);

      if (answer.kind === 'provider_error') {
        // The row did not fail — the provider did. It keeps its attempt count
        // and its status, and it is pushed out of the way for a bounded while
        // so the next tick does not pay to ask the same question into the same
        // outage. Then the tick stops: whatever broke this call breaks the
        // next nineteen.
        this.count('provider_error');
        await this.defer(row, answer.errorCode);
        report.deferred += 1;
        report.stoppedBy = 'provider_error';
        report.errorCode = answer.errorCode;
        break;
      }

      await this.apply(row, answer, report);
    }

    return report;
  }

  /**
   * Push a row past a transient failure.
   *
   * Everything that describes the *place* is untouched: `refresh_attempts`,
   * `source_status`, and the place's own row. The only things that move are
   * when we will ask again and why we did not get an answer.
   */
  private async defer(row: DueRow, errorCode: string): Promise<void> {
    const next = scheduleFor(
      { kind: 'provider_error', errorCode },
      { attempts: row.refreshAttempts, transientFailures: row.transientFailures },
      this.now(),
    );
    if (next.state !== 'deferred') return;
    await this.db.execute(sql`
      update place_provider_sources
      set refresh_after = ${next.refreshAfter.toISOString()},
          transient_failures = ${next.transientFailures},
          last_refresh_attempt_at = now(),
          last_refresh_error_code = ${next.errorCode}
      where id = ${row.id}
    `);
  }

  /**
   * The kill switch, read once per tick.
   *
   * A stored row wins; with no row the deploy-time default applies. Unlike
   * PR4's two rollback flags this one defaults **off** in the registry: those
   * removed spend, this one adds it, and a job that starts calling Google the
   * moment it is deployed is not a job anyone chose to run.
   */
  private async enabled(): Promise<boolean> {
    const resolved = await resolveFlag(this.db, 'place_refresh.enabled', {
      environment: this.environment,
    });
    return resolved.isDefault ? this.options.flagDefault : resolved.enabled;
  }

  /**
   * What is due, in the order the partial index stores it.
   *
   * No `FOR UPDATE SKIP LOCKED`: one advisory lock already serialises the job
   * across replicas (plan §0.1 D3), and row locks here would buy nothing but a
   * second concurrency model to reason about.
   */
  private async dueRows(): Promise<DueRow[]> {
    const { rows } = await this.db.execute(sql`
      select id, place_id, external_id, refresh_attempts, transient_failures
      from place_provider_sources
      where provider = ${GOOGLE_PROVIDER}
        and refresh_after is not null
        and refresh_after <= now()
      order by refresh_priority desc, refresh_after asc, id asc
      limit ${this.batchSize}
    `);
    return (
      rows as unknown as {
        id: string;
        place_id: string;
        external_id: string;
        refresh_attempts: number | string;
        transient_failures: number | string;
      }[]
    ).map((row) => ({
      id: row.id,
      placeId: row.place_id,
      externalId: row.external_id,
      refreshAttempts: Number(row.refresh_attempts ?? 0),
      transientFailures: Number(row.transient_failures ?? 0),
    }));
  }

  /** One liveness call, with every provider failure mapped to a code. */
  private async ask(row: DueRow): Promise<RefreshAnswer> {
    try {
      const identity = await this.provider.details(row.externalId, 'liveness');
      return classifyLiveness({ requestedExternalId: row.externalId, identity });
    } catch (err) {
      if (err instanceof ProviderInvalidRequestError) {
        // Google says the id is wrong or gone. That is about this row, and it
        // is the only failure class that counts against it.
        return classifyLiveness({
          requestedExternalId: row.externalId,
          identity: null,
          rejectedWith: err.canonicalStatus,
        });
      }
      const code =
        err instanceof ProviderQuotaExceededError
          ? 'QUOTA_EXCEEDED'
          : err instanceof ProviderConfigurationError
            ? err.faultCode
            : err instanceof ProviderUnavailableError
              ? 'PROVIDER_UNAVAILABLE'
              : 'UNKNOWN';
      return { kind: 'provider_error', errorCode: code };
    }
  }

  /** Apply one answer. Absolute writes, so re-running a tick changes nothing. */
  private async apply(
    row: DueRow,
    answer: Exclude<RefreshAnswer, { kind: 'provider_error' }>,
    report: PlaceRefreshReport,
  ): Promise<void> {
    const now = this.now();
    const next = scheduleFor(
      answer,
      { attempts: row.refreshAttempts, transientFailures: row.transientFailures },
      now,
    );

    // Unreachable by construction — `apply` is never called for a provider
    // error, which is the only answer that defers. Stated for the compiler so
    // the dormant branch below can read `next.attempts` without a cast, and so
    // a future answer kind cannot silently fall into it.
    if (next.state === 'deferred') return;

    await this.db.transaction(async (tx) => {
      if (next.state === 'alive') {
        await tx.execute(sql`
          update place_provider_sources
          set fetched_at = now(),
              refresh_after = ${next.refreshAfter.toISOString()},
              refresh_attempts = 0,
              transient_failures = 0,
              last_refresh_attempt_at = now(),
              last_refresh_error_code = null
          where id = ${row.id}
        `);
        // A timestamp, not a fact about the place: "we checked", not "this is
        // what it says". The catalogue row is otherwise untouched.
        await tx.execute(sql`
          update places set freshness_checked_at = now() where id = ${row.placeId}
        `);
        return;
      }

      if (next.state === 'moved') {
        await tx.execute(sql`
          update place_provider_sources
          set source_status = 'moved',
              moved_to_external_id = ${answer.kind === 'moved' ? answer.movedToExternalId : null},
              refresh_after = null,
              refresh_attempts = 0,
              transient_failures = 0,
              last_refresh_attempt_at = now(),
              last_refresh_error_code = null
          where id = ${row.id}
        `);
        // #339's rule, reached through a different door: an identity change
        // routes the *place* to review, because search, suggestions and plans
        // read `places.status` and a place that may now be a different business
        // must stop being offered until an editor decides. Nothing repoints the
        // place onto the successor id and nothing creates a place for it.
        const moved = await tx.execute(sql`
          update places set status = 'review', updated_at = now()
          where id = ${row.placeId} and status = 'published'
          returning id
        `);
        if (moved.rows.length > 0) {
          await writeAudit(tx, {
            actorType: 'system',
            action: 'place.identity_review_required',
            resourceType: 'place',
            resourceId: row.placeId,
            // Place IDs and a signal name. No name, no address, no status —
            // there is none in a liveness answer, and the audit log is not a
            // side door for provider content (plan §7).
            diff: {
              reasons: ['provider_moved'],
              signal: answer.kind === 'moved' ? answer.signal : 'unknown',
              externalId: {
                before: row.externalId,
                after: answer.kind === 'moved' ? answer.movedToExternalId : null,
              },
              source: 'place_refresh',
            },
          });
        }
        return;
      }

      if (next.state === 'retry') {
        await tx.execute(sql`
          update place_provider_sources
          set refresh_attempts = ${next.attempts},
              refresh_after = ${next.refreshAfter.toISOString()},
              transient_failures = 0,
              last_refresh_attempt_at = now(),
              last_refresh_error_code = ${next.errorCode}
          where id = ${row.id}
        `);
        return;
      }

      // Dormant. `unknown` is the honest status for an id that stopped
      // resolving: it is not `closed` (nobody told us the business shut) and
      // not `active` (we could not confirm it). It is also the one status a
      // DB-first read declines to answer from, so the next path that needs the
      // truth asks Google rather than trusting this row.
      await tx.execute(sql`
        update place_provider_sources
        set refresh_attempts = ${next.attempts},
            refresh_after = null,
            transient_failures = 0,
            source_status = 'unknown',
            last_refresh_attempt_at = now(),
            last_refresh_error_code = ${next.errorCode}
        where id = ${row.id}
      `);
      /**
       * …and the place stops being served.
       *
       * The job has now permanently stopped checking this identity, and the
       * first version of this shipped leaving the place `published`. That is
       * the worst of both: nothing is watching the id any more, and search
       * keeps offering the place — an unverifiable identity would sit in the
       * catalogue indefinitely with no clock on it and nobody told.
       *
       * `review` is the same door #339 uses for an identity change, and it is
       * a review queue, not a deletion: the row is kept in full, the Place ID
       * is kept, and an editor can re-resolve or retire it. Search reads
       * `places.status = 'published'`, so this is what takes it out of results
       * (`search.repository.ts`), and it is only reached by three *definitive*
       * rejections — a provider outage never gets here, because a transient
       * failure is deferred long before it can count.
       */
      const removed = await tx.execute(sql`
        update places set status = 'review', updated_at = now()
        where id = ${row.placeId} and status = 'published'
        returning id
      `);
      await writeAudit(tx, {
        actorType: 'system',
        action: 'place.refresh_identity_unverifiable',
        resourceType: 'place',
        resourceId: row.placeId,
        diff: {
          externalId: row.externalId,
          attempts: next.attempts,
          errorCode: next.errorCode,
          // Whether this actually took a place out of circulation, or it was
          // already out. An audit line that always claims the former would be
          // false for every draft place.
          removedFromCatalogue: removed.rows.length > 0,
          source: 'place_refresh',
        },
      });
    });

    if (next.state === 'alive') {
      report.succeeded += 1;
      this.count('succeeded');
    } else if (next.state === 'moved') {
      report.moved += 1;
      this.count('moved');
    } else {
      report.invalidIdentity += 1;
      this.count('invalid_identity');
      if (next.state === 'dormant') {
        report.dormant += 1;
        this.count('dormant');
      }
    }
  }

  private count(outcome: RefreshOutcome): void {
    this.metrics.increment('place_refresh_total', { outcome });
  }
}
