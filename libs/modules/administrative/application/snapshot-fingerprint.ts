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
  /**
   * #489 — the boundary release the dataset is bound to. Part of the
   * fingerprint because the geometry is as much a component of what was
   * validated as the units are: a dataset revalidated against a different
   * boundary release is a different snapshot, and publishing it on the strength
   * of the earlier validation would be publishing something nobody checked.
   *
   * `null` reproduces the pre-#489 hash for the one dataset that predates
   * boundary binding, so the DEV `+none+r0` baseline still fingerprints to what
   * is stored on it.
   */
  boundary: { version: string; checksum: string } | null = null,
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
        // Appended, not inserted: a null boundary yields the original tuple, so
        // datasets imported before #489 keep the fingerprint already stored.
        ...(boundary ? [['boundary', boundary.version, boundary.checksum]] : []),
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

/**
 * #489 — the boundary identity a dataset row is bound to, in the shape
 * `snapshotFingerprint` takes.
 *
 * The version comes from the row and the checksum from the manifest pin, the
 * same asymmetry the other three components already use: the row records which
 * release was bound, the manifest records what those bytes are, and a
 * disagreement between them is what the checksum gates exist to catch.
 *
 * Null for a dataset imported before boundary binding, which keeps its stored
 * fingerprint reproducible.
 */
export async function boundaryIdentity(
  executor: Executor,
  row: { boundarySourceVersion: string | null },
): Promise<{ version: string; checksum: string } | null> {
  if (!row.boundarySourceVersion) return null;
  // From the ledger, not from a manifest role. The version name is chosen by
  // whoever ran the loader — `fixture-v1` names no manifest entry — so only the
  // ledger says which bytes that name refers to. The loader refuses to redefine
  // an existing version with a different archive, which is what makes this
  // stable enough to recompute an identity against; if the row is gone, the
  // checksum resolves to null and every gate refuses, which is the honest
  // answer for a dataset bound to a release the database no longer has.
  const result = await executor.execute(sql`
    select source_checksum from administrative_boundary_loads
    where boundary_version = ${row.boundarySourceVersion} limit 1
  `);
  const found = (result as unknown as { rows: { source_checksum: string }[] }).rows[0];
  return found ? { version: row.boundarySourceVersion, checksum: found.source_checksum } : null;
}
