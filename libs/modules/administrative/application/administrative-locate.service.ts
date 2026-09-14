import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import type { DatasetSnapshot, UnitRow } from '../domain/snapshot';
import { AdministrativeResolverRepository } from '../infrastructure/administrative-resolver.repository';

export type LocatedArea = {
  scope: 'commune' | 'province' | 'unknown';
  provinceCode: string | null;
  provinceName: string | null;
  communeCode: string | null;
  communeName: string | null;
};

const UNKNOWN: LocatedArea = {
  scope: 'unknown',
  provinceCode: null,
  provinceName: null,
  communeCode: null,
  communeName: null,
};

/**
 * ADM-022 (#569) — which current commune or province contains a position, so a
 * client can put "where I am" first without inventing a mapping of its own.
 *
 * Point-in-polygon against the boundary release bound to the published dataset,
 * with the same refusals as the resolver: a point claimed by two communes is
 * not given to either, and a polygon whose province disagrees with the unit
 * release is not trusted. The position is used for this one query and stored
 * nowhere.
 */
@Injectable()
export class AdministrativeLocateService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly boundaries: AdministrativeResolverRepository,
  ) {}

  async locate(
    snapshot: DatasetSnapshot,
    point: { lat: number; lng: number },
  ): Promise<LocatedArea> {
    const [dataset] = await this.db
      .select({ boundaryVersion: schema.administrativeDatasetVersions.boundarySourceVersion })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, snapshot.datasetVersionId))
      .limit(1);
    if (!dataset?.boundaryVersion) return UNKNOWN;

    const matches = await this.boundaries.containing(dataset.boundaryVersion, point);
    const current = (code: string | null, level: 'PROVINCE' | 'COMMUNE'): UnitRow | null =>
      code
        ? ((snapshot.byCode.get(code) ?? []).find(
            (unit) => unit.level === level && unit.status === 'ACTIVE' && unit.effectiveTo === null,
          ) ?? null)
        : null;

    const communes = matches.filter((m) => m.level === 'COMMUNE');
    if (communes.length === 1) {
      const commune = current(communes[0]!.code, 'COMMUNE');
      const province = current(commune?.parentCode ?? null, 'PROVINCE');
      if (commune && province && commune.parentCode === communes[0]!.parentCode) {
        return {
          scope: 'commune',
          provinceCode: province.code,
          provinceName: province.fullName,
          communeCode: commune.code,
          communeName: commune.fullName,
        };
      }
    }

    const provinceCodes = new Set<string>([
      ...communes.flatMap((m) => (m.parentCode ? [m.parentCode] : [])),
      ...matches.filter((m) => m.level === 'PROVINCE').map((m) => m.code),
    ]);
    if (provinceCodes.size === 1) {
      const province = current([...provinceCodes][0]!, 'PROVINCE');
      if (province) {
        return {
          ...UNKNOWN,
          scope: 'province',
          provinceCode: province.code,
          provinceName: province.fullName,
        };
      }
    }
    return UNKNOWN;
  }
}
