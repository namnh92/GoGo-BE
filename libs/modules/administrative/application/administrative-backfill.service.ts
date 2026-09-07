import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import {
  classify,
  count,
  countResolution,
  emptyCounters,
  type BackfillCounters,
  type BackfillSample,
} from '../domain/backfill-outcome';
import { AdministrativeResolverService } from './administrative-resolver.service';

/**
 * ADM-008 (#461) / ADR-0019 §10 — geometry-only enrichment of existing places.
 *
 * The job walks the catalogue and asks ADM-006's resolver about each eligible
 * place. It reimplements none of the resolver's rules: the same
 * `resolvePlace`/`persist` pair a single-place call uses, so a place enriched
 * in bulk and a place enriched one at a time get the same answer, the same
 * transition matrix, and the same reviewer protections.
 *
 * Four properties this shape exists for:
 *
 * **Dry run is the default.** Writing requires asking. A dry run executes the
 * real selection and the real resolver and reports exactly what it would have
 * written; that is what makes it evidence about the execute rather than a
 * rehearsal of a different program.
 *
 * **Batches commit separately.** One transaction across a catalogue would hold
 * locks for its whole duration, and a failure at 90% would throw away the 90%.
 * Each place is its own write; each batch checkpoints a cursor. A run resumes
 * strictly after its last committed id.
 *
 * **A run is pinned.** The dataset and boundary versions are captured when the
 * run starts and re-checked before every batch. If the active version moves
 * underneath the run it stops, rather than writing half the catalogue against
 * one dataset and half against another — the failure mode that would be
 * invisible afterwards, because each row would look individually correct.
 *
 * **Nothing outside the mapping is touched.** No provider call at any point, no
 * `city`, `district`, `address_text` or `geom` write, and neither a `VERIFIED`
 * nor a `REJECTED` row.
 *
 * **`REJECTED` is unreachable from here, deliberately.** ADM-006 can reopen a
 * rejected mapping under an explicit authorised rematch, and this job has no
 * way to authorise one: every CLI-originated audit row in this repository is
 * written as `actorType: 'system'` with a null actor id, because no command
 * authenticates anybody. A bulk process that could reopen a reviewer's
 * rejection while recording "system" as the person who asked is worse than one
 * that cannot reopen it at all. Rematch belongs to the authenticated CMS
 * workflow in #462, where there is a real reviewer to name.
 */

export type BackfillOptions = {
  /** Default true. Writing is opt-in, everywhere. */
  dryRun?: boolean;
  batchSize?: number;
  maxRows?: number;
  placeIds?: string[];
  resumeRunId?: string;
  retry?: 'conflicts' | 'failures';
  sampleLimit?: number;
  actor?: { id: string | null; type: 'admin' | 'system' };
};

export type BackfillStatus = 'completed' | 'stopped_version_changed' | 'failed' | 'abandoned';

export type BackfillResult = {
  runId: string;
  status: BackfillStatus;
  dryRun: boolean;
  datasetVersionId: string;
  datasetVersion: string;
  boundaryVersion: string | null;
  counters: BackfillCounters;
  samples: BackfillSample[];
  conflicts: string[];
  failures: { placeId: string; error: string }[];
  cursor: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Asserted, not assumed: this job cannot reach a provider. */
  providerRequests: 0;
  upstashCommands: 0;
  estimatedProviderCostUsd: 0;
};

const DEFAULT_BATCH = 200;
const DEFAULT_SAMPLE_LIMIT = 20;
/** Bounded so one bad release cannot turn a run row into a 100,000-element array. */
const RETRY_LIST_LIMIT = 500;

