import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { TRANSITION_LOCK, TRANSITION_LOCK_TIMEOUT } from './administrative-transition';
import {
  publishRefusal,
  rollbackRefusal,
  type PersistedValidation,
  type Refusal,
} from '../domain/publication-gates';
import type { DatasetDiff } from '../domain/dataset-diff';
import {
  ADMINISTRATIVE_DATASET,
  type AdministrativeDatasetPort,
} from './administrative-dataset.port';
import { AUDIT_ACTION, AUDIT_RESOURCE } from './administrative-audit';
import { PinnedSnapshotReader } from './pinned-snapshot.reader';
import {
  AdministrativeValidationService,
  type DatasetRow,
} from './administrative-validation.service';
import { boundaryIdentity, snapshotFingerprint } from './snapshot-fingerprint';

/**
 * ADM-005 (#458) / ADR-0019 §3 — publishing and rolling back the active
 * administrative dataset.
 *
 * The whole design follows from one sentence: **the server proves publishability
 * for itself, inside the transaction that switches the pointer.** A caller names
 * a dataset and nothing else. Every fact the decision rests on — the lifecycle
 * status, the stored checksum, the checksum the pinned files produce now, the
 * digest of the staged rows, and which validation result describes them — is
 * re-read under lock immediately before the switch. A pre-flight pass runs
 * first, but only so a doomed publication does not pay for a diff; it decides
 * nothing.
 *
 * Two invariants that a naive implementation loses:
 *
 * **Never two active versions, never zero.** The demote and the promote are one
 * transaction, serialised by an advisory lock, with the partial unique index as
 * the backstop if anything ever reaches this table without taking the lock.
 *
 * **A cache failure never undoes a commit.** PostgreSQL is authoritative for
 * the active version; the in-process pointer is a memo of what it said. So the
 * warm-up happens strictly after commit and its failure is swallowed — other
 * processes converge within the 60-second TTL either way, and rolling back a
 * published dataset because a local map did not refill would be the tail
 * wagging the dog.
 */

/** Bounded like every other sample window a reviewer reads. */
export const STALE_MAPPING_SAMPLE_LIMIT = 20;

export type DatasetSummary = {
  id: string;
  combinedDatasetVersion: string;
  combinedChecksum: string;
  status: string;
  effectiveDate: string;
  overrideRevision: number;
  sources: {
    currentSourceVersion: string;
    historicalSourceVersion: string | null;
    mappingSourceCommit: string | null;
    boundarySourceVersion: string | null;
  };
  importedAt: string;
  publishedAt: string | null;
  validation: ValidationSummary | null;
};

export type ValidationSummary = {
  validationId: string;
  validatorVersion: string;
  ranAt: string;
  errors: number;
  warnings: number;
  publishable: boolean;
  warningGates: string[];
};

export type StaleMappings = {
  total: number;
  samples: { placeId: string; name: string; code: string; status: string }[];
  truncated: boolean;
  sampleLimit: number;
};

export type TransitionResult = {
  datasetVersionId: string;
  combinedDatasetVersion: string;
  previousActiveVersion: string | null;
  previousActiveVersionId: string | null;
  publishedAt: string;
  validationId: string;
  warnings: number;
  warningGates: string[];
  diff: DatasetDiff;
  staleMappings: StaleMappings;
  cacheWarmed: boolean;
};

