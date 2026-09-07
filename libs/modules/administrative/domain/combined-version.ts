import { createHash } from 'node:crypto';

/**
 * ADM-002 (#455) / ADR-0019 §4 — the identity of a GoGo administrative dataset.
 *
 * A published set is not "v5.0.0". It is a combination of three independently
 * pinned upstreams plus GoGo's own reviewer overrides, each of which moves on
 * its own cadence — the boundary release is already out of step with the unit
 * release. So the identity is the tuple, and changing any component, including
 * a reviewer approving one override, produces a new version that is validated,
 * diffed and published like any other.
 *
 * Both the version string and the checksum are pure functions of the
 * components. Re-running the importer on unchanged inputs therefore produces a
 * version that already exists, which is what makes duplicate import a
 * detectable condition rather than a silent second copy.
 */

export type DatasetComponents = {
  currentSourceVersion: string;
  currentChecksum: string;
  historicalSourceVersion: string | null;
  historicalChecksum: string | null;
  mappingSourceCommit: string | null;
  mappingChecksum: string | null;
  boundarySourceVersion: string | null;
  boundaryChecksum: string | null;
  overrideRevision: number;
};

/** Short commit form used in the human-facing version string. */
function short(commit: string | null): string {
  return commit ? commit.slice(0, 8) : 'none';
}

/**
 * Readable and ordered: a person reading a version string in the CMS or in an
 * audit row can see which upstreams produced it without a lookup.
 */
export function combinedDatasetVersion(c: DatasetComponents): string {
  return [
    c.currentSourceVersion,
    c.historicalSourceVersion ?? 'none',
    short(c.mappingSourceCommit),
    short(c.boundarySourceVersion),
    `r${c.overrideRevision}`,
  ].join('+');
}

/**
 * Over the component checksums, not over the parsed rows.
 *
 * Hashing the rows would make the checksum depend on this importer's own
 * output, so a refactor that changed a field order would look like new source
 * data. Hashing the inputs keeps the question the checksum answers exactly
 * "which bytes and which decisions produced this", which is the question the
 * duplicate-import gate and the publish gate both ask.
 */
export function combinedChecksum(c: DatasetComponents): string {
  const canonical = JSON.stringify([
    ['current', c.currentSourceVersion, c.currentChecksum],
    ['historical', c.historicalSourceVersion, c.historicalChecksum],
    ['mapping', c.mappingSourceCommit, c.mappingChecksum],
    ['boundary', c.boundarySourceVersion, c.boundaryChecksum],
    ['overrideRevision', c.overrideRevision],
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
