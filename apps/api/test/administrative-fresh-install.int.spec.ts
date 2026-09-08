import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  AdministrativeBackfillService,
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativePublicationService,
  AdministrativeResolverService,
  AdministrativeTelemetryService,
  AdministrativeValidationService,
  BoundaryReleaseRequiredError,
  DuplicateImportError,
} from '@gogo/modules';

/**
 * #489 — the path a brand-new environment actually takes.
 *
 * Every other administrative spec starts from a database that already has a
 * dataset, which is exactly why none of them could see the defect this covers:
 * the loader demanded a PUBLISHED dataset to resolve boundary codes against,
 * and a dataset could only carry a boundary release that was already loaded.
 * Neither could go first. Publishing first produced a dataset whose boundary
 * component was permanently null — and because that component is part of the
 * identity, no later import could ever attach one. DEV loaded 3,355 real
 * polygons and the resolver could not reach a single one.
 *
 * So this file starts with nothing and asserts the order works, in order. The
 * tests share state deliberately and run in sequence; each one is a step of the
 * install, not an isolated case.
 */

const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);
const BOUNDARY_VERSION = 'fixture-v5.0.0';
const SECOND_VERSION = 'fixture-v5.0.1';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let loader: AdministrativeBoundaryImportService;
let importer: AdministrativeImportService;
let validation: AdministrativeValidationService;
let publication: AdministrativePublicationService;
let resolver: AdministrativeResolverService;
let telemetry: AdministrativeTelemetryService;
let backfill: AdministrativeBackfillService;

/** What the ledger says was loaded, which is the only record of what a version name means. */
async function ledger(version: string) {
  const [row] = await db
    .select()
    .from(schema.administrativeBoundaryLoads)
    .where(eq(schema.administrativeBoundaryLoads.boundaryVersion, version));
  return row ?? null;
}

async function datasets() {
  return db
    .select()
    .from(schema.administrativeDatasetVersions)
    .orderBy(schema.administrativeDatasetVersions.createdAt);
}

async function insidePoint(code: string, version = BOUNDARY_VERSION) {
  const result = await db.execute(sql`
    select st_x(p) as lng, st_y(p) as lat from (
      select st_pointonsurface(geom) as p from administrative_unit_boundaries
      where boundary_version = ${version} and code = ${code}) s`);
  return (result as unknown as { rows: { lng: number; lat: number }[] }).rows[0]!;
}

async function insertPlace(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Quán Thử',
      nameNormalized: 'quan thu',
      geom: { x: 105.82, y: 21.04 },
      addressText: '12 Phan Đình Phùng',
      ...over,
    })
    .returning();
  return row!;
}

/**
 * The provider meters, read straight from the tables the Cost Center bills from.
 *
 * Scraping /v1/metrics would only show this process's counters; the usage ledger
 * is what a spend question is actually answered from, and a write there is what
 * "the administrative surface called a provider" would look like.
 */
async function providerUsage(): Promise<number> {
  const result = await db.execute(sql`select count(*)::int as n from provider_usage_daily`);
  return (result as unknown as { rows: { n: number }[] }).rows[0]!.n;
}

