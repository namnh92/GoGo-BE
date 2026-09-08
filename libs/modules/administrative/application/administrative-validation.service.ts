import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { DB } from '../../shared/tokens';
import { AppError } from '../../shared/app-error';
import { combinedChecksum, combinedDatasetVersion } from '../domain/combined-version';
import {
  diffDatasets,
  impactedCodes,
  type AffectedPlaces,
  type DatasetDiff,
} from '../domain/dataset-diff';
import {
  VALIDATOR_VERSION,
  validateRefusal,
  validationDrift,
  type PersistedValidation,
  type Refusal,
  type ValidationBinding,
  type ValidationIdentity,
} from '../domain/publication-gates';
import type { ChangeRow } from '../domain/snapshot';
import {
  validateDataset,
  type ProvenancedUnit,
  type QuarantineSummary,
  type ValidationReport,
} from '../domain/validation';
import { writeAudit } from '../../shared/audit';
import { AUDIT_ACTION, AUDIT_RESOURCE } from './administrative-audit';
import { TRANSITION_LOCK, TRANSITION_LOCK_TIMEOUT } from './administrative-transition';
import { PinnedSnapshotReader, SnapshotChecksumError } from './pinned-snapshot.reader';
import { boundaryIdentity, snapshotFingerprint } from './snapshot-fingerprint';

/**
 * ADM-004 (#457) — runs the gates and the diff for one staged dataset, and
 * stores the results on its row.
 *
 * What is stored is the only thing publication is allowed to consult:
 * `validation_report.publishable`, true exactly when no ERROR gate fired.
 *
 * ADM-005 (#458) added the binding around it. A report that says "publishable"
 * is evidence about a particular set of rows carrying a particular checksum,
 * validated by a particular set of gates — so it is stored with all three, and
 * publication re-derives them and refuses on any disagreement. Without that, a
 * dataset validated before an override bump, or before someone edited a staged
 * row, would still read as publishable.
 *
 * The service reads; it never writes a unit, a change, or a place. Re-running
 * it on the same dataset produces the same report and the same diff, so a
 * reviewer refreshing a screen never sees the answer move under them.
 */

export const AFFECTED_PLACE_SAMPLE_LIMIT = 20;