@Injectable()
export class AdministrativeBackfillService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly resolver: AdministrativeResolverService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async run(options: BackfillOptions = {}): Promise<BackfillResult> {
    const startedAt = Date.now();
    const dryRun = options.dryRun !== false;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH, 1000));
    const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;

    const run = options.resumeRunId
      ? await this.resumeRun(options.resumeRunId)
      : await this.startRun(options, dryRun, batchSize);

    const counters: BackfillCounters = { ...emptyCounters(), ...(run.counters as object) };
    const samples: BackfillSample[] = [];
    const conflicts: string[] = [...(run.conflicts as string[])];
    const failures: { placeId: string; error: string }[] = [
      ...(run.failures as { placeId: string; error: string }[]),
    ];

    const placeIds = options.retry
      ? this.retryTargets(options.retry, conflicts, failures)
      : options.placeIds;
    let cursor = options.retry ? null : run.cursor;
    let status: BackfillStatus = 'completed';

    if (!options.resumeRunId) {
      counters.alreadyCurrent = await this.alreadyCurrent(run);
    }

    try {
      for (;;) {
        // Pinned-run policy, enforced before **every** batch including the
        // first one of a resume: the run's recorded versions must still be the
        // active ones. Not "the snapshots are still in the database" — old
        // boundary rows stay queryable forever and would authorise writing a
        // mapping stamped with a version nothing serves any more. A moved
        // pointer stops the run with its cursor and counters intact.
        if (!(await this.activeVersionsMatch(run))) {
          status = 'stopped_version_changed';
          break;
        }

        const batch = await this.selectBatch(run, {
          cursor,
          batchSize,
          ...(placeIds ? { placeIds } : {}),
        });
        if (batch.length === 0) break;

        for (const place of batch) {
          counters.scanned += 1;
          counters.eligible += 1;
          try {
            const resolution = await this.resolver.resolvePlace(place.id, {
              datasetVersionId: run.datasetVersionId,
              boundaryVersion: run.pinnedBoundaryVersion,
            });
            countResolution(counters, resolution);

            if (dryRun) {
              // The write is decided here and not performed. `writable` and
              // `changed` are the resolver's own answers, so the count is the
              // count the execute run will produce.
              const outcome =
                resolution.writable && resolution.changed
                  ? ('would_write' as const)
                  : resolution.writable
                    ? ('noop' as const)
                    : classify('blocked', place.status);
              count(counters, outcome);
              if (samples.length < sampleLimit) {
                samples.push(sample(place.id, outcome, resolution));
              }
              cursor = place.id;
              continue;
            }

            const persisted = await this.resolver.persist(resolution, {
              // Optimistic concurrency: the row as it was when it was selected.
              // A place edited between selection and write is a conflict, never
              // an overwrite.
              expectedUpdatedAt: place.updatedAt,
              ...(options.actor ? { actor: options.actor } : {}),
              runId: run.id,
            });
            const outcome = classify(persisted.outcome, place.status);
            count(counters, outcome);
            if (outcome === 'conflict' && conflicts.length < RETRY_LIST_LIMIT) {
              conflicts.push(place.id);
            }
            if (samples.length < sampleLimit) samples.push(sample(place.id, outcome, resolution));
          } catch (error) {
            // One place's failure is one place's failure. The batches already
            // committed stay committed, and the id is kept so a retry can name
            // it instead of re-walking the catalogue.
            count(counters, 'failure');
            if (failures.length < RETRY_LIST_LIMIT) {
              failures.push({
                placeId: place.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          cursor = place.id;
          if (options.maxRows && counters.scanned >= options.maxRows) break;
        }

        await this.checkpoint(run.id, cursor, counters, conflicts, failures);
        this.metrics.increment('administrative_backfill_batches_total', {
          outcome: dryRun ? 'dry_run' : 'executed',
        });
        if (options.maxRows && counters.scanned >= options.maxRows) break;
      }
      // The run-level audit row: one per run, not one per place left alone.
      // Per-place material writes carry their own row citing this run id.
      // Inside the try, and before the run is marked finished: a run whose own
      // summary cannot be written has not succeeded, and marking it completed
      // first would leave a run that claims to have finished with no record of
      // what it did.
      await this.audit(run, options, dryRun, status, counters, cursor, Date.now() - startedAt);
    } catch (error) {
      await this.finish(run.id, 'failed', cursor, counters, conflicts, failures, error);
      throw error;
    }

    await this.finish(run.id, status, cursor, counters, conflicts, failures);
    const completedAt = Date.now();

    return this.result(
      run,
      dryRun,
      status,
      counters,
      samples,
      conflicts,
      failures,
      cursor,
      startedAt,
      completedAt,
    );
  }

  private async audit(
    run: RunRow,
    options: BackfillOptions,
    dryRun: boolean,
    status: BackfillResult['status'],
    counters: BackfillCounters,
    cursor: string | null,
    durationMs: number,
  ): Promise<void> {
    await writeAudit(this.db, {
      actorType: options.actor?.type ?? 'system',
      actorId: options.actor?.id ?? null,
      action: dryRun ? 'administrative_backfill.dry_run' : 'administrative_backfill.run',
      resourceType: 'administrative_backfill_run',
      resourceId: run.id,
      diff: {
        status,
        dryRun,
        datasetVersion: run.pinnedDatasetVersion,
        boundaryVersion: run.pinnedBoundaryVersion,
        scope: run.scope,
        counters,
        cursor,
        durationMs,
      },
    });
  }

  private result(
    run: RunRow,
    dryRun: boolean,
    status: BackfillResult['status'],
    counters: BackfillCounters,
    samples: BackfillSample[],
    conflicts: string[],
    failures: { placeId: string; error: string }[],
    cursor: string | null,
    startedAt: number,
    completedAt: number,
  ): BackfillResult {
    return {
      runId: run.id,
      status,
      dryRun,
      datasetVersionId: run.datasetVersionId,
      datasetVersion: run.pinnedDatasetVersion,
      boundaryVersion: run.pinnedBoundaryVersion,
      counters,
      samples,
      conflicts,
      failures,
      cursor,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      // Structural, not aspirational: the resolver's evidence is stored
      // geometry and GoGo's own pinned data, and nothing on this path can
      // reach Google or Upstash.
      providerRequests: 0,
      upstashCommands: 0,
      estimatedProviderCostUsd: 0,
    };
  }

  /**
   * The eligibility policy, as one query.
   *
   * `geom` is `NOT NULL` in the schema, so "geometry is present" is not a
   * predicate here — it is a guarantee. Geometry that is present and *unusable*
   * (outside Vietnam, non-finite) is the resolver's business and resolves to
   * `UNMAPPED` with a reason, which is a result worth recording rather than a
   * row worth hiding.
   *
   * The version predicate is what stops a re-run from being a full pass over a
   * catalogue with no work in it: a place already resolved against these exact
   * dataset and boundary versions is not selected at all.
   */
  private async selectBatch(
    run: RunRow,
    options: { cursor: string | null; batchSize: number; placeIds?: string[] },
  ): Promise<{ id: string; updatedAt: Date; status: MappingStatusValue }[]> {
    // The query builder rather than raw SQL, and not for taste: `db.execute`
    // returns `updated_at` as a **string**, so an optimistic-concurrency check
    // written against a raw row throws on every single place. The typed select
    // returns a Date, which is what `persist` compares against.
    return this.db
      .select({
        id: schema.places.id,
        updatedAt: schema.places.updatedAt,
        status: schema.places.administrativeMappingStatus,
      })
      .from(schema.places)
      .where(and(...this.eligibility(run, options)))
      .orderBy(schema.places.id)
      .limit(options.batchSize);
  }

  /**
   * The eligibility policy, in one place.
   *
   * `geom` is `NOT NULL` in the schema, so "geometry is present" is a guarantee
   * rather than a predicate. Geometry that is present and *unusable* — outside
   * Vietnam, non-finite — is the resolver's business and resolves to `UNMAPPED`
   * with a reason, which is a result worth recording rather than a row worth
   * hiding.
   *
   * The version predicate is what stops a re-run from being a full pass over a
   * catalogue with no work in it: a place already resolved against these exact
   * dataset and boundary versions is not selected at all.
   */
  private eligibility(run: RunRow, options: { cursor: string | null; placeIds?: string[] }) {
    const conditions = [
      // Both reviewer-owned states are excluded in SQL, so neither ever reaches
      // the resolver. `REJECTED` has no flag that opens it here: see the class
      // comment — this job has no authenticated actor to attribute a rematch to.
      ne(schema.places.administrativeMappingStatus, 'VERIFIED'),
      ne(schema.places.administrativeMappingStatus, 'REJECTED'),
      sql`(${schema.places.administrativeDatasetVersion} is distinct from ${run.pinnedDatasetVersion}
           or ${schema.places.administrativeBoundaryVersion} is distinct from ${run.pinnedBoundaryVersion})`,
    ];
    if (options.cursor) conditions.push(gt(schema.places.id, options.cursor));
    if (options.placeIds) conditions.push(inArray(schema.places.id, options.placeIds));
    return conditions;
  }

  /** Places the selection will skip because they are already at these versions. */
  private async alreadyCurrent(run: RunRow): Promise<number> {
    const conditions = [
      ne(schema.places.administrativeMappingStatus, 'VERIFIED'),
      ne(schema.places.administrativeMappingStatus, 'REJECTED'),
      sql`(${schema.places.administrativeDatasetVersion} is not distinct from ${run.pinnedDatasetVersion}
           and ${schema.places.administrativeBoundaryVersion} is not distinct from ${run.pinnedBoundaryVersion})`,
    ];
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.places)
      .where(and(...conditions));
    return row?.n ?? 0;
  }

  private retryTargets(
    retry: 'conflicts' | 'failures',
    conflicts: string[],
    failures: { placeId: string }[],
  ): string[] {
    const ids = retry === 'conflicts' ? conflicts : failures.map((f) => f.placeId);
    if (ids.length === 0) {
      throw AppError.badRequest('NOTHING_TO_RETRY', `the run recorded no ${retry}`);
    }
    return ids;
  }

  private async startRun(
    options: BackfillOptions,
    dryRun: boolean,
    batchSize: number,
  ): Promise<RunRow> {
    const [dataset] = await this.db
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    if (!dataset) {
      throw AppError.serviceUnavailable(
        'ADMINISTRATIVE_DATASET_UNAVAILABLE',
        'no administrative dataset is published; there is nothing to enrich against',
      );
    }
    const [row] = await this.db
      .insert(schema.administrativeBackfillRuns)
      .values({
        status: 'running',
        dryRun,
        datasetVersionId: dataset.id,
        pinnedDatasetVersion: dataset.combinedDatasetVersion,
        pinnedBoundaryVersion: dataset.boundarySourceVersion,
        scope: {
          batchSize,
          maxRows: options.maxRows ?? null,
          placeIds: options.placeIds ?? null,
          retry: options.retry ?? null,
        },
        counters: emptyCounters(),
      })
      .returning();
    return row as RunRow;
  }

  private async resumeRun(runId: string): Promise<RunRow> {
    const [row] = await this.db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, runId))
      .limit(1);
    if (!row) throw AppError.notFound('BACKFILL_RUN_NOT_FOUND', `no backfill run ${runId}`);
    if (row.status === 'abandoned') {
      throw AppError.conflict(
        'BACKFILL_RUN_ABANDONED',
        `run ${runId} was abandoned; start a new run pinned to the active versions`,
      );
    }
    // Every other status may be resumed, `completed` included: resume continues
    // strictly after the recorded cursor, so resuming a run that finished its
    // bounded scope — `--max 1000` — is how the next thousand get done, and
    // resuming one that reached the end selects nothing. Refusing would make a
    // capped run a dead end.
    //
    // The status is deliberately **not** set to `running` here. A resume that
    // stops immediately on the version check would otherwise leave the row
    // reading `running` for the instant in between, and a resume that crashed
    // there would leave it reading `running` forever.
    return row as RunRow;
  }

  /** True while the published dataset and its boundary release are the pinned ones. */
  private async activeVersionsMatch(run: RunRow): Promise<boolean> {
    const [row] = await this.db
      .select({
        version: schema.administrativeDatasetVersions.combinedDatasetVersion,
        boundary: schema.administrativeDatasetVersions.boundarySourceVersion,
      })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    return row?.version === run.pinnedDatasetVersion && row?.boundary === run.pinnedBoundaryVersion;
  }

  /**
   * Closes a run that will not be resumed.
   *
   * A version-stopped run whose versions never come back is not going to
   * finish, and leaving it in `stopped_version_changed` says the opposite —
   * that it is waiting for something. The pins are untouched: what the run was
   * bound to stays on the record, and the new work goes into a new run bound to
   * the versions that are actually active.
   */
  async abandon(runId: string, reason: string): Promise<void> {
    if (!reason.trim()) {
      throw AppError.badRequest('REASON_REQUIRED', 'abandoning a run requires a reason');
    }
    const [row] = await this.db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, runId))
      .limit(1);
    if (!row) throw AppError.notFound('BACKFILL_RUN_NOT_FOUND', `no backfill run ${runId}`);

    await this.db
      .update(schema.administrativeBackfillRuns)
      .set({
        status: 'abandoned',
        failureReason: reason,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.administrativeBackfillRuns.id, runId));

    await writeAudit(this.db, {
      actorType: 'system',
      actorId: null,
      action: 'administrative_backfill.abandon',
      resourceType: 'administrative_backfill_run',
      resourceId: runId,
      diff: {
        reason,
        previousStatus: row.status,
        pinnedDatasetVersion: row.pinnedDatasetVersion,
        pinnedBoundaryVersion: row.pinnedBoundaryVersion,
        cursor: row.cursor,
        counters: row.counters,
      },
    });
  }

  private async checkpoint(
    runId: string,
    cursor: string | null,
    counters: BackfillCounters,
    conflicts: string[],
    failures: { placeId: string; error: string }[],
  ): Promise<void> {
    await this.db
      .update(schema.administrativeBackfillRuns)
      .set({ cursor, counters, conflicts, failures, updatedAt: new Date() })
      .where(eq(schema.administrativeBackfillRuns.id, runId));
  }

  private async finish(
    runId: string,
    status: BackfillStatus,
    cursor: string | null,
    counters: BackfillCounters,
    conflicts: string[],
    failures: { placeId: string; error: string }[],
    error?: unknown,
  ): Promise<void> {
    await this.db
      .update(schema.administrativeBackfillRuns)
      .set({
        status,
        cursor,
        counters,
        conflicts,
        failures,
        completedAt: new Date(),
        updatedAt: new Date(),
        ...(error ? { failureReason: error instanceof Error ? error.message : String(error) } : {}),
      })
      .where(eq(schema.administrativeBackfillRuns.id, runId));
  }
}

type RunRow = typeof schema.administrativeBackfillRuns.$inferSelect;
type MappingStatusValue = Parameters<typeof classify>[1];

function sample(
  placeId: string,
  outcome: Parameters<typeof count>[1],
  resolution: { status: MappingStatusValue; communeCode: string | null; reason: unknown },
): BackfillSample {
  return {
    placeId,
    outcome,
    status: resolution.status,
    communeCode: resolution.communeCode,
    reason: resolution.reason as BackfillSample['reason'],
  };
}
