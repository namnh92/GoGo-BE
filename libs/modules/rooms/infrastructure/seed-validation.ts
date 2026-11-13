import { eq, sql } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import type { Tx } from '../../shared/outbox';
import type { ConstraintRow } from './rooms.repository';
import { pgArray } from '../../search/infrastructure/search.repository';

/** Same published/VERIFIED administrative mapping and inclusive PostGIS scope as candidate retrieval.
 * Dataset first, then catalog rows by UUID: compatible with catalog/admin writers. */
export async function validateSeedPlaces(
  tx: Tx,
  ids: string[],
  constraint: Pick<
    ConstraintRow,
    'administrativeArea' | 'areaKey' | 'originLat' | 'originLng' | 'radiusM'
  >,
  field = 'placeIds',
): Promise<void> {
  if (!ids.length) return;
  const area = constraint.administrativeArea;
  const hasRadius =
    constraint.originLat !== null &&
    constraint.originLng !== null &&
    constraint.radiusM !== null &&
    constraint.radiusM > 0;
  if (
    (constraint.radiusM !== null && !hasRadius) ||
    (!area && constraint.areaKey && !hasRadius) ||
    ((constraint.originLat !== null || constraint.originLng !== null) && !hasRadius)
  )
    throw AppError.conflict(
      'ROOM_AREA_UNRESOLVED',
      'Choose a complete room area before adding seed places',
    );
  if (area) {
    const [dataset] = await tx
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'))
      .for('share');
    if (!dataset || dataset.combinedDatasetVersion !== area.datasetVersion)
      throw AppError.conflict(
        'ADMINISTRATIVE_VERSION_CHANGED',
        'Administrative data changed; reselect the area',
      );
  }
  const areaMatch = area
    ? sql`p.administrative_mapping_status = 'VERIFIED' and p.administrative_dataset_version = ${area.datasetVersion} and p.province_code = ${area.provinceCode} ${area.communeCode ? sql`and p.commune_code = ${area.communeCode}` : sql``}`
    : sql`true`;
  const radiusMatch = hasRadius
    ? sql`ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(${constraint.originLng}, ${constraint.originLat}), 4326)::geography, ${constraint.radiusM})`
    : sql`true`;
  const rows = await tx.execute(
    sql`select p.id, p.status, (${areaMatch} and ${radiusMatch}) as in_area from places p where p.id = any(${pgArray(ids)}::uuid[]) order by p.id for share`,
  );
  const places = rows.rows as { id: string; status: string; in_area: boolean | null }[];
  if (places.length !== ids.length || places.some((p) => p.status !== 'published'))
    throw AppError.badRequest('INVALID_SEED_PLACE', 'Seed places must be verified catalog places', [
      { field, code: 'invalid', message: 'contains unknown/unpublished places' },
    ]);
  if (places.some((p) => p.in_area !== true))
    throw AppError.badRequest(
      'SEED_PLACE_OUT_OF_AREA',
      'Seed places must be within the room area',
      [{ field, code: 'out_of_area', message: 'contains places outside the room area' }],
    );
}
