import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { ChangeRow, UnitRow } from '../domain/snapshot';

/**
 * ADM-003 (#456) — the only place that reads administrative rows from Postgres.
 *
 * Three queries in the process's whole life per published version: the active
 * pointer (re-asked on a TTL), the units, and the canonical changes. Requests
 * read the built snapshot, never this. A repository method called per request
 * would be the bug this design exists to avoid.
 */

export const ADMINISTRATIVE_REPOSITORY = Symbol('ADMINISTRATIVE_REPOSITORY');

export type ActiveVersion = {
  id: string;
  combinedDatasetVersion: string;
  effectiveDate: string;
  publishedAt: string | null;
};

@Injectable()
export class DrizzleAdministrativeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * PostgreSQL is authoritative for which version is active. A partial unique
   * index guarantees at most one `PUBLISHED` row, so this cannot be ambiguous —
   * `limit(1)` is belt to that index's braces, not a tie-break.
   */
  async activeVersion(): Promise<ActiveVersion | null> {
    const [row] = await this.db
      .select({
        id: schema.administrativeDatasetVersions.id,
        combinedDatasetVersion: schema.administrativeDatasetVersions.combinedDatasetVersion,
        effectiveDate: schema.administrativeDatasetVersions.effectiveDate,
        publishedAt: schema.administrativeDatasetVersions.publishedAt,
      })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      combinedDatasetVersion: row.combinedDatasetVersion,
      effectiveDate: row.effectiveDate,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  }

  async unitsFor(datasetVersionId: string): Promise<UnitRow[]> {
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
      })
      .from(schema.administrativeUnits)
      .where(eq(schema.administrativeUnits.datasetVersionId, datasetVersionId))
      .orderBy(asc(schema.administrativeUnits.code), asc(schema.administrativeUnits.effectiveFrom));
    return rows as UnitRow[];
  }

  /**
   * Canonical changes only. Quarantined rows live in their own table and are
   * not changes — a divided commune's "default" successor is the guess
   * ADR-0019 forbids, and `resolve` must never present one as a migration.
   */
  async canonicalChangesFor(datasetVersionId: string): Promise<ChangeRow[]> {
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
      .orderBy(
        asc(schema.administrativeUnitChanges.oldCode),
        asc(schema.administrativeUnitChanges.newCode),
      );
    return rows as ChangeRow[];
  }
}

export type AdministrativeRepository = Pick<
  DrizzleAdministrativeRepository,
  'activeVersion' | 'unitsFor' | 'canonicalChangesFor'
>;
