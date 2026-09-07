import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

/**
 * ADM-002 (#455) — reading the vendored snapshots, checksum first.
 *
 * The bytes are in the repository rather than fetched because a migration must
 * produce the same dataset next year as today: an upstream tag can be
 * re-pointed and a raw URL can change what it serves, a committed file cannot.
 *
 * Every read verifies the SHA-256 in `manifest.json` against the **decompressed**
 * bytes before anything is parsed, and throws on a mismatch. A snapshot that has
 * drifted is not the snapshot the record counts, the licence review and the
 * classification numbers were established against, so importing it would be
 * importing something nobody checked.
 *
 * The pin is always of the raw content, never of the `.gz`, so it stays
 * directly comparable with the file upstream serves.
 */

export type ManifestSource = {
  role:
    | 'current-units'
    | 'historical-units'
    | 'change-mapping'
    | 'current-boundaries'
    | 'boundaries-fixture';
  repository: string;
  ref: string;
  commit: string;
  path: string;
  vendoredAs: string;
  /**
   * ADM-007 (#460): where an archive too large to vendor is fetched from. The
   * URL names an immutable commit, never a tag, and the checksum above is
   * verified before a byte of it is used — so the pin still decides what gets
   * loaded, and the network only decides whether it can be loaded at all.
   */
  fetchUrl?: string;
  sha256: string;
  bytes: number;
  license: string;
  licenseFile: string;
  retrievedAt: string;
  effectiveDate?: string;
  effectiveTo?: string;
  legalReference?: string;
  authority?: string;
  upstreamUpdatedAt?: string;
  expected?: Record<string, number>;
  /**
   * ADM-007: whether this archive claims to cover every current unit. The test
   * fixture is five real entries and says so, so the coverage gates check its
   * declared counts without demanding all 3,321 communes of it.
   */
  coverage?: 'complete' | 'partial';
  note?: string;
};

export type Manifest = {
  sources: ManifestSource[];
  knownDefects: { source: string; issue: string; handling: string; code?: string }[];
};

export class SnapshotChecksumError extends Error {
  constructor(
    readonly source: ManifestSource,
    readonly actual: string,
  ) {
    super(
      `${source.vendoredAs} does not match its pin: manifest says ${source.sha256}, file is ${actual}. ` +
        `Re-pinning is a deliberate act — update manifest.json in the same commit and re-run validation.`,
    );
    this.name = 'SnapshotChecksumError';
  }
}

/** Default location of the vendored set, relative to the repository root. */
export const ADMINISTRATIVE_RESOURCES = path.resolve(
  __dirname,
  '../../../../resources/administrative',
);

export class PinnedSnapshotReader {
  constructor(private readonly dir: string = ADMINISTRATIVE_RESOURCES) {}

  manifest(): Manifest {
    return JSON.parse(readFileSync(path.join(this.dir, 'manifest.json'), 'utf8')) as Manifest;
  }

  source(role: ManifestSource['role']): ManifestSource {
    const found = this.manifest().sources.find((s) => s.role === role);
    if (!found) throw new Error(`manifest.json has no source with role ${role}`);
    return found;
  }

  /** Decompressed bytes, verified. Throws `SnapshotChecksumError` on drift. */
  read(source: ManifestSource): Buffer {
    const raw = readFileSync(path.join(this.dir, source.vendoredAs));
    const content = source.vendoredAs.endsWith('.gz') ? gunzipSync(raw) : raw;
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== source.sha256) throw new SnapshotChecksumError(source, actual);
    return content;
  }

  readJson<T>(role: ManifestSource['role']): { source: ManifestSource; data: T } {
    const source = this.source(role);
    return { source, data: JSON.parse(this.read(source).toString('utf8')) as T };
  }

  readText(role: ManifestSource['role']): { source: ManifestSource; text: string } {
    const source = this.source(role);
    return { source, text: this.read(source).toString('utf8') };
  }
}
