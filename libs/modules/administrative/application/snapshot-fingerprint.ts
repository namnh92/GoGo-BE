import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Pick<Db, 'execute'> | Pick<Tx, 'execute'>;

/**
 * ADM-005 (#458) — a digest of the rows a dataset version actually holds.
 *
 * The combined checksum answers "which bytes and which decisions produced
 * this", which is the right question at import and the wrong one at publish: it
 * is computed from the pinned files and the override revision, so a row edited
 * directly in the database — a psql session, a half-finished migration, a
 * future admin tool — leaves it untouched. Validation would then still describe
 * the dataset by name while no longer describing its contents.
 *
 * So the fingerprint is taken over the stored rows themselves, including the
 * columns nobody would deliberately change (`updated_at` among them), which is
 * what makes any mutation visible. It is computed in PostgreSQL rather than in
 * Node because the alternative is streaming ~14,000 units into the API process
 * to hash them, twice per publish.
 *
 * The ordering inside each aggregate is explicit. `string_agg` without it is
 * free to return rows in whatever order the plan produced, and a digest that
 * changes with the query plan would report corruption on a healthy dataset.
 */
export async function snapshotFingerprint(
  executor: Executor,
  datasetVersionId: string,
  overrideRevision: number,
): Promise<string> {
  const result = await executor.execute(sql`
    select
      (select coalesce(md5(string_agg(u::text, E'\n' order by u.code, u.effective_from, u.id)), 'empty')
         from administrative_units u where u.dataset_version_id = ${datasetVersionId}) as units,
      (select coalesce(md5(string_agg(c::text, E'\n' order by c.old_code, c.new_code, c.id)), 'empty')
         from administrative_unit_changes c where c.dataset_version_id = ${datasetVersionId}) as changes,
      (select coalesce(md5(string_agg(q::text, E'\n' order by q.old_code, q.new_code, q.id)), 'empty')
         from administrative_mapping_quarantine q where q.dataset_version_id = ${datasetVersionId}) as quarantine,
      (select count(*)::int from administrative_units u where u.dataset_version_id = ${datasetVersionId}) as unit_count,
      (select count(*)::int from administrative_unit_changes c where c.dataset_version_id = ${datasetVersionId}) as change_count,
      (select count(*)::int from administrative_mapping_quarantine q where q.dataset_version_id = ${datasetVersionId}) as quarantine_count
  `);
  const row = (result as unknown as { rows: FingerprintRow[] }).rows[0]!;
  return createHash('sha256')
    .update(
      JSON.stringify([
        ['units', row.units, row.unit_count],
        ['changes', row.changes, row.change_count],
        ['quarantine', row.quarantine, row.quarantine_count],
        ['overrideRevision', overrideRevision],
      ]),
    )
    .digest('hex');
}

type FingerprintRow = {
  units: string;
  changes: string;
  quarantine: string;
  unit_count: number;
  change_count: number;
  quarantine_count: number;
};
