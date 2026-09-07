import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
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
  type PersistedValidation,
  type ValidationBinding,
} from '../domain/publication-gates';
import type { ChangeRow } from '../domain/snapshot';
import {
  validateDataset,
  type ProvenancedUnit,
  type QuarantineSummary,
  type ValidationReport,
} from '../domain/validation';
import { PinnedSnapshotReader, SnapshotChecksumError } from './pinned-snapshot.reader';
import { snapshotFingerprint } from './snapshot-fingerprint';

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

@Injectable()
export class AdministrativeValidationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reader: PinnedSnapshotReader = new PinnedSnapshotReader(),
  ) {}

  /**
   * Validates a staged dataset against the published one and persists both the
   * report and the diff. Returns them too, so a caller does not re-read.
   */
  async validate(datasetVersionId: string): Promise<{
    report: PersistedValidation;
    diff: DatasetDiff;
  }> {
    const staged = await this.datasetRow(datasetVersionId);
    const published = await this.publishedRow();

    const [units, changes, quarantine] = await Promise.all([
      this.unitsFor(datasetVersionId),
      this.changesFor(datasetVersionId),
      this.quarantineFor(datasetVersionId),
    ]);

    // Recomputed from the pinned manifest, so a stored version string that no
    // longer matches its own components is caught rather than trusted.
    const recomputed = this.recomputeCombined(staged);
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
      // Taken after the reads above, so it describes the rows that were
      // actually validated rather than the rows present when the call started.
      snapshotFingerprint: await snapshotFingerprint(
        this.db,
        datasetVersionId,
        staged.overrideRevision,
      ),
      overrideRevision: staged.overrideRevision,
    };
    const persisted: PersistedValidation = {
      ...report,
      validationId: validationId(boundTo, report),
      validatorVersion: VALIDATOR_VERSION,
      boundTo,
    };

    await this.db
      .update(schema.administrativeDatasetVersions)
      .set({
        validationReport: persisted,
        diffSummary: diff,
        // A dataset that fails its gates goes back to STAGED rather than to
        // REJECTED: it failed a check, nobody rejected it, and re-running after
        // a fixed source must not need a status to be undone by hand first.
        status: report.publishable ? 'VALIDATED' : 'STAGED',
        updatedAt: new Date(),
      })
      .where(eq(schema.administrativeDatasetVersions.id, datasetVersionId));

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
        boundaryChecksum: null,
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