async function placeSnapshot(): Promise<string> {
  const result = await db.execute(sql`
    select coalesce(md5(string_agg(p::text, E'\n' order by p.id)), 'empty') as h
    from places p`);
  return (result as unknown as { rows: { h: string }[] }).rows[0]!.h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_fresh_install_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();

  loader = app.get(AdministrativeBoundaryImportService);
  importer = app.get(AdministrativeImportService);
  validation = app.get(AdministrativeValidationService);
  publication = app.get(AdministrativePublicationService);
  resolver = app.get(AdministrativeResolverService);
  telemetry = app.get(AdministrativeTelemetryService);
  backfill = app.get(AdministrativeBackfillService);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('a fresh environment, in the order it actually happens', () => {
  it('refuses to import before any boundary release is loaded', async () => {
    expect(await datasets()).toEqual([]);

    await expect(importer.importPinnedSnapshot()).rejects.toBeInstanceOf(
      BoundaryReleaseRequiredError,
    );

    // The refusal is the point: the old behaviour imported a `+none` dataset
    // that no later import could ever repair, because the boundary component is
    // part of the identity.
    expect(await datasets()).toEqual([]);
  });

  it('does not let a rejected boundary load become importable', async () => {
    // Truncated mid-archive: the loader fails before it can write a ledger row,
    // so a failed release is not selectable by construction rather than by a
    // status column somebody has to remember to check.
    const { readFileSync, writeFileSync } = await import('node:fs');
    const truncated = '/tmp/adm489-truncated.zip';
    const bytes = readFileSync(FIXTURE);
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));

    await expect(
      loader.load({
        role: 'boundaries-fixture',
        boundaryVersion: 'broken',
        archivePath: truncated,
      }),
    ).rejects.toThrow();

    expect(await ledger('broken')).toBeNull();
    await expect(importer.importPinnedSnapshot()).rejects.toBeInstanceOf(
      BoundaryReleaseRequiredError,
    );
  });

  it('loads a boundary release with no dataset in the database at all', async () => {
    const result = await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: BOUNDARY_VERSION,
      archivePath: FIXTURE,
    });

    expect(result.outcome).toBe('loaded');
    expect(result.validation.errors).toBe(0);
    expect(result.counts).toEqual({ provinces: 2, communes: 3 });
    // Still nothing to bind to — the release stands on its own.
    expect(await datasets()).toEqual([]);
  });

  it('is idempotent: the same archive under the same version writes nothing new', async () => {
    const before = await ledger(BOUNDARY_VERSION);
    const again = await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: BOUNDARY_VERSION,
      archivePath: FIXTURE,
    });

    expect(again.outcome).toBe('unchanged');
    expect(await ledger(BOUNDARY_VERSION)).toEqual(before);
  });

  it('binds the exact loaded version and checksum into the imported dataset', async () => {
    const row = (await ledger(BOUNDARY_VERSION))!;
    const report = await importer.importPinnedSnapshot();

    const [dataset] = await datasets();
    expect(dataset!.boundarySourceVersion).toBe(BOUNDARY_VERSION);

    // The identity carries the release, so this is not, and can never collide
    // with, the `+none` dataset the old importer produced.
    expect(report.combinedDatasetVersion).toContain(`+${BOUNDARY_VERSION}+`);
    expect(report.combinedDatasetVersion).not.toContain('+none+');

    // The checksum is over the components, so a dataset claiming this release
    // is claiming these exact bytes.
    expect(row.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a byte-identical re-import as the duplicate it is', async () => {
    await expect(importer.importPinnedSnapshot()).rejects.toBeInstanceOf(DuplicateImportError);
    expect(await datasets()).toHaveLength(1);
  });

  it('validates and publishes, and only then does capability come up', async () => {
    const [dataset] = await datasets();
    const id = dataset!.id;

    const before = await telemetry.capability();
    expect(before.dataset.state).not.toBe('AVAILABLE');

    const validated = await validation.validate(id, { id: null, type: 'system' as const }, {});
    expect(validated.report.errors).toBe(0);
    expect(validated.report.publishable).toBe(true);
    // The validation is bound to the boundary too — a result obtained against
    // one release is not evidence about another.
    expect(validated.report.boundTo.combinedDatasetVersion).toContain(`+${BOUNDARY_VERSION}+`);

    await publication.publish(id, { id: null, type: 'system' as const }, {});

    const after = await telemetry.capability();
    expect(after.dataset.state).toBe('AVAILABLE');
    expect(after.boundaries.state).toBe('AVAILABLE');
    expect(after.boundaries.version).toBe(BOUNDARY_VERSION);
    expect(after.publication).toBe('ENABLED');
    // The whole point: PARTIAL was the symptom, FULL is the fix.
    expect(after.resolver).toBe('FULL');
  });

  it('resolves a real point through the geometry it is bound to', async () => {
    const point = await insidePoint('00004');
    const place = await insertPlace({ geom: { x: point.lng, y: point.lat } });

    const result = await resolver.resolvePlace(place.id);

    expect(result).toMatchObject({
      status: 'AUTO_MATCHED',
      communeCode: '00004',
      provinceCode: '01',
      method: 'boundary_point_in_polygon',
      boundaryVersion: BOUNDARY_VERSION,
    });
  });

  it('runs a dry-run that pins the boundary, uses geometry, and writes nothing', async () => {
    await db.execute(sql`truncate table places cascade`);
    const point = await insidePoint('00004');
    await insertPlace({ geom: { x: point.lng, y: point.lat } });

    const usageBefore = await providerUsage();
    const placesBefore = await placeSnapshot();

    const result = await backfill.run();

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.boundaryVersion).toBe(BOUNDARY_VERSION);
    // Geometry was used, not skipped: a run pinned to a null boundary resolved
    // nothing, which is how #489 would have made this number a lie.
    expect(result.counters.autoMatched).toBe(1);
    expect(result.counters.wouldWrite).toBe(1);
    expect(result.counters.written).toBe(0);

    expect(await placeSnapshot()).toBe(placesBefore);
    expect(await providerUsage()).toBe(usageBefore);
  });

  it('makes a different boundary release a different dataset, and rolls the old one back', async () => {
    const [first] = await datasets();
    const firstVersion = first!.combinedDatasetVersion;
    const firstChecksum = first!.combinedChecksum;

    await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: SECOND_VERSION,
      archivePath: FIXTURE,
    });

    // Same units, same mapping, different boundary release — so a different
    // dataset, not an edit of the published one. Identities are immutable.
    const second = await importer.importPinnedSnapshot();
    expect(second.combinedDatasetVersion).not.toBe(firstVersion);
    expect(second.combinedChecksum).not.toBe(firstChecksum);

    const untouched = (await datasets()).find((d) => d.id === first!.id)!;
    expect(untouched.combinedDatasetVersion).toBe(firstVersion);
    expect(untouched.combinedChecksum).toBe(firstChecksum);
    expect(untouched.boundarySourceVersion).toBe(BOUNDARY_VERSION);

    await validation.validate(second.datasetVersionId, { id: null, type: 'system' as const }, {});
    const published = await publication.publish(
      second.datasetVersionId,
      { id: null, type: 'system' as const },
      {},
    );

    // Demote and promote are one transaction, so there is never zero and never
    // two.
    expect(published.previousActiveVersion).toBe(firstVersion);
    const rows = await datasets();
    expect(rows.filter((d) => d.status === 'PUBLISHED')).toHaveLength(1);
    expect(rows.find((d) => d.id === first!.id)!.status).toBe('ROLLED_BACK');
  });

  it('restores the exact prior identity on rollback', async () => {
    const rows = await datasets();
    const previous = rows.find((d) => d.boundarySourceVersion === BOUNDARY_VERSION)!;

    await publication.rollback(previous.id, { id: null, type: 'system' as const }, {});

    const after = await datasets();
    const active = after.find((d) => d.status === 'PUBLISHED')!;
    expect(active.id).toBe(previous.id);
    expect(active.combinedDatasetVersion).toBe(previous.combinedDatasetVersion);
    expect(active.combinedChecksum).toBe(previous.combinedChecksum);
    expect(active.boundarySourceVersion).toBe(BOUNDARY_VERSION);

    expect((await telemetry.capability()).resolver).toBe('FULL');
  });

  it('refuses to publish once the release it was validated against is gone', async () => {
    // A third release, so this exercises drift on a candidate rather than on
    // the dataset currently serving traffic.
    const THIRD = 'fixture-v5.0.2';
    await loader.load({
      role: 'boundaries-fixture',
      boundaryVersion: THIRD,
      archivePath: FIXTURE,
    });
    const candidate = await importer.importPinnedSnapshot();
    await validation.validate(
      candidate.datasetVersionId,
      { id: null, type: 'system' as const },
      {},
    );

    // The ledger is the only record of what a version name refers to. Remove it
    // and the dataset is bound to a release the database no longer has, so the
    // identity it claims can no longer be reproduced — and a validation result
    // about bytes nobody can find is not evidence.
    await db
      .delete(schema.administrativeBoundaryLoads)
      .where(eq(schema.administrativeBoundaryLoads.boundaryVersion, THIRD));

    await expect(
      publication.publish(candidate.datasetVersionId, { id: null, type: 'system' as const }, {}),
    ).rejects.toThrow();

    // And the version that was already serving is still serving.
    const rows = await datasets();
    expect(rows.filter((d) => d.status === 'PUBLISHED')).toHaveLength(1);
    expect(rows.find((d) => d.status === 'PUBLISHED')!.boundarySourceVersion).toBe(
      BOUNDARY_VERSION,
    );
  });
});
