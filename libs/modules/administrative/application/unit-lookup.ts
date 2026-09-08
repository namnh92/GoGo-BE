import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import {
  validateCurrentPair,
  type UnitPairInput,
  type UnitPairIssue,
} from '../domain/unit-validation';

/**
 * ADM-015 — the reads `validateCurrentPair` needs, against whichever executor
 * the caller is already using.
 *
 * The executor parameter is the whole point. A moderator's verification, a
 * place edit and an import row all validate inside the transaction that will do
 * the write; a helper that opened its own connection would answer about a
 * dataset the transaction cannot see, and the gap between the two is exactly
 * where a publication slips in.
 */

export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type DatasetRef = { id: string; combinedDatasetVersion: string };

/** The one published dataset, or `null` when this deployment has none yet. */
export async function activeDataset(executor: Executor): Promise<DatasetRef | null> {
  const [row] = await (executor as Db)
    .select({
      id: schema.administrativeDatasetVersions.id,
      combinedDatasetVersion: schema.administrativeDatasetVersions.combinedDatasetVersion,
    })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
    .limit(1);
  return row ?? null;
}

/**
 * The throwing form. A caller that is about to *store* a code has no honest
 * answer without a dataset to check it against, so it says so rather than
 * storing an unvalidated claim.
 */
export async function requireActiveDataset(executor: Executor): Promise<DatasetRef> {
  const dataset = await activeDataset(executor);
  if (!dataset) {
    throw AppError.serviceUnavailable(
      'ADMINISTRATIVE_DATASET_UNAVAILABLE',
      'no administrative dataset is published',
    );
  }
  return dataset;
}

/** Active, with no end date — the unit this code names *now*. */
export async function currentUnit(
  executor: Executor,
  datasetVersionId: string,
  code: string,
  level: 'PROVINCE' | 'COMMUNE',
): Promise<{ code: string; fullName: string; parentCode: string | null } | null> {
  const [row] = await (executor as Db)
    .select({
      code: schema.administrativeUnits.code,
      fullName: schema.administrativeUnits.fullName,
      parentCode: schema.administrativeUnits.parentCode,
    })
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
  return row ?? null;
}

/**
 * Any period of a legacy district. Asking for a *current* dissolved district
 * would never find one — they all ended on 2025-06-30.
 */
export async function legacyDistrictUnit(
  executor: Executor,
  datasetVersionId: string,
  code: string,
): Promise<{ code: string; fullName: string; parentCode: string | null } | null> {
  const [row] = await (executor as Db)
    .select({
      code: schema.administrativeUnits.code,
      fullName: schema.administrativeUnits.fullName,
      parentCode: schema.administrativeUnits.parentCode,
    })
    .from(schema.administrativeUnits)
    .where(
      and(
        eq(schema.administrativeUnits.datasetVersionId, datasetVersionId),
        eq(schema.administrativeUnits.code, code),
        eq(schema.administrativeUnits.level, 'LEGACY_DISTRICT'),
      ),
    )
    .orderBy(desc(schema.administrativeUnits.effectiveFrom))
    .limit(1);
  return row ?? null;
}

export type PairNames = {
  provinceName: string | null;
  communeName: string | null;
  legacyDistrictName: string | null;
};

/** Looks the pair up and judges it. `null` means it is usable. */
export async function checkCurrentPair(
  executor: Executor,
  dataset: DatasetRef,
  input: UnitPairInput,
): Promise<{ issue: UnitPairIssue | null; names: PairNames }> {
  const [province, commune, legacy] = await Promise.all([
    input.provinceCode
      ? currentUnit(executor, dataset.id, input.provinceCode, 'PROVINCE')
      : Promise.resolve(null),
    input.communeCode
      ? currentUnit(executor, dataset.id, input.communeCode, 'COMMUNE')
      : Promise.resolve(null),
    input.legacyDistrictCode
      ? legacyDistrictUnit(executor, dataset.id, input.legacyDistrictCode)
      : Promise.resolve(null),
  ]);

  const issue = validateCurrentPair(
    input,
    {
      province,
      commune,
      ...(input.legacyDistrictCode ? { legacyDistrict: legacy } : {}),
    },
    dataset.combinedDatasetVersion,
  );
  return {
    issue,
    names: {
      provinceName: province?.fullName ?? null,
      communeName: commune?.fullName ?? null,
      legacyDistrictName: legacy?.fullName ?? null,
    },
  };
}

/**
 * The throwing form, for a write path.
 *
 * `400` rather than `422`: the request named units that do not exist together,
 * which is the client sending something wrong, and `field_errors` points at the
 * box responsible so the console can render it in place.
 */
export async function assertCurrentPair(
  executor: Executor,
  dataset: DatasetRef,
  input: UnitPairInput,
): Promise<PairNames> {
  const { issue, names } = await checkCurrentPair(executor, dataset, input);
  if (issue) {
    throw AppError.badRequest(issue.code, issue.message, [
      { field: issue.field, code: issue.code.toLowerCase(), message: issue.message },
    ]);
  }
  return names;
}

/**
 * Names for a batch of codes, in one query.
 *
 * Built for a list: an import job page carries hundreds of rows over a handful
 * of distinct units, and a lookup per row would turn one screen into hundreds
 * of round trips. Latest period first, so a code whose unit has since ended
 * still has a name — showing a bare code an editor cannot look up anywhere is
 * the worse failure.
 */
export async function unitNames(
  executor: Executor,
  datasetVersionId: string,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(codes.filter((code) => code.length > 0))];
  if (distinct.length === 0) return new Map();
  const rows = await (executor as Db)
    .select({
      code: schema.administrativeUnits.code,
      fullName: schema.administrativeUnits.fullName,
      level: schema.administrativeUnits.level,
    })
    .from(schema.administrativeUnits)
    .where(
      and(
        eq(schema.administrativeUnits.datasetVersionId, datasetVersionId),
        inArray(schema.administrativeUnits.code, distinct),
      ),
    )
    .orderBy(desc(schema.administrativeUnits.effectiveFrom));

  const names = new Map<string, string>();
  // A commune and a province can share a code string across levels, so the key
  // carries the level and the caller asks for the one it means.
  for (const row of rows) {
    const key = `${row.level}:${row.code}`;
    if (!names.has(key)) names.set(key, row.fullName);
  }
  return names;
}
