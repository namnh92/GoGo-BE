import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readZipEntries, type ZipEntry } from './zip-archive';
import {
  PinnedSnapshotReader,
  SnapshotChecksumError,
  type ManifestSource,
} from './pinned-snapshot.reader';

/**
 * ADM-007 (#460) — reading the pinned boundary archive, checksum first.
 *
 * ADM-002 vendored its snapshots into the repository and said why: a tag can be
 * re-pointed and a raw URL can change what it serves, a committed file cannot.
 * That reasoning still holds and this archive still cannot follow it — 47.6 MB
 * compressed, 629 MB expanded, 3,355 files. Committing it would put a
 * half-gigabyte of coordinates into every clone, every CI checkout and every
 * `git log` walk, forever, for a file that changes once a year.
 *
 * So the pin moves from the bytes to two things that together give the same
 * guarantee:
 *
 * 1. **The URL names an immutable commit**, not a tag or a branch. A tag can be
 *    moved; `b092d6b4…` cannot.
 * 2. **The SHA-256 is verified before a single entry is read.** If GitHub ever
 *    served different bytes, the load fails closed rather than importing
 *    something nobody checked.
 *
 * What is lost is availability, not integrity — and availability is not on the
 * request path. Nothing here runs at API startup; the loader is an operational
 * step someone invokes, and the resolver reads the polygons out of PostgreSQL.
 * A machine with no network can still load, from a cached or explicitly
 * supplied archive.
 */

export type ArchiveOrigin = 'explicit' | 'cache' | 'download';

export type ResolvedArchive = {
  path: string;
  bytes: number;
  sha256: string;
  origin: ArchiveOrigin;
};

export type BoundaryFeature = {
  code: string;
  name: string;
  fullName: string;
  nameEn: string | null;
  level: 'PROVINCE' | 'COMMUNE';
  /** Province code for a commune; null for a province. Taken from the layout. */
  parentCode: string | null;
  /** The GeoJSON geometry object, handed to PostGIS untouched. */
  geometry: unknown;
  geometryType: string;
  areaKm2: number | null;
  /** The archive entry it came from, for the provenance a reviewer reads. */
  entry: string;
};

export class BoundaryArchiveUnavailableError extends Error {
  constructor(source: ManifestSource, cause: string) {
    super(
      `the pinned boundary archive is not available: ${cause}. ` +
        `Supply it with ADMINISTRATIVE_BOUNDARY_ARCHIVE=/path/to/${source.vendoredAs}, ` +
        `or allow the loader to fetch ${source.fetchUrl ?? 'the pinned URL'}.`,
    );
    this.name = 'BoundaryArchiveUnavailableError';
  }
}

/** Where a downloaded archive is kept so a second load does not re-fetch it. */
const DEFAULT_CACHE = path.resolve(process.cwd(), '.cache', 'administrative-boundaries');

export class BoundaryArchiveReader {
  constructor(
    private readonly snapshots: PinnedSnapshotReader = new PinnedSnapshotReader(),
    private readonly cacheDir: string = process.env.ADMINISTRATIVE_BOUNDARY_CACHE ?? DEFAULT_CACHE,
  ) {}

  source(role = 'current-boundaries'): ManifestSource {
    return this.snapshots.source(role as ManifestSource['role']);
  }

  /**
   * Finds the archive and proves it is the pinned one.
   *
   * Explicit path, then cache, then the network — in that order, because an
   * operator who named a file meant that file, and because a machine that has
   * already paid for the download should not pay again.
   */
  async resolve(source: ManifestSource, explicitPath?: string): Promise<ResolvedArchive> {
    const named = explicitPath ?? process.env.ADMINISTRATIVE_BOUNDARY_ARCHIVE;
    if (named) return this.verify(named, source, 'explicit');

    const cached = path.join(this.cacheDir, source.vendoredAs);
    if (existsSync(cached)) return this.verify(cached, source, 'cache');

    if (!source.fetchUrl) {
      throw new BoundaryArchiveUnavailableError(source, 'the manifest declares no fetch URL');
    }
    const bytes = await this.download(source);
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(cached, bytes);
    return this.verify(cached, source, 'download');
  }

  /**
   * Every feature in the archive, one inflate at a time.
   *
   * A generator rather than an array: the archive expands to 629 MB, and the
   * loader only ever needs one feature's coordinates at a time to hand them to
   * PostGIS.
   */
  *features(archivePath: string): Generator<BoundaryFeature> {
    const entries = readZipEntries(readFileSync(archivePath))
      .filter((e) => e.name.endsWith('.geojson'))
      // Deterministic order, so two loads of one archive produce identical
      // insert order and identical timings to compare.
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      yield this.parse(entry);
    }
  }

  private parse(entry: ZipEntry): BoundaryFeature {
    const parsed = JSON.parse(entry.read().toString('utf8')) as GeoJsonFile;
    const features = parsed.features ?? [];
    if (features.length !== 1) {
      throw new Error(
        `${entry.name} holds ${features.length} features; the pinned archive has one per file`,
      );
    }
    const feature = features[0]!;
    const properties = feature.properties ?? {};
    const segments = entry.name.split('/');
    // `geojson/01_ha_noi/wards/00004_ba_dinh.geojson` — the province directory
    // is the parent. Taken from the layout because the ward files do not carry
    // a province code in their properties, and cross-checked against the pinned
    // units by the validation gates rather than trusted.
    const isCommune = segments.includes('wards');
    const provinceDirectory = segments[1] ?? '';
    return {
      code: String(properties.code ?? ''),
      name: String(properties.name ?? ''),
      fullName: String(properties.fullName ?? properties.name ?? ''),
      nameEn: properties.nameEn ? String(properties.nameEn) : null,
      level: isCommune ? 'COMMUNE' : 'PROVINCE',
      parentCode: isCommune ? (provinceDirectory.split('_')[0] ?? null) : null,
      geometry: feature.geometry,
      geometryType: String((feature.geometry as { type?: string } | undefined)?.type ?? 'unknown'),
      areaKm2: typeof properties.areaKm2 === 'number' ? properties.areaKm2 : null,
      entry: entry.name,
    };
  }

  private verify(file: string, source: ManifestSource, origin: ArchiveOrigin): ResolvedArchive {
    if (!existsSync(file)) {
      throw new BoundaryArchiveUnavailableError(source, `${file} does not exist`);
    }
    const bytes = readFileSync(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== source.sha256) throw new SnapshotChecksumError(source, sha256);
    return { path: file, bytes: bytes.length, sha256, origin };
  }

  private async download(source: ManifestSource): Promise<Buffer> {
    const response = await fetch(source.fetchUrl!);
    if (!response.ok) {
      throw new BoundaryArchiveUnavailableError(
        source,
        `${source.fetchUrl} answered ${response.status}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

type GeoJsonFile = {
  features?: { geometry?: unknown; properties?: Record<string, unknown> }[];
};
