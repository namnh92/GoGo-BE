import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { assertCurrentPair, currentUnit, type Executor } from './unit-lookup';

/** An area can be a whole province; a place address still requires a commune. */
export const administrativeAreaInput = z
  .object({
    datasetVersion: z.string().trim().min(1).max(200),
    provinceCode: z.string().regex(/^\d{2,5}$/),
    communeCode: z
      .string()
      .regex(/^\d{2,5}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type AdministrativeAreaInput = z.infer<typeof administrativeAreaInput>;
export type AdministrativeArea = AdministrativeAreaInput & {
  provinceName: string;
  communeName: string | null;
};

export async function validateAreaSelection(
  executor: Executor,
  input: AdministrativeAreaInput,
): Promise<AdministrativeArea> {
  const [dataset] = await (executor as Db)
    .select()
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
    .for('share')
    .limit(1);
  if (!dataset)
    throw AppError.serviceUnavailable(
      'ADMINISTRATIVE_DATASET_UNAVAILABLE',
      'No administrative dataset is published',
    );
  if (dataset.combinedDatasetVersion !== input.datasetVersion) {
    throw AppError.conflict(
      'ADMINISTRATIVE_VERSION_CHANGED',
      'Administrative data changed; reselect the area',
    );
  }
  if (input.communeCode) {
    const names = await assertCurrentPair(executor, dataset, input);
    return { ...input, provinceName: names.provinceName!, communeName: names.communeName };
  }
  const province = await currentUnit(executor, dataset.id, input.provinceCode, 'PROVINCE');
  if (!province) throw AppError.badRequest('PROVINCE_NOT_CURRENT', 'Choose a current province');
  return { ...input, provinceName: province.fullName, communeName: null };
}