/** Codes are chunked into the impact query; Postgres has a parameter ceiling. */
const CODE_CHUNK = 900;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class AdministrativeValidationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reader: PinnedSnapshotReader = new PinnedSnapshotReader(),
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * Validates a staged dataset against the published one and persists both the
   * report and the diff. Returns them too, so a caller does not re-read.
   *
   * #482 — validation writes a lifecycle status, so it is a transition and is
   * gated like one. Two refusals guard the write, and neither of them modifies
   * anything:
   *
   * - **before the work**, a version that is not STAGED or VALIDATED is
   *   refused outright. Running the gates against the active dataset and then
   *   storing `publishable ? VALIDATED : STAGED` would demote it out of
   *   PUBLISHED, leaving the environment with no active version — the partial
   *   unique index forbids two, not none — and every place approval would then
   *   start refusing;
   * - **under the transition lock**, the row is re-read `FOR UPDATE` and its
   *   identity is compared with the identity the report was computed from. A
   *   publication, an override bump or a direct edit to a staged row during the
   *   run makes the report evidence about rows that are no longer there, so it
   *   is discarded rather than stored.
   *
   * A refused run leaves the status, the previous validation, the active
   * pointer, the restorable set, the places and the cache exactly as they were.
   * The only thing it writes is the audit row for the refusal, which is what
   * the publication path already does with a refused publish.
   */
  async validate(
    datasetVersionId: string,
    actor: { id: string | null; type: 'admin' | 'system' } = { id: null, type: 'system' },
    context: { idempotencyKey?: string | null } = {},
  ): Promise<{
    report: PersistedValidation;
    diff: DatasetDiff;
  }> {
    const startedAt = Date.now();
    const staged = await this.datasetRow(datasetVersionId);

    const stateRefusal = validateRefusal(staged);
    if (stateRefusal) {
      this.record('rejected', startedAt);
      throw await this.refusalError(staged, stateRefusal, actor, context);
    }

    /*
     * Taken before the reads rather than after them, so the comparison under
     * lock covers the whole run: if a staged row moves at any point between
     * here and the write, the two digests disagree and nothing is stored. The
     * value that ends up in `boundTo` is the same either way — it is only
     * written when the two are equal.
     */
    const fingerprintBefore = await snapshotFingerprint(
      this.db,
      datasetVersionId,
      staged.overrideRevision,
      await boundaryIdentity(this.db, staged),
    );
    const published = await this.publishedRow();

    const [units, changes, quarantine] = await Promise.all([
      this.unitsFor(datasetVersionId),
      this.changesFor(datasetVersionId),
      this.quarantineFor(datasetVersionId),
    ]);

    // Recomputed from the pinned manifest, so a stored version string that no
    // longer matches its own components is caught rather than trusted.
    const recomputed = this.recomputeCombined(staged, await boundaryIdentity(this.db, staged));
    const snapshotChecksumsVerified = recomputed !== null;
    const expected = recomputed ?? {
      combinedDatasetVersion: staged.combinedDatasetVersion,
      combinedChecksum: staged.combinedChecksum,
    };

    const publishedCount = await this.publishedVersionCount();
    const [baselineUnits, baselineChanges, baselineQuarantine] = published
      ? await Promise.all([
          this.unitsFor(published.id),
          this.changesFor(published.id),
          this.quarantineFor(published.id),
        ])
      : [[], [], []];

    const report = validateDataset({
      datasetVersion: staged.combinedDatasetVersion,
      units,
      changes,
      quarantine,
      expected,
      stored: {
        combinedDatasetVersion: staged.combinedDatasetVersion,
        combinedChecksum: staged.combinedChecksum,
      },
      snapshotChecksumsVerified,
      publishedVersionCount: publishedCount,
      overrideRevision: staged.overrideRevision,
      baseline: published
        ? { datasetVersion: published.combinedDatasetVersion, units: baselineUnits }
        : undefined,
    });

    const firedGates = report.findings.map((f) => f.gate);
    // Built once with no place impact so the impacted codes can be derived,
    // then rebuilt with the real counts. Cheaper than walking entries twice in
    // two shapes, and keeps `diffDatasets` a pure function of its input.
    const shape = diffDatasets({
      fromVersion: published?.combinedDatasetVersion ?? null,
      toVersion: staged.combinedDatasetVersion,
      fromUnits: baselineUnits,
      toUnits: units,
      toChanges: changes,
      toQuarantine: quarantine,
      fromChanges: baselineChanges,
      fromQuarantine: baselineQuarantine,
      fromSources: published ? this.sourcesOf(published) : null,
      toSources: this.sourcesOf(staged),
      affectedPlaces: emptyAffected(),
      firedGates,
    });

    const affectedPlaces = await this.affectedPlaces(impactedCodes(shape.entries));
    const diff = { ...shape, affectedPlaces };

    const boundTo: ValidationBinding = {
      datasetVersionId,
      combinedDatasetVersion: staged.combinedDatasetVersion,
      combinedChecksum: staged.combinedChecksum,
      // Proved unchanged across the whole run by the comparison under lock
      // below, so it describes the rows that were actually validated.
      snapshotFingerprint: fingerprintBefore,
      overrideRevision: staged.overrideRevision,
    };
    const persisted: PersistedValidation = {
      ...report,
      validationId: validationId(boundTo, report),
      validatorVersion: VALIDATOR_VERSION,
      boundTo,
    };

    const identityBefore: ValidationIdentity = {
      status: staged.status as ValidationIdentity['status'],
      combinedDatasetVersion: staged.combinedDatasetVersion,
      combinedChecksum: staged.combinedChecksum,
      overrideRevision: staged.overrideRevision,
      snapshotFingerprint: fingerprintBefore,
    };

    const outcome = await this.db.transaction(async (tx) => {
      await this.lockTransition(tx);
      const locked = await this.lockedRow(tx, datasetVersionId);

      // Re-run verbatim: a publication may have won the lock while the gates
      // were running, and the cheap answer is still the useful one.
      const refusal = validateRefusal(locked);
      if (refusal) return { refusal } as const;

      const drift = validationDrift(identityBefore, {
        status: locked.status as ValidationIdentity['status'],
        combinedDatasetVersion: locked.combinedDatasetVersion,
        combinedChecksum: locked.combinedChecksum,
        overrideRevision: locked.overrideRevision,
        snapshotFingerprint: await snapshotFingerprint(
          tx,
          datasetVersionId,
          locked.overrideRevision,
          await boundaryIdentity(tx, locked),
        ),
      });
      if (drift) return { refusal: drift } as const;

      await tx
        .update(schema.administrativeDatasetVersions)
        .set({
          validationReport: persisted,
          diffSummary: diff,
          // A dataset that fails its gates goes back to STAGED rather than to
          // REJECTED: it failed a check, nobody rejected it, and re-running
          // after a fixed source must not need a status to be undone by hand
          // first.
          status: report.publishable ? 'VALIDATED' : 'STAGED',
          updatedAt: new Date(),
        })
        .where(eq(schema.administrativeDatasetVersions.id, datasetVersionId));
      return { written: true } as const;
    });

    if ('refusal' in outcome) {
      this.record('rejected', startedAt);
      throw await this.refusalError(staged, outcome.refusal, actor, context);
    }

    // One series per gate per severity, from a closed vocabulary of twenty
    // gates. The gate name is what an operator alerts on; the dataset it fired
    // against is in the stored report, not in a label.
    for (const finding of report.findings) {
      this.metrics.increment('administrative_validation_findings_total', {
        gate: finding.gate,
        severity: finding.severity,
      });
    }
    // `rejected` here means the gates found ERRORs, not that the write was
    // refused; both are non-events for the active dataset, and the audit row
    // is what tells them apart.
    this.record(report.publishable ? 'succeeded' : 'rejected', startedAt);

    return { report: persisted, diff };
  }

  /**
   * The combined identity these pinned sources produce **now**, or null when a
   * pinned file is missing or its bytes no longer match the manifest.
   *
   * Null is a fact, not an error: it is what `SNAPSHOT_CHECKSUM` reports as a
   * validation failure and what publication refuses on. Reading the snapshot is
   * what verifies it — the reader checks each checksum before returning bytes.
   */
  recomputeCombined(
    row: DatasetRow,
    boundary: { version: string; checksum: string } | null = null,
  ): { combinedDatasetVersion: string; combinedChecksum: string } | null {
    try {
      const components = {
        currentSourceVersion: row.currentSourceVersion,
        currentChecksum: this.reader.source('current-units').sha256,
        historicalSourceVersion: row.historicalSourceVersion,
        historicalChecksum: row.historicalSourceVersion
          ? this.reader.source('historical-units').sha256
          : null,
        mappingSourceCommit: row.mappingSourceCommit,
        mappingChecksum: row.mappingSourceCommit
          ? this.reader.source('change-mapping').sha256
          : null,
        boundarySourceVersion: row.boundarySourceVersion,
        // #489 — from the manifest pin, exactly as the other three components
        // are. It was hardcoded null, which was harmless only while import also
        // wrote null: the moment a dataset carries a boundary the two
        // disagreed, and every publish of a boundary-bound dataset would have
        // been refused SNAPSHOT_CHECKSUM_MISMATCH against a checksum this
        // function computed wrong. Null stays null for the pre-#489 dataset.
        boundaryChecksum: boundary?.checksum ?? null,
        overrideRevision: row.overrideRevision,
      };
      this.reader.read(this.reader.source('current-units'));
      return {
        combinedDatasetVersion: combinedDatasetVersion(components),
        combinedChecksum: combinedChecksum(components),
      };
    } catch (error) {
      if (error instanceof SnapshotChecksumError) return null;
      throw error;
    }
  }

  /**
   * The diff of one dataset against whatever is published right now, computed
   * fresh and written nowhere.
   *
   * It is recomputed rather than read back from `diff_summary` because the
   * stored copy describes the baseline that was active when the dataset was
   * validated. A reviewer opening the screen after someone else published is
   * asking about today's baseline, and answering from the stored copy would
   * quietly show them yesterday's.
   */
  async diffAgainstPublished(
    datasetVersionId: string,
    options: { entryLimit?: number } = {},
  ): Promise<DatasetDiff> {
    const target = await this.datasetRow(datasetVersionId);
    const published = await this.publishedRow();
    const baseline = published && published.id !== datasetVersionId ? published : null;
    return this.buildDiff(target, baseline, options.entryLimit);
  }

  /**
   * The diff between two named versions. Used by publication and rollback,
   * which must show what the switch would do before doing it.
   */
  async diffBetween(
    from: DatasetRow | null,
    to: DatasetRow,
    options: { entryLimit?: number } = {},
  ): Promise<DatasetDiff> {
    return this.buildDiff(to, from, options.entryLimit);
  }

  private async buildDiff(
    target: DatasetRow,
    baseline: DatasetRow | null,
    entryLimit?: number,
  ): Promise<DatasetDiff> {
    const [units, changes, quarantine] = await Promise.all([
      this.unitsFor(target.id),
      this.changesFor(target.id),
      this.quarantineFor(target.id),
    ]);
    const [baselineUnits, baselineChanges, baselineQuarantine] = baseline
      ? await Promise.all([
          this.unitsFor(baseline.id),
          this.changesFor(baseline.id),
          this.quarantineFor(baseline.id),
        ])
      : [[], [], []];

    // Gates are cited only when a stored report describes these very rows;
    // otherwise the linkage would attribute someone else's findings to them.
    const stored = target.validationReport as PersistedValidation | null;
    const firedGates = stored?.findings?.map((f) => f.gate) ?? [];

    const shape = diffDatasets({
      fromVersion: baseline?.combinedDatasetVersion ?? null,
      toVersion: target.combinedDatasetVersion,
      fromUnits: baselineUnits,
      toUnits: units,
      toChanges: changes,
      toQuarantine: quarantine,
      fromChanges: baselineChanges,
      fromQuarantine: baselineQuarantine,
      fromSources: baseline ? this.sourcesOf(baseline) : null,
      toSources: this.sourcesOf(target),
      affectedPlaces: emptyAffected(),
      firedGates,
      ...(entryLimit === undefined ? {} : { entryLimit }),
    });
    const affectedPlaces = await this.affectedPlaces(impactedCodes(shape.entries));
    return { ...shape, affectedPlaces };
  }

  /**
   * Places that would be touched, counted in the database.
   *
   * Two things this deliberately does not do. It does not load the place
   * catalogue — the count is an aggregate and the samples are a `LIMIT`, so the
   * work is bounded however large the catalogue grows. And it does not count
   * `UNMAPPED` rows: a place with no administrative claim is not affected by a
   * change to administrative data, and counting it would inflate every impact
   * figure a reviewer sees by the size of the un-enriched catalogue.
   */
  async affectedPlaces(codes: readonly string[]): Promise<AffectedPlaces> {
    if (codes.length === 0) return emptyAffected();

    const mapped = ne(schema.places.administrativeMappingStatus, 'UNMAPPED');
    let total = 0;
    for (let i = 0; i < codes.length; i += CODE_CHUNK) {
      const chunk = [...codes.slice(i, i + CODE_CHUNK)];
      const [row] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.places)
        .where(
          and(
            mapped,
            sql`(${schema.places.communeCode} in ${chunk} or ${schema.places.provinceCode} in ${chunk})`,
          ),
        );
      total += row?.n ?? 0;
    }

    // Ordered by code then id so the sample window is the same on every run.
    const firstChunk = [...codes.slice(0, CODE_CHUNK)];
    const samples = await this.db
      .select({
        placeId: schema.places.id,
        name: schema.places.name,
        code: schema.places.communeCode,
        status: schema.places.administrativeMappingStatus,
      })
      .from(schema.places)
      .where(and(mapped, inArray(schema.places.communeCode, firstChunk)))
      .orderBy(schema.places.communeCode, schema.places.id)
      .limit(AFFECTED_PLACE_SAMPLE_LIMIT);

    return {
      total,
      samples: samples.map((s) => ({
        placeId: s.placeId,
        name: s.name,
        code: s.code ?? '',
        status: s.status,
      })),
      truncated: total > samples.length,
      sampleLimit: AFFECTED_PLACE_SAMPLE_LIMIT,
    };
  }

  private sourcesOf(row: DatasetRow): Record<string, string | null> {
    return {
      currentSourceVersion: row.currentSourceVersion,
      historicalSourceVersion: row.historicalSourceVersion,
      mappingSourceCommit: row.mappingSourceCommit,
      boundarySourceVersion: row.boundarySourceVersion,
      overrideRevision: String(row.overrideRevision),
    };
  }

  /**
   * One counter per outcome, with the same bounded labels the publication path
   * uses. A refused run is `rejected`, exactly as a refused publication is —
   * the reason lives in the audit row, never in a label.
   */
  private record(result: 'succeeded' | 'rejected', startedAt: number): void {
    this.metrics.increment('administrative_dataset_operations_total', {
      operation: 'validate',
      result,
    });
    this.metrics.observe(
      'administrative_dataset_operation_duration_seconds',
      (Date.now() - startedAt) / 1000,
      { operation: 'validate' },
    );
  }

  private async lockTransition(tx: Tx): Promise<void> {
    await tx.execute(sql.raw(`set local lock_timeout = '${TRANSITION_LOCK_TIMEOUT}'`));
    await tx.execute(sql`select pg_advisory_xact_lock(${TRANSITION_LOCK})`);
  }

  private async lockedRow(tx: Tx, id: string): Promise<DatasetRow> {
    const [row] = await tx
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, id))
      .limit(1)
      .for('update');
    if (!row) throw AppError.notFound('DATASET_NOT_FOUND', `no administrative dataset ${id}`);
    return row as DatasetRow;
  }

  /**
   * Records the refused attempt and returns the 409 to throw.
   *
   * Written with the `validate_rejected` action, never with `validate`: an
   * audit row that implied a validation had run would be worse than none, since
   * the whole point of the trail is that a reviewer can tell what the stored
   * report is evidence about.
   */
  private async refusalError(
    row: DatasetRow,
    refusal: Refusal,
    actor: { id: string | null; type: 'admin' | 'system' },
    context: { idempotencyKey?: string | null },
  ): Promise<AppError> {
    await writeAudit(this.db, {
      actorType: actor.type,
      actorId: actor.id,
      action: AUDIT_ACTION.validateRejected,
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

  private async datasetRow(id: string): Promise<DatasetRow> {
    const [row] = await this.db
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, id))
      .limit(1);
    if (!row) throw AppError.notFound('DATASET_NOT_FOUND', `no administrative dataset ${id}`);
    return row as DatasetRow;
  }

  private async publishedRow(): Promise<DatasetRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    return (row as DatasetRow | undefined) ?? null;
  }

  private async publishedVersionCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'));
    return row?.n ?? 0;
  }

  private async unitsFor(datasetVersionId: string): Promise<ProvenancedUnit[]> {
    const rows = await this.db
      .select({
        code: schema.administrativeUnits.code,
        name: schema.administrativeUnits.name,
        fullName: schema.administrativeUnits.fullName,
        nameEn: schema.administrativeUnits.nameEn,
        nameNormalized: schema.administrativeUnits.nameNormalized,
        fullNameNormalized: schema.administrativeUnits.fullNameNormalized,
        codeName: schema.administrativeUnits.codeName,
        unitType: schema.administrativeUnits.unitType,
        level: schema.administrativeUnits.level,
        parentCode: schema.administrativeUnits.parentCode,
        status: schema.administrativeUnits.status,
        effectiveFrom: schema.administrativeUnits.effectiveFrom,
        effectiveTo: schema.administrativeUnits.effectiveTo,
        source: schema.administrativeUnits.source,
        sourceVersion: schema.administrativeUnits.sourceVersion,
      })
      .from(schema.administrativeUnits)
      .where(eq(schema.administrativeUnits.datasetVersionId, datasetVersionId))
      .orderBy(schema.administrativeUnits.code, schema.administrativeUnits.effectiveFrom);
    return rows as ProvenancedUnit[];
  }

  private async changesFor(datasetVersionId: string): Promise<ChangeRow[]> {
    const rows = await this.db
      .select({
        oldCode: schema.administrativeUnitChanges.oldCode,
        newCode: schema.administrativeUnitChanges.newCode,
        changeType: schema.administrativeUnitChanges.changeType,
        effectiveDate: schema.administrativeUnitChanges.effectiveDate,
        legalReference: schema.administrativeUnitChanges.legalReference,
        overrideDecisionId: schema.administrativeUnitChanges.overrideDecisionId,
      })
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, datasetVersionId),
          eq(schema.administrativeUnitChanges.resolution, 'resolved'),
        ),
      )
      .orderBy(schema.administrativeUnitChanges.oldCode, schema.administrativeUnitChanges.newCode);
    return rows as ChangeRow[];
  }

  private async quarantineFor(datasetVersionId: string): Promise<QuarantineSummary[]> {
    const rows = await this.db
      .select({
        classification: schema.administrativeMappingQuarantine.classification,
        oldCode: schema.administrativeMappingQuarantine.oldCode,
        newCode: schema.administrativeMappingQuarantine.newCode,
      })
      .from(schema.administrativeMappingQuarantine)
      .where(eq(schema.administrativeMappingQuarantine.datasetVersionId, datasetVersionId))
      .orderBy(
        schema.administrativeMappingQuarantine.oldCode,
        schema.administrativeMappingQuarantine.newCode,
      );
    return rows as QuarantineSummary[];
  }
}

export type DatasetRow = typeof schema.administrativeDatasetVersions.$inferSelect;

/**
 * Deterministic in its inputs: re-validating unchanged rows with unchanged
 * gates produces the same id, and any change to what was checked or what was
 * found produces a different one. That is what lets an audit row name the exact
 * validation a publication relied on.
 */
function validationId(boundTo: ValidationBinding, report: ValidationReport): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        boundTo,
        VALIDATOR_VERSION,
        report.publishable,
        report.errors,
        report.warnings,
        report.findings.map((f) => [f.gate, f.severity, f.count]),
        report.counts,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

function emptyAffected(): AffectedPlaces {
  return { total: 0, samples: [], truncated: false, sampleLimit: AFFECTED_PLACE_SAMPLE_LIMIT };
}
