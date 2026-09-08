import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativeValidationService,
} from '@gogo/modules';

/**
 * ADM-004 (#457) — the gates and the diff against the real pinned dataset.
 *
 * The counts here are regression expectations for *these pins*, not universal
 * rules: a future source release is supposed to change them, and when it does
 * this test failing is the intended signal to look at the diff rather than a
 * defect to paper over.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let service: AdministrativeValidationService;

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');

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
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_validation_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await loadFixtureBoundaries(db);
  service = new AdministrativeValidationService(db);
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table administrative_dataset_versions cascade`);
  await db.execute(sql`truncate table places cascade`);
});

async function importStaged(overrideRevision = 0) {
  return new AdministrativeImportService(db).importPinnedSnapshot({ overrideRevision });
}

async function publish(id: string) {
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date() })
    .where(eq(schema.administrativeDatasetVersions.id, id));
}

async function insertPlace(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Quán Thử',
      nameNormalized: 'quan thu',
      geom: { x: 106.7009, y: 10.7769 },
      addressText: '12 Lê Lợi',
      ...over,
    })
    .returning();
  return row!;
}

describe('the pinned dataset passes every gate', () => {
  it('is publishable, with the warnings the pins are known to carry', async () => {
    const imported = await importStaged();
    const { report } = await service.validate(imported.datasetVersionId);

    // Asserted as the list, not the count: a failure then names the gate.
    expect(report.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(report.publishable).toBe(true);

    // Regression expectation for *these pins*. A source release is meant to
    // move these; this failing is the signal to read the diff.
    expect(report.counts).toEqual({
      currentProvinces: 34,
      currentCommunes: 3321,
      historicalProvinces: 63,
      historicalDistricts: 696,
      historicalCommunes: 10035,
      canonicalChanges: 9569,
      quarantined: 1033,
    });

    const gates = report.findings.map((f) => f.gate).sort();
    expect(gates).toEqual(['SOURCE_FORMATTING', 'UNRESOLVED_CHANGES']);
    expect(report.findings.every((f) => f.severity === 'WARNING')).toBe(true);

    // The one known formatting defect in v5.0.0, named rather than corrected.
    const formatting = report.findings.find((f) => f.gate === 'SOURCE_FORMATTING')!;
    expect(formatting.count).toBe(1);
    expect(formatting.samples[0]).toContain('06325');

    const unresolved = report.findings.find((f) => f.gate === 'UNRESOLVED_CHANGES')!;
    expect(unresolved.count).toBe(1033);
    expect(unresolved.message).toContain('1033 from divided communes');
  });

  it('promotes the dataset to VALIDATED and records the report on its row', async () => {
    const imported = await importStaged();
    await service.validate(imported.datasetVersionId);
    const [row] = await db
      .select()
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, imported.datasetVersionId));
    expect(row!.status).toBe('VALIDATED');
    expect((row!.validationReport as { publishable: boolean }).publishable).toBe(true);
    expect((row!.diffSummary as { toVersion: string }).toVersion).toBe(
      imported.combinedDatasetVersion,
    );
  });

  it('is deterministic — a second run reports the same findings and the same diff', async () => {
    const imported = await importStaged();
    const first = await service.validate(imported.datasetVersionId);
    const second = await service.validate(imported.datasetVersionId);
    expect(second.report.findings).toEqual(first.report.findings);
    expect(second.diff.entries.map((e) => e.key)).toEqual(first.diff.entries.map((e) => e.key));
    expect(second.diff.countsByCategory).toEqual(first.diff.countsByCategory);
  });
});

describe('an ERROR blocks publication eligibility', () => {
  it('refuses a dataset whose commune lost its province, and leaves it STAGED', async () => {
    const imported = await importStaged();
    // Break exactly one row: a current commune now names a province the
    // dataset does not hold.
    await db.execute(sql`
      update administrative_units set parent_code = '99'
       where dataset_version_id = ${imported.datasetVersionId}
         and code = '00004' and effective_to is null`);

    const { report } = await service.validate(imported.datasetVersionId);
    expect(report.publishable).toBe(false);
    expect(report.findings.find((f) => f.gate === 'CURRENT_COMMUNE_PARENT')).toMatchObject({
      severity: 'ERROR',
      count: 1,
    });

    const [row] = await db
      .select({ status: schema.administrativeDatasetVersions.status })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, imported.datasetVersionId));
    expect(row!.status).toBe('STAGED');
  });

  it('refuses a dataset whose stored version its own components do not produce', async () => {
    const imported = await importStaged();
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ combinedDatasetVersion: 'tampered+v9' })
      .where(eq(schema.administrativeDatasetVersions.id, imported.datasetVersionId));

    const { report } = await service.validate(imported.datasetVersionId);
    expect(report.publishable).toBe(false);
    expect(report.findings.map((f) => f.gate)).toContain('COMBINED_VERSION_CONSISTENT');
  });

  it('refuses a canonical change pointing at a unit the dataset does not hold', async () => {
    const imported = await importStaged();
    await db.execute(sql`
      update administrative_unit_changes set new_code = '99999'
       where dataset_version_id = ${imported.datasetVersionId}
       and id = (select id from administrative_unit_changes
                  where dataset_version_id = ${imported.datasetVersionId} limit 1)`);
    const { report } = await service.validate(imported.datasetVersionId);
    expect(report.publishable).toBe(false);
    expect(report.findings.map((f) => f.gate)).toContain('CHANGE_TARGET_RESOLVES');
  });

  it('refuses a SPLIT that reached the canonical table', async () => {
    const imported = await importStaged();
    await db.execute(sql`
      update administrative_unit_changes set change_type = 'SPLIT'
       where dataset_version_id = ${imported.datasetVersionId}
       and id = (select id from administrative_unit_changes
                  where dataset_version_id = ${imported.datasetVersionId} limit 1)`);
    const { report } = await service.validate(imported.datasetVersionId);
    expect(report.publishable).toBe(false);
    expect(report.findings.map((f) => f.gate)).toContain('MERGE_SPLIT_STRUCTURE');
  });
});

describe('the district-to-special-zone rows stay valid', () => {
  it('does not report the five island transitions as malformed', async () => {
    const imported = await importStaged();
    const { report, diff } = await service.validate(imported.datasetVersionId);

    // Côn Đảo moves province (77 → 79) and Cồn Cỏ (45 → 44). Provinces
    // differing is the point of those changes, not a defect.
    expect(report.errors).toBe(0);
    expect(diff.countsByCategory.REASSIGNED).toBe(5);

    const reassigned = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeUnitChanges)
      .where(eq(schema.administrativeUnitChanges.changeType, 'REASSIGNED'));
    expect(reassigned[0]!.n).toBe(5);
  });
});

describe('the diff against a published baseline', () => {
  it('reports source drift and no unit movement when only the override revision changes', async () => {
    const published = await importStaged(0);
    await publish(published.datasetVersionId);
    const staged = await importStaged(1);

    const { diff } = await service.validate(staged.datasetVersionId);
    expect(diff.fromVersion).toBe(published.combinedDatasetVersion);
    expect(diff.toVersion).toBe(staged.combinedDatasetVersion);
    // Identical units, identical changes, identical quarantine in both. The
    // only thing that moved is the pinned component, and that is the only
    // thing the diff says — not all 9,569 migrations over again.
    expect(diff.countsByCategory).toEqual({
      CREATED: 0,
      RENAMED: 0,
      MERGED: 0,
      SPLIT: 0,
      REASSIGNED: 0,
      DISSOLVED: 0,
      PARENT_CHANGED: 0,
      STATUS_CHANGED: 0,
      EFFECTIVE_PERIOD_CHANGED: 0,
      UNRESOLVED: 0,
      SOURCE_DRIFT: 1,
      // #484 added two. A pure override bump with no decisions behind it still
      // says exactly one thing.
      OVERRIDE_ACCEPTED: 0,
      OVERRIDE_TARGET_CHANGED: 0,
    });
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries.find((e) => e.category === 'SOURCE_DRIFT')!.detail).toBe(
      'overrideRevision: 0 → 1',
    );
  });

  it('reports every unit as CREATED on a first publication', async () => {
    const imported = await importStaged();
    const { diff } = await service.validate(imported.datasetVersionId);
    expect(diff.fromVersion).toBeNull();
    expect(diff.countsByCategory.CREATED).toBe(14149);
    expect(diff.countsByCategory.UNRESOLVED).toBe(1033);
    // Every canonical change appears once as a migration entry: 9,432 merges,
    // 132 one-to-one code migrations, 5 district-to-special-zone reassignments.
    expect(
      diff.countsByCategory.MERGED +
        diff.countsByCategory.REASSIGNED +
        diff.countsByCategory.RENAMED,
    ).toBe(9569);
    // The entry list is capped; the counts above are not.
    expect(diff.entriesTruncated).toBe(true);
    expect(diff.entries.length).toBe(diff.entryLimit);
  });
});

describe('affected places are counted, never rewritten', () => {
  it('counts nothing when every place is UNMAPPED', async () => {
    // An un-enriched catalogue has no administrative claim to invalidate.
    // Counting it would inflate every impact figure by the size of the catalogue.
    await insertPlace({ name: 'Chưa ánh xạ' });
    await insertPlace({ name: 'Cũng chưa' });
    const imported = await importStaged();
    const { diff } = await service.validate(imported.datasetVersionId);
    expect(diff.affectedPlaces.total).toBe(0);
    expect(diff.affectedPlaces.samples).toEqual([]);
  });

  it('counts a mapped place and samples it deterministically', async () => {
    await insertPlace({
      name: 'Quán Ba Đình',
      communeCode: '00004',
      provinceCode: '01',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'seed',
    });
    await insertPlace({ name: 'Chưa ánh xạ' });

    const imported = await importStaged();
    const { diff } = await service.validate(imported.datasetVersionId);
    expect(diff.affectedPlaces.total).toBe(1);
    expect(diff.affectedPlaces.samples).toEqual([
      expect.objectContaining({ name: 'Quán Ba Đình', code: '00004', status: 'AUTO_MATCHED' }),
    ]);
    expect(diff.affectedPlaces.sampleLimit).toBeGreaterThan(0);
  });

  it('bounds the sample list and says so when there are more', async () => {
    for (let i = 0; i < 25; i += 1) {
      await insertPlace({
        name: `Quán ${String(i).padStart(2, '0')}`,
        communeCode: '00004',
        administrativeMappingStatus: 'AUTO_MATCHED',
        administrativeDatasetVersion: 'seed',
      });
    }
    const imported = await importStaged();
    const { diff } = await service.validate(imported.datasetVersionId);
    expect(diff.affectedPlaces.total).toBe(25);
    expect(diff.affectedPlaces.samples).toHaveLength(diff.affectedPlaces.sampleLimit);
    expect(diff.affectedPlaces.truncated).toBe(true);
  });

  it('leaves every place exactly as it was — validation reads, it never writes', async () => {
    const before = await insertPlace({
      name: 'Quán Giữ Nguyên',
      city: 'TP.HCM',
      district: 'Quận 1',
      communeCode: '00004',
      administrativeMappingStatus: 'VERIFIED',
      administrativeDatasetVersion: 'seed',
    });
    const imported = await importStaged();
    await service.validate(imported.datasetVersionId);

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, before.id));
    expect(after!.addressText).toBe(before.addressText);
    expect(after!.city).toBe('TP.HCM');
    expect(after!.district).toBe('Quận 1');
    expect(after!.communeCode).toBe('00004');
    expect(after!.administrativeMappingStatus).toBe('VERIFIED');
    expect(after!.administrativeDatasetVersion).toBe('seed');
    expect(after!.updatedAt).toEqual(before.updatedAt);
  });
});