@Injectable()
export class AdministrativePublicationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ADMINISTRATIVE_DATASET) private readonly cache: AdministrativeDatasetPort,
    private readonly validation: AdministrativeValidationService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    // #489 — the manifest pin for the boundary checksum. Defaulted so every
    // existing construction site keeps working; the reader is stateless and
    // reads only vendored bytes.
    private readonly reader: PinnedSnapshotReader = new PinnedSnapshotReader(),
  ) {}

  /**
   * One counter for every dataset lifecycle operation, labelled by operation
   * and by result. Neither label is derived from a version, an id or a
   * checksum: those grow without bound and belong in the audit row.
   */
  private record(
    operation: 'import' | 'validate' | 'diff' | 'publish' | 'rollback',
    result: 'succeeded' | 'rejected' | 'failed',
    startedAt: number,
  ): void {
    this.metrics.increment('administrative_dataset_operations_total', { operation, result });
    this.metrics.observe(
      'administrative_dataset_operation_duration_seconds',
      (Date.now() - startedAt) / 1000,
      { operation },
    );
  }

  async list(options: { limit: number; offset: number }): Promise<{
    items: DatasetSummary[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const rows = await this.db
      .select()
      .from(schema.administrativeDatasetVersions)
      .orderBy(desc(schema.administrativeDatasetVersions.importedAt))
      .limit(options.limit)
      .offset(options.offset);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeDatasetVersions);
    return {
      items: (rows as DatasetRow[]).map(summarise),
      total: count?.n ?? 0,
      limit: options.limit,
      offset: options.offset,
    };
  }

  async detail(datasetVersionId: string): Promise<
    DatasetSummary & {
      validationReport: PersistedValidation | null;
      diffSummary: unknown;
    }
  > {
    const row = await this.requireRow(this.db, datasetVersionId);
    return {
      ...summarise(row),
      validationReport: (row.validationReport as PersistedValidation | null) ?? null,
      diffSummary: row.diffSummary ?? null,
    };
  }

  /**
   * Promotes a validated dataset to active.
   *
   * The pre-flight pass exists to refuse cheaply and to compute the diff a
   * reviewer and the audit row both need. It is re-run verbatim under lock,
   * because between the two the sources on disk, the staged rows and the
   * validation result can all move.
   */
  async publish(
    datasetVersionId: string,
    actor: { id: string | null; type: 'admin' | 'system' },
    context: { idempotencyKey?: string | null } = {},
  ): Promise<TransitionResult> {
    const startedAt = Date.now();
    const staged = await this.requireRow(this.db, datasetVersionId);
    const activeBefore = await this.activeRow(this.db);

    const preflight = await this.publishGate(this.db, staged);
    if (preflight) {
      throw await this.refusalError(
        AUDIT_ACTION.publishRejected,
        staged,
        preflight,
        actor,
        context,
      );
    }

    const diff = await this.validation.diffBetween(activeBefore, staged);
    const staleMappings = await this.staleMappings(datasetVersionId);

    const outcome = await this.db.transaction(async (tx) => {
      await this.lockTransition(tx);
      const locked = await this.requireRow(tx, datasetVersionId, true);
      const active = await this.activeRow(tx, true);

      const refusal = await this.publishGate(tx, locked);
      if (refusal) return { refusal } as const;

      // The diff and the impact numbers above describe a switch *from this
      // baseline*. If someone else published while they were being computed,
      // publishing anyway would report an impact that never happened — so the
      // loser of the race is told to look again rather than silently winning.
      if ((active?.id ?? null) !== (activeBefore?.id ?? null)) {
        return {
          refusal: {
            code: 'ACTIVE_VERSION_CHANGED',
            message:
              `the active dataset changed to ${active?.combinedDatasetVersion ?? 'none'} ` +
              'while this publication was being prepared; re-check the diff and retry',
          },
        } as const;
      }

      const publishedAt = await this.switchActive(tx, active, locked, actor);
      const validation = locked.validationReport as PersistedValidation;
      await writeAudit(tx, {
        actorType: actor.type,
        actorId: actor.id,
        action: AUDIT_ACTION.publish,
        resourceType: AUDIT_RESOURCE,
        resourceId: datasetVersionId,
        diff: this.auditPayload(locked, active, validation, diff, staleMappings, context),
      });
      return { publishedAt, validation } as const;
    });

    if ('refusal' in outcome) {
      this.record('publish', 'rejected', startedAt);
      throw await this.refusalError(
        AUDIT_ACTION.publishRejected,
        staged,
        outcome.refusal,
        actor,
        context,
      );
    }

    const cacheWarmed = await this.refreshCache();
    this.record('publish', 'succeeded', startedAt);
    // A warm-up that failed is not a failed publication, and the two must stay
    // tellable apart: PostgreSQL is authoritative and every other process
    // converges on the TTL.
    this.metrics.increment('administrative_cache_refresh_total', {
      result: cacheWarmed ? 'ok' : 'failed',
    });
    return {
      datasetVersionId,
      combinedDatasetVersion: staged.combinedDatasetVersion,
      previousActiveVersion: activeBefore?.combinedDatasetVersion ?? null,
      previousActiveVersionId: activeBefore?.id ?? null,
      publishedAt: outcome.publishedAt.toISOString(),
      validationId: outcome.validation.validationId,
      warnings: outcome.validation.warnings,
      warningGates: warningGates(outcome.validation),
      diff,
      staleMappings,
      cacheWarmed,
    };
  }

  /**
   * Re-activates a version that was published before.
   *
   * A forward act with its own audit row, not an undo: nothing is deleted, no
   * migration is reversed, and the version being left is retained exactly as
   * the version it replaces was.
   */
  async rollback(
    datasetVersionId: string,
    actor: { id: string | null; type: 'admin' | 'system' },
    context: { idempotencyKey?: string | null } = {},
  ): Promise<TransitionResult> {
    const startedAt = Date.now();
    const target = await this.requireRow(this.db, datasetVersionId);
    const activeBefore = await this.activeRow(this.db);

    const preflight = await this.rollbackGate(this.db, target);
    if (preflight) {
      this.record('rollback', 'rejected', startedAt);
      throw await this.refusalError(
        AUDIT_ACTION.rollbackRejected,
        target,
        preflight,
        actor,
        context,
      );
    }

    const diff = await this.validation.diffBetween(activeBefore, target);
    const staleMappings = await this.staleMappings(datasetVersionId);

    const outcome = await this.db.transaction(async (tx) => {
      await this.lockTransition(tx);
      const locked = await this.requireRow(tx, datasetVersionId, true);
      const active = await this.activeRow(tx, true);

      const refusal = await this.rollbackGate(tx, locked);
      if (refusal) return { refusal } as const;
      if ((active?.id ?? null) !== (activeBefore?.id ?? null)) {
        return {
          refusal: {
            code: 'ACTIVE_VERSION_CHANGED',
            message:
              `the active dataset changed to ${active?.combinedDatasetVersion ?? 'none'} ` +
              'while this rollback was being prepared; re-check the diff and retry',
          },
        } as const;
      }

      const publishedAt = await this.switchActive(tx, active, locked, actor);
      const validation = locked.validationReport as PersistedValidation;
      await writeAudit(tx, {
        actorType: actor.type,
        actorId: actor.id,
        action: AUDIT_ACTION.rollback,
        resourceType: AUDIT_RESOURCE,
        resourceId: datasetVersionId,
        diff: {
          ...this.auditPayload(locked, active, validation, diff, staleMappings, context),
          restoredFirstPublishedAt: locked.publishedAt?.toISOString() ?? null,
        },
      });
      return { publishedAt, validation } as const;
    });

    if ('refusal' in outcome) {
      this.record('rollback', 'rejected', startedAt);
      throw await this.refusalError(
        AUDIT_ACTION.rollbackRejected,
        target,
        outcome.refusal,
        actor,
        context,
      );
    }

    const cacheWarmed = await this.refreshCache();
    this.record('rollback', 'succeeded', startedAt);
    this.metrics.increment('administrative_cache_refresh_total', {
      result: cacheWarmed ? 'ok' : 'failed',
    });
    return {
      datasetVersionId,
      combinedDatasetVersion: target.combinedDatasetVersion,
      previousActiveVersion: activeBefore?.combinedDatasetVersion ?? null,
      previousActiveVersionId: activeBefore?.id ?? null,
      publishedAt: outcome.publishedAt.toISOString(),
      validationId: outcome.validation.validationId,
      warnings: outcome.validation.warnings,
      warningGates: warningGates(outcome.validation),
      diff,
      staleMappings,
      cacheWarmed,
    };
  }

  /**
   * Places whose administrative claim does not resolve against a dataset.
   *
   * It **reports**; it writes nothing. Whether a stale claim should be demoted,
   * re-resolved, or left alone for a person to judge is the mapping work's
   * decision (#459/#461/#462) and it depends on facts publication does not
   * have — above all whether a human verified the claim. Publishing must not
   * quietly overwrite that, and `UNMAPPED` rows are excluded because a place
   * with no claim cannot have a stale one.
   */
  async staleMappings(datasetVersionId: string): Promise<StaleMappings> {
    const mapped = ne(schema.places.administrativeMappingStatus, 'UNMAPPED');
    const unresolved = sql`
      ${schema.places.communeCode} is not null
      and not exists (
        select 1 from administrative_units u
        where u.dataset_version_id = ${datasetVersionId}
          and u.code = ${schema.places.communeCode}
          and u.status = 'ACTIVE'
      )`;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.places)
      .where(and(mapped, unresolved));
    const total = row?.n ?? 0;
    if (total === 0) {
      return { total: 0, samples: [], truncated: false, sampleLimit: STALE_MAPPING_SAMPLE_LIMIT };
    }
    const samples = await this.db
      .select({
        placeId: schema.places.id,
        name: schema.places.name,
        code: schema.places.communeCode,
        status: schema.places.administrativeMappingStatus,
      })
      .from(schema.places)
      .where(and(mapped, unresolved))
      .orderBy(schema.places.communeCode, schema.places.id)
      .limit(STALE_MAPPING_SAMPLE_LIMIT);
    return {
      total,
      samples: samples.map((s) => ({
        placeId: s.placeId,
        name: s.name,
        code: s.code ?? '',
        status: s.status,
      })),
      truncated: total > samples.length,
      sampleLimit: STALE_MAPPING_SAMPLE_LIMIT,
    };
  }

  /** Demote then promote, in that order, inside one transaction. */
  private async switchActive(
    tx: Tx,
    active: DatasetRow | null,
    target: DatasetRow,
    actor: { id: string | null },
  ): Promise<Date> {
    const now = new Date();
    if (active) {
      // Retained, never deleted: it is the thing a rollback restores.
      await tx
        .update(schema.administrativeDatasetVersions)
        .set({ status: 'ROLLED_BACK', updatedAt: now })
        .where(eq(schema.administrativeDatasetVersions.id, active.id));
    }
    await tx
      .update(schema.administrativeDatasetVersions)
      .set({
        status: 'PUBLISHED',
        publishedAt: now,
        reviewedBy: actor.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.administrativeDatasetVersions.id, target.id));
    return now;
  }

  private async publishGate(executor: Executor, row: DatasetRow): Promise<Refusal | null> {
    return publishRefusal({
      datasetVersionId: row.id,
      status: row.status,
      combinedDatasetVersion: row.combinedDatasetVersion,
      combinedChecksum: row.combinedChecksum,
      overrideRevision: row.overrideRevision,
      validation: (row.validationReport as PersistedValidation | null) ?? null,
      snapshotFingerprint: await snapshotFingerprint(
        executor,
        row.id,
        row.overrideRevision,
        await boundaryIdentity(executor, row),
      ),
      recomputed: this.validation.recomputeCombined(row, await boundaryIdentity(executor, row)),
    });
  }

  private async rollbackGate(executor: Executor, row: DatasetRow): Promise<Refusal | null> {
    return rollbackRefusal({
      datasetVersionId: row.id,
      status: row.status,
      combinedDatasetVersion: row.combinedDatasetVersion,
      publishedAt: row.publishedAt,
      validation: (row.validationReport as PersistedValidation | null) ?? null,
      snapshotFingerprint: await snapshotFingerprint(
        executor,
        row.id,
        row.overrideRevision,
        await boundaryIdentity(executor, row),
      ),
    });
  }

  /**
   * Audits the refusal, then raises it.
   *
   * A refused publication is precisely the event worth finding later — someone
   * tried to make an unvalidated or drifted dataset live — so it is recorded
   * with its reason before the error leaves the process. Written outside any
   * transaction, because a refusal from inside one would be rolled back with it.
   */
  private async refusalError(
    action: string,
    row: DatasetRow,
    refusal: Refusal,
    actor: { id: string | null; type: 'admin' | 'system' },
    context: { idempotencyKey?: string | null },
  ): Promise<AppError> {
    await writeAudit(this.db, {
      actorType: actor.type,
      actorId: actor.id,
      action,
      resourceType: AUDIT_RESOURCE,
      resourceId: row.id,
      diff: {
        result: 'rejected',
        reason: refusal.code,
        message: refusal.message,
        combinedDatasetVersion: row.combinedDatasetVersion,
        combinedChecksum: row.combinedChecksum,
        status: row.status,
        idempotencyKey: context.idempotencyKey ?? null,
      },
    });
    return AppError.conflict(refusal.code, refusal.message);
  }

  private auditPayload(
    target: DatasetRow,
    previous: DatasetRow | null,
    validation: PersistedValidation,
    diff: DatasetDiff,
    stale: StaleMappings,
    context: { idempotencyKey?: string | null },
  ): Record<string, unknown> {
    return {
      result: 'published',
      combinedDatasetVersion: target.combinedDatasetVersion,
      combinedChecksum: target.combinedChecksum,
      sources: {
        currentSourceVersion: target.currentSourceVersion,
        historicalSourceVersion: target.historicalSourceVersion,
        mappingSourceCommit: target.mappingSourceCommit,
        boundarySourceVersion: target.boundarySourceVersion,
        overrideRevision: target.overrideRevision,
      },
      previousActiveVersion: previous?.combinedDatasetVersion ?? null,
      previousActiveVersionId: previous?.id ?? null,
      validation: {
        validationId: validation.validationId,
        validatorVersion: validation.validatorVersion,
        ranAt: validation.ranAt,
        errors: validation.errors,
        warnings: validation.warnings,
        warningGates: warningGates(validation),
      },
      diff: {
        countsByCategory: diff.countsByCategory,
        entriesTruncated: diff.entriesTruncated,
        affectedPlaces: diff.affectedPlaces.total,
      },
      staleMappings: stale.total,
      idempotencyKey: context.idempotencyKey ?? null,
    };
  }

  /**
   * Refills this process's pointer immediately after its own commit, so the
   * process that published does not serve the old version for up to a minute.
   * Every other process converges on the TTL. A failure here is reported and
   * ignored: the publication already happened.
   */
  private async refreshCache(): Promise<boolean> {
    this.cache.invalidateActiveVersion();
    try {
      await this.cache.active();
      return true;
    } catch {
      return false;
    }
  }

  private async lockTransition(tx: Tx): Promise<void> {
    await tx.execute(sql.raw(`set local lock_timeout = '${TRANSITION_LOCK_TIMEOUT}'`));
    await tx.execute(sql`select pg_advisory_xact_lock(${TRANSITION_LOCK})`);
  }

  private async requireRow(
    executor: Executor,
    datasetVersionId: string,
    forUpdate = false,
  ): Promise<DatasetRow> {
    const query = (executor as Db)
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, datasetVersionId))
      .limit(1);
    const [row] = await (forUpdate ? query.for('update') : query);
    if (!row) {
      throw AppError.notFound('DATASET_NOT_FOUND', `no administrative dataset ${datasetVersionId}`);
    }
    return row as DatasetRow;
  }

  private async activeRow(executor: Executor, forUpdate = false): Promise<DatasetRow | null> {
    const query = (executor as Db)
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    const [row] = await (forUpdate ? query.for('update') : query);
    return (row as DatasetRow | undefined) ?? null;
  }

  /** Versions a rollback could target: previously published, not active now. */
  async restorable(): Promise<DatasetSummary[]> {
    const rows = await this.db
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(
        and(
          isNotNull(schema.administrativeDatasetVersions.publishedAt),
          ne(schema.administrativeDatasetVersions.status, 'PUBLISHED'),
        ),
      )
      .orderBy(desc(schema.administrativeDatasetVersions.publishedAt));
    return (rows as DatasetRow[]).map(summarise);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

function warningGates(validation: PersistedValidation): string[] {
  return validation.findings.filter((f) => f.severity === 'WARNING').map((f) => f.gate);
}

function summarise(row: DatasetRow): DatasetSummary {
  const validation = (row.validationReport as PersistedValidation | null) ?? null;
  return {
    id: row.id,
    combinedDatasetVersion: row.combinedDatasetVersion,
    combinedChecksum: row.combinedChecksum,
    status: row.status,
    effectiveDate: row.effectiveDate,
    overrideRevision: row.overrideRevision,
    sources: {
      currentSourceVersion: row.currentSourceVersion,
      historicalSourceVersion: row.historicalSourceVersion,
      mappingSourceCommit: row.mappingSourceCommit,
      boundarySourceVersion: row.boundarySourceVersion,
    },
    importedAt: row.importedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    validation: validation
      ? {
          validationId: validation.validationId,
          validatorVersion: validation.validatorVersion,
          ranAt: validation.ranAt,
          errors: validation.errors,
          warnings: validation.warnings,
          publishable: validation.publishable,
          warningGates: warningGates(validation),
        }
      : null,
  };
}
