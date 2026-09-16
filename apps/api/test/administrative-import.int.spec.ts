import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  ADMINISTRATIVE_RESOURCES,
  DuplicateImportError,
  PinnedSnapshotReader,
  SnapshotChecksumError,
} from '@gogo/modules';

/**
 * ADM-002 (#455) — the importer, on the real pinned files.
 *
 * The counts asserted here are the ones ADR-0019 and the issue bodies quote. If
 * a re-pin changes them, this test fails and someone has to look — which is the
 * point: the numbers were established by a licence review and a manual
 * classification, and a snapshot that quietly moves invalidates both.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let service: AdministrativeImportService;

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');

/** One scalar out of a raw query — `noUncheckedIndexedAccess` makes the direct destructure a type error, and a helper says what is expected more plainly than a non-null assertion would. */
async function scalar<T>(query: Parameters<typeof db.execute>[0], column: string): Promise<T> {
  const { rows } = await db.execute(query);
  const first = rows[0] as Record<string, T> | undefined;
  if (!first) throw new Error(`query returned no rows: expected a ${column}`);
  return first[column] as T;
}

// #489 — a dataset import binds the boundary release that is loaded, so every
// fixture that imports must load one first. The five-entry fixture is real,
// unmodified geometry from the pinned archive and needs no network.
async function loadFixtureBoundaries(database: Parameters<typeof migrate>[0]): Promise<void> {
  await new AdministrativeBoundaryImportService(database as never).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    // The fixture is vendored and has no fetch URL, so the path is explicit.
    archivePath: path.resolve(
      __dirname,
      '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
    ),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await loadFixtureBoundaries(db);
  service = new AdministrativeImportService(db);
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table administrative_dataset_versions cascade`);
});

describe('importing the pinned snapshot set', () => {
  it('produces exactly the units and classification the pins were reviewed against', async () => {
    const report = await service.importPinnedSnapshot();

    expect(report.counts).toEqual({
      provinces: 34,
      communes: 3321,
      legacyDistricts: 696,
      legacyCommunes: 10035,
      canonicalChanges: 9569,
      quarantined: 1033,
    });

    // "Merged" means the successor absorbed more than one distinct legacy
    // predecessor, counting the ones that reached it through a split. Only 135
    // current communes have a single predecessor at all, which is why the
    // merge class dominates so heavily — the 2025 reorganisation was a
    // consolidation, not a renaming.
    expect(report.classification).toEqual({
      VALID_UNIQUE: 132,
      VALID_MERGE: 9432,
      VALID_DISTRICT_TO_SPECIAL_ZONE: 5,
      DIVIDED_REQUIRES_REVIEW: 1033,
    });

    // The one known source defect, surfaced rather than silently repaired. It
    // survives the v5.1.0 re-pin: commune 06325 still reads "xã Bắc Sơn" with a
    // lowercase type prefix, which is why unit type is derived case-insensitively.
    expect(report.warnings).toEqual([expect.stringContaining('06325')]);
    expect(report.combinedDatasetVersion).toBe('v5.1.0+v2.4.1+7fac8c45+fixture-v1+r0');
  });

  it('writes a STAGED dataset and nothing published', async () => {
    // An import is not a deployment. Publication is a separate audited act.
    await service.importPinnedSnapshot();
    const rows = await db.execute(
      sql`select status, count(*)::int as n from administrative_dataset_versions group by status`,
    );
    expect(rows.rows).toEqual([{ status: 'STAGED', n: 1 }]);
  });

  it('leaves every existing place UNMAPPED — an import maps nothing', async () => {
    await db.insert(schema.places).values({
      name: 'Quán Cũ',
      nameNormalized: 'quan cu',
      geom: { x: 106.7009, y: 10.7769 },
      addressText: '12 Lê Lợi, Quận 1',
      city: 'TP.HCM',
      district: 'Quận 1',
    });
    await service.importPinnedSnapshot();
    const [place] = await db.select().from(schema.places).limit(1);
    expect(place!.administrativeMappingStatus).toBe('UNMAPPED');
    expect(place!.communeCode).toBeNull();
    expect(place!.addressText).toBe('12 Lê Lợi, Quận 1');
    expect(place!.city).toBe('TP.HCM');
  });

  it('is deterministic — a second run computes the same identity and is refused', async () => {
    const first = await service.importPinnedSnapshot();
    await expect(service.importPinnedSnapshot()).rejects.toBeInstanceOf(DuplicateImportError);

    // Refused, not partially applied: still one dataset, and the same one.
    const n = await scalar<number>(
      sql`select count(*)::int as n from administrative_dataset_versions`,
      'n',
    );
    expect(n).toBe(1);
    const v = await scalar<string>(
      sql`select combined_dataset_version as v from administrative_dataset_versions`,
      'v',
    );
    expect(v).toBe(first.combinedDatasetVersion);
  });

  it('keeps a reused code apart by its effective period', async () => {
    await service.importPinnedSnapshot();
    // 00004 was Phường Trúc Bạch and is Phường Ba Đình. Both rows exist, and
    // the current one is the one an active read would return.
    const rows = (
      await db.execute(sql`
        select full_name, status, effective_from, effective_to
          from administrative_units
         where code = '00004'
         order by effective_from`)
    ).rows as { full_name: string; status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ full_name: 'Phường Trúc Bạch', status: 'INACTIVE' });
    expect(rows[1]).toMatchObject({ full_name: 'Phường Ba Đình', status: 'ACTIVE' });
  });

  it('closes every legacy unit on 2025-06-30 and activates none of them', async () => {
    await service.importPinnedSnapshot();
    const open_legacy = await scalar<number>(
      sql`
        select count(*)::int as open_legacy
          from administrative_units
         where source_version = 'v2.4.1'
           and (effective_to is distinct from date '2025-06-30' or status <> 'INACTIVE')`,
      'open_legacy',
    );
    expect(open_legacy).toBe(0);
  });

  it('gives every current commune a province that exists in the same dataset', async () => {
    await service.importPinnedSnapshot();
    const orphans = await scalar<number>(
      sql`
        select count(*)::int as orphans
          from administrative_units c
         where c.level = 'COMMUNE' and c.status = 'ACTIVE'
           and not exists (
             select 1 from administrative_units p
              where p.dataset_version_id = c.dataset_version_id
                and p.code = c.parent_code
                and p.level = 'PROVINCE'
                and p.status = 'ACTIVE')`,
      'orphans',
    );
    expect(orphans).toBe(0);
  });

  it('never records a canonical change pointing at a unit it does not hold', async () => {
    await service.importPinnedSnapshot();
    const dangling = await scalar<number>(
      sql`
        select count(*)::int as dangling
          from administrative_unit_changes ch
         where not exists (
                 select 1 from administrative_units u
                  where u.dataset_version_id = ch.dataset_version_id and u.code = ch.new_code)
            or not exists (
                 select 1 from administrative_units u
                  where u.dataset_version_id = ch.dataset_version_id and u.code = ch.old_code)`,
      'dangling',
    );
    expect(dangling).toBe(0);
  });

  it('records no successor at all for a divided commune', async () => {
    await service.importPinnedSnapshot();
    // 471 legacy communes were split. Not one of them may appear as a resolved
    // edge, because the source's default target is a guess.
    const n = await scalar<number>(
      sql`
        select count(*)::int as n
          from administrative_unit_changes
         where old_code in (
           select old_code from administrative_mapping_quarantine
            where classification = 'DIVIDED_REQUIRES_REVIEW')`,
      'n',
    );
    expect(n).toBe(0);

    const sources = await scalar<number>(
      sql`
        select count(distinct old_code)::int as sources
          from administrative_mapping_quarantine
         where classification = 'DIVIDED_REQUIRES_REVIEW'`,
      'sources',
    );
    expect(sources).toBe(471);
  });

  it('keeps the raw payload and the candidates on every quarantined row', async () => {
    await service.importPinnedSnapshot();
    const [row] = (
      await db.execute(sql`
        select raw_payload, suggested_candidates, upstream_flags, source_provenance
          from administrative_mapping_quarantine
         where classification = 'DIVIDED_REQUIRES_REVIEW'
         limit 1`)
    ).rows as {
      raw_payload: Record<string, unknown>;
      suggested_candidates: string[];
      upstream_flags: Record<string, boolean>;
      source_provenance: string;
    }[];
    // A reviewer must see what the source said, not GoGo's reading of it.
    expect(row!.raw_payload).toMatchObject({ isDividedWard: true });
    expect(row!.suggested_candidates.length).toBeGreaterThan(1);
    expect(row!.upstream_flags).toMatchObject({ isDividedWard: true });
    expect(row!.source_provenance).toContain('7fac8c45805aad9916b17237c54baf4502303b93');
  });
});

describe('a snapshot that has drifted is refused', () => {
  it('throws before parsing when a file does not match its pin', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adm-drift-'));
    for (const f of [
      'manifest.json',
      'current-units.v5.1.0.json.gz',
      'historical-units.v2.4.1.json.gz',
      'change-mapping.7fac8c4.csv.gz',
    ]) {
      copyFileSync(path.join(ADMINISTRATIVE_RESOURCES, f), path.join(dir, f));
    }
    // Tamper with the manifest rather than the gzip, so the failure is the
    // checksum comparison itself and not a corrupt-archive error.
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      sources: { role: string; sha256: string }[];
    };
    manifest.sources.find((s) => s.role === 'current-units')!.sha256 = 'a'.repeat(64);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const drifted = new AdministrativeImportService(db, new PinnedSnapshotReader(dir));
    await expect(drifted.importPinnedSnapshot()).rejects.toBeInstanceOf(SnapshotChecksumError);

    // Nothing was written: the check happens before any parse or insert.
    const n = await scalar<number>(
      sql`select count(*)::int as n from administrative_dataset_versions`,
      'n',
    );
    expect(n).toBe(0);
  });

  it('verifies the decompressed bytes, so the pin stays comparable with upstream', () => {
    const reader = new PinnedSnapshotReader();
    const source = reader.source('current-units');
    const content = reader.read(source);
    expect(createHash('sha256').update(content).digest('hex')).toBe(source.sha256);
    expect(content.byteLength).toBe(source.bytes);
  });
});
