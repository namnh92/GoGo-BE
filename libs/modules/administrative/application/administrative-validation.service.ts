import { Inject, Injectable } from '@nestjs/common';
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
import type { ChangeRow } from '../domain/snapshot';
import {
  validateDataset,
  type ProvenancedUnit,
  type QuarantineSummary,
  type ValidationReport,
} from '../domain/validation';
import { PinnedSnapshotReader, SnapshotChecksumError } from './pinned-snapshot.reader';

/**
 * ADM-004 (#457) — runs the gates and the diff for one staged dataset, and
 * stores the results on its row.
 *
 * Publication is #458's work and is not here. What is here is the only thing
 * publication will be allowed to consult: `validation_report.publishable`,
 * which is true exactly when no ERROR gate fired.
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
    report: ValidationReport;
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
    let snapshotChecksumsVerified = true;
    let expected = {
      combinedDatasetVersion: staged.combinedDatasetVersion,
      combinedChecksum: staged.combinedChecksum,
    };
    try {
      const components = {
        currentSourceVersion: staged.currentSourceVersion,
        currentChecksum: this.reader.source('current-units').sha256,
        historicalSourceVersion: staged.historicalSourceVersion,
        historicalChecksum: staged.historicalSourceVersion
          ? this.reader.source('historical-units').sha256
          : null,
        mappingSourceCommit: staged.mappingSourceCommit,
        mappingChecksum: staged.mappingSourceCommit
          ? this.reader.source('change-mapping').sha256
          : null,
        boundarySourceVersion: staged.boundarySourceVersion,
        boundaryChecksum: null,
        overrideRevision: staged.overrideRevision,
      };
      // Reading verifies each checksum against the decompressed bytes.
      this.reader.read(this.reader.source('current-units'));
      expected = {
        combinedDatasetVersion: combinedDatasetVersion(components),
        combinedChecksum: combinedChecksum(components),
      };
    } catch (error) {
      if (error instanceof SnapshotChecksumError) snapshotChecksumsVerified = false;
      else throw error;
    }

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

    await this.db
      .update(schema.administrativeDatasetVersions)
      .set({
        validationReport: report,
        diffSummary: diff,
        status: report.publishable ? 'VALIDATED' : 'STAGED',
        updatedAt: new Date(),
      })
      .where(eq(schema.administrativeDatasetVersions.id, datasetVersionId));

    return { report, diff };
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

type DatasetRow = typeof schema.administrativeDatasetVersions.$inferSelect;

function emptyAffected(): AffectedPlaces {
  return { total: 0, samples: [], truncated: false, sampleLimit: AFFECTED_PLACE_SAMPLE_LIMIT };
}
