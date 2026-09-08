import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { approvalBlock, type ApprovalBlock } from '../domain/approval-policy';
import type { MappingMethod, MappingStatus } from '../domain/mapping-status';
import { activeDataset, type Executor } from './unit-lookup';

/**
 * ADM-016 — the administrative identity of one place, for the console's place
 * detail screen.
 *
 * The moderation endpoint already answers a richer version of this question,
 * and widening it to editors was the obvious move and the wrong one: it
 * recomputes the resolver on every read — a point-in-polygon query, an evidence
 * sweep and a staleness evaluation — because a reviewer needs to see what the
 * machine says *now*. An editor opening a place to fix its phone number does
 * not, and buying that work on every detail read would make the most-opened
 * screen in the console the most expensive one.
 *
 * So this reads what is **stored**: the codes on the row, their names in the
 * active dataset, and the one derived fact an editor genuinely needs — why this
 * place cannot be published yet, from the same `approvalBlock` the publish
 * transaction enforces. No resolver, no PIP, two indexed queries.
 */

export type PlaceAdministrativeSummary = {
  status: MappingStatus;
  provinceCode: string | null;
  provinceName: string | null;
  communeCode: string | null;
  communeName: string | null;
  /** How the stored mapping was arrived at. `editor` means a person decided. */
  method: MappingMethod | null;
  /** The release the mapping was decided against — provenance, not a gate. */
  datasetVersion: string | null;
  /** What is published now. Null when this deployment has no dataset at all. */
  activeDatasetVersion: string | null;
  mappedAt: string | null;
  /**
   * Why this mapping does not permit publishing the place, or null. The same
   * policy the transition enforces, so the screen cannot promise a publish the
   * server will refuse.
   */
  approvalBlock: ApprovalBlock | null;
};

export type SummarySubject = {
  administrativeMappingStatus: MappingStatus;
  provinceCode: string | null;
  communeCode: string | null;
  administrativeMappingSource: MappingMethod | null;
  administrativeDatasetVersion: string | null;
  administrativeMappedAt: Date | null;
};

export async function placeAdministrativeSummary(
  executor: Executor,
  place: SummarySubject,
): Promise<PlaceAdministrativeSummary> {
  const base = {
    status: place.administrativeMappingStatus,
    provinceCode: place.provinceCode,
    communeCode: place.communeCode,
    method: place.administrativeMappingSource,
    datasetVersion: place.administrativeDatasetVersion,
    mappedAt: place.administrativeMappedAt?.toISOString() ?? null,
  };

  const dataset = await activeDataset(executor);
  if (!dataset) {
    return {
      ...base,
      provinceName: null,
      communeName: null,
      activeDatasetVersion: null,
      approvalBlock: {
        code: 'ADMINISTRATIVE_DATASET_UNAVAILABLE',
        message:
          'no administrative dataset is published, so no mapping can be validated against one',
      },
    };
  }

  const codes = [place.provinceCode, place.communeCode].filter(
    (code): code is string => code !== null,
  );
  const units = codes.length
    ? await (executor as Db)
        .select({
          code: schema.administrativeUnits.code,
          level: schema.administrativeUnits.level,
          fullName: schema.administrativeUnits.fullName,
          parentCode: schema.administrativeUnits.parentCode,
          status: schema.administrativeUnits.status,
          effectiveTo: schema.administrativeUnits.effectiveTo,
          effectiveFrom: schema.administrativeUnits.effectiveFrom,
        })
        .from(schema.administrativeUnits)
        .where(
          and(
            eq(schema.administrativeUnits.datasetVersionId, dataset.id),
            inArray(schema.administrativeUnits.code, codes),
          ),
        )
        // Latest period first: a code that has ended still has a name, and
        // showing "Phường Trúc Bạch (00004), no longer current" beats showing a
        // bare code the editor cannot look up anywhere.
        .orderBy(desc(schema.administrativeUnits.effectiveFrom))
    : [];

  const latest = (code: string | null, level: 'PROVINCE' | 'COMMUNE') =>
    code === null ? null : (units.find((u) => u.code === code && u.level === level) ?? null);

  const province = latest(place.provinceCode, 'PROVINCE');
  const commune = latest(place.communeCode, 'COMMUNE');

  return {
    ...base,
    provinceName: province?.fullName ?? null,
    communeName: commune?.fullName ?? null,
    activeDatasetVersion: dataset.combinedDatasetVersion,
    approvalBlock: approvalBlock(
      {
        status: place.administrativeMappingStatus,
        provinceCode: place.provinceCode,
        communeCode: place.communeCode,
        datasetVersion: place.administrativeDatasetVersion,
      },
      dataset.combinedDatasetVersion,
      commune
        ? {
            code: commune.code,
            parentCode: commune.parentCode,
            status: commune.status,
            effectiveTo: commune.effectiveTo,
          }
        : null,
    ),
  };
}
