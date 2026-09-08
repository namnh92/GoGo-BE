import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { Executor } from '../application/unit-lookup';

/**
 * ADM-006 (#459) — the targeted reads the resolver needs, one place at a time.
 *
 * Deliberately not the in-process snapshot from ADM-003. That snapshot is built
 * for the *published* version and is the right structure for answering millions
 * of public reads; resolution has to work against a staged version too — that is
 * how a reviewer sees what a candidate dataset would do to the catalogue before
 * publishing it — and it runs a few indexed lookups per place rather than
 * scanning. Loading 14,000 units to classify one point would be the expensive
 * way to be less correct.
 */

export const ADMINISTRATIVE_RESOLVER_REPOSITORY = Symbol('ADMINISTRATIVE_RESOLVER_REPOSITORY');

export type UnitRecord = {
  code: string;
  name: string;
  fullName: string;
  parentCode: string | null;
  level: 'PROVINCE' | 'COMMUNE' | 'LEGACY_DISTRICT';
  status: 'ACTIVE' | 'INACTIVE' | 'FUTURE';
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type BoundaryMatch = {
  code: string;
  parentCode: string | null;
  level: 'PROVINCE' | 'COMMUNE';
  name: string;
  /**
   * The point lies on this polygon's own edge. Two neighbours sharing a border
   * both contain a point on it — that is geometry working correctly, not a data
   * defect, and it is reported separately from genuinely overlapping polygons
   * because the two have different fixes.
   */
  onEdge: boolean;
};

export type ChangeEdge = {
  oldCode: string;
  newCode: string;
  changeType: string;
  resolution: string;
};

@Injectable()
export class AdministrativeResolverRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * ADM-015 — every read takes an optional executor.
   *
   * Resolution now happens inside the transaction that creates or edits a
   * place, and a repository that always reached for the pool would be reading a
   * catalogue that does not yet contain the row it is being asked about.
   * Omitting it keeps the original behaviour for the unattended paths.
   */
  private on(executor: Executor | undefined): Db {
    return (executor ?? this.db) as Db;
  }

  /** A unit that is current in this dataset: active, with no end date. */
  async currentUnit(
    datasetVersionId: string,
    code: string,
    level: 'PROVINCE' | 'COMMUNE',
    executor?: Executor,
  ): Promise<UnitRecord | null> {
    const [row] = await this.on(executor)
      .select(UNIT_COLUMNS)
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, datasetVersionId),
          eq(schema.administrativeUnits.code, code),
          eq(schema.administrativeUnits.level, level),
          eq(schema.administrativeUnits.status, 'ACTIVE'),
          isNull(schema.administrativeUnits.effectiveTo),
        ),
      )
      .limit(1);
    return (row as UnitRecord | undefined) ?? null;
  }

  /**
   * Every period a code has had, current and historical.
   *
   * The plural is the point: `00004` is Phường Trúc Bạch until 2025-06-30 and
   * Phường Ba Đình after it, and a caller that asked for "unit 00004" without
   * saying when has asked an ambiguous question.
   */
  async unitPeriods(
    datasetVersionId: string,
    code: string,
    executor?: Executor,
  ): Promise<UnitRecord[]> {
    const rows = await this.on(executor)
      .select(UNIT_COLUMNS)
      .from(schema.administrativeUnits)
      .where(
        and(
          eq(schema.administrativeUnits.datasetVersionId, datasetVersionId),
          eq(schema.administrativeUnits.code, code),
        ),
      )
      .orderBy(schema.administrativeUnits.effectiveFrom);
    return rows as UnitRecord[];
  }

  /**
   * Units whose normalized name matches exactly.
   *
   * Exactly, not fuzzily: `normalizeVietnamese` already folds accents and case,
   * so "Phường Bà Đình" and "ba dinh" meet here, and anything looser is a
   * suggestion for a person rather than an answer.
   */
  async unitsByNormalizedName(
    datasetVersionId: string,
    normalized: string,
    options: {
      level: 'PROVINCE' | 'COMMUNE' | 'LEGACY_DISTRICT';
      /**
       * `current` is active with no end date; `historical` is everything that
       * ended. They are asked separately because the same name means different
       * units on either side of 2025-07-01, and a query that returned both
       * would hand the resolver two answers and call it ambiguity.
       */
      period: 'current' | 'historical' | 'any';
      parentCode?: string | null;
    },
    executor?: Executor,
  ): Promise<UnitRecord[]> {
    const conditions = [
      eq(schema.administrativeUnits.datasetVersionId, datasetVersionId),
      eq(schema.administrativeUnits.level, options.level),
      sql`(${schema.administrativeUnits.nameNormalized} = ${normalized}
           or ${schema.administrativeUnits.fullNameNormalized} = ${normalized})`,
    ];
    if (options.period === 'current') {
      conditions.push(eq(schema.administrativeUnits.status, 'ACTIVE'));
      conditions.push(isNull(schema.administrativeUnits.effectiveTo));
    }
    if (options.period === 'historical') {
      conditions.push(sql`${schema.administrativeUnits.effectiveTo} is not null`);
    }
    if (options.parentCode) {
      conditions.push(eq(schema.administrativeUnits.parentCode, options.parentCode));
    }
    const rows = await this.on(executor)
      .select(UNIT_COLUMNS)
      .from(schema.administrativeUnits)
      .where(and(...conditions))
      .orderBy(schema.administrativeUnits.code, schema.administrativeUnits.effectiveFrom);
    return rows as UnitRecord[];
  }

  /** Canonical successors of a historical code. Quarantined rows are not here. */
  async successorsOf(
    datasetVersionId: string,
    oldCode: string,
    executor?: Executor,
  ): Promise<ChangeEdge[]> {
    const rows = await this.on(executor)
      .select({
        oldCode: schema.administrativeUnitChanges.oldCode,
        newCode: schema.administrativeUnitChanges.newCode,
        changeType: schema.administrativeUnitChanges.changeType,
        resolution: schema.administrativeUnitChanges.resolution,
      })
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, datasetVersionId),
          eq(schema.administrativeUnitChanges.oldCode, oldCode),
          eq(schema.administrativeUnitChanges.resolution, 'resolved'),
        ),
      )
      .orderBy(schema.administrativeUnitChanges.newCode);
    return rows as ChangeEdge[];
  }

  /**
   * Whether this historical code sits in quarantine — overwhelmingly because it
   * was divided, which is the case ADR-0019 forbids anyone from guessing.
   */
  async quarantinedCount(
    datasetVersionId: string,
    oldCode: string,
    executor?: Executor,
  ): Promise<number> {
    const [row] = await this.on(executor)
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeMappingQuarantine)
      .where(
        and(
          eq(schema.administrativeMappingQuarantine.datasetVersionId, datasetVersionId),
          eq(schema.administrativeMappingQuarantine.oldCode, oldCode),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Point-in-polygon against one pinned boundary release.
   *
   * `ST_Intersects`, not `ST_Contains`: a point exactly on a shared border is
   * inside Vietnam and inside two communes, and reporting that as ambiguous is
   * correct where reporting it as "no match" would be a lie about the geometry.
   * The GiST index on `geom` serves the `&&` that `ST_Intersects` expands to.
   *
   * The comparison is SRID 4326 on both sides — `places.geom` and the boundary
   * column are declared in the same frame — so nothing here reprojects, and a
   * mismatched SRID is a type error at insert rather than a silent offset.
   */
  async containing(
    boundaryVersion: string,
    point: { lng: number; lat: number },
    executor?: Executor,
  ): Promise<BoundaryMatch[]> {
    const result = await this.on(executor).execute(sql`
      select b.code, b.parent_code, b.level, b.name,
             st_intersects(st_boundary(b.geom), st_setsrid(st_makepoint(${point.lng}, ${point.lat}), 4326)) as on_edge
      from administrative_unit_boundaries b
      where b.boundary_version = ${boundaryVersion}
        and st_intersects(b.geom, st_setsrid(st_makepoint(${point.lng}, ${point.lat}), 4326))
      order by b.level, b.code
    `);
    const rows = (result as unknown as { rows: BoundaryRow[] }).rows;
    return rows.map((r) => ({
      code: r.code,
      parentCode: r.parent_code,
      level: r.level,
      name: r.name,
      onEdge: r.on_edge === true,
    }));
  }
}

type BoundaryRow = {
  code: string;
  parent_code: string | null;
  level: 'PROVINCE' | 'COMMUNE';
  name: string;
  on_edge: boolean;
};

const UNIT_COLUMNS = {
  code: schema.administrativeUnits.code,
  name: schema.administrativeUnits.name,
  fullName: schema.administrativeUnits.fullName,
  parentCode: schema.administrativeUnits.parentCode,
  level: schema.administrativeUnits.level,
  status: schema.administrativeUnits.status,
  effectiveFrom: schema.administrativeUnits.effectiveFrom,
  effectiveTo: schema.administrativeUnits.effectiveTo,
};
