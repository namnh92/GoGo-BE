import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import {
  AdministrativeBackfillService,
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
} from '@gogo/modules';

/**
 * ADM-008 (#461) — the enrichment job, against real polygons.
 *
 * The boundaries are the committed fixture: five real, unmodified entries from
 * the pinned v5.0.0 release, so containment, shared edges and offshore special
 * zones are genuine rather than drawn for the test. The places are synthetic,
 * because what is being tested is the *job* — eligibility, batching, pinning,
 * protection and idempotency — and the resolver's own behaviour already has its
 * own suite.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let backfill: AdministrativeBackfillService;
let datasetId: string;
let datasetVersion: string;

const BOUNDARY_VERSION = 'fixture-v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function insidePoint(code: string): Promise<{ lng: number; lat: number }> {
  const [row] = await rows<{ lng: number; lat: number }>(sql`
    select st_x(p) as lng, st_y(p) as lat from (
      select st_pointonsurface(geom) as p from administrative_unit_boundaries
      where boundary_version = ${BOUNDARY_VERSION} and code = ${code}) s`);
  return row!;
}

async function sharedEdgePoint(): Promise<{ lng: number; lat: number }> {
  const [row] = await rows<{ lng: number; lat: number }>(sql`
    select st_x(p) as lng, st_y(p) as lat from (
      select st_pointonsurface(st_intersection(a.geom, b.geom)) as p
      from administrative_unit_boundaries a
      join administrative_unit_boundaries b
        on b.boundary_version = a.boundary_version and b.code = '00008'
      where a.boundary_version = ${BOUNDARY_VERSION} and a.code = '00004') s`);
  return row!;
}

async function insertPlace(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Quán Thử',
      nameNormalized: 'quan thu',
      geom: { x: 105.82, y: 21.04 },
      addressText: '12 Phan Đình Phùng',
      // Deliberately no `city`/`district`: with them set, the resolver's name
      // evidence answers every case and the geometry tests below would pass
      // without the geometry ever being consulted.
      ...over,
    })
    .returning();
  return row!;
}

async function placeRow(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}

/** Everything the job must never touch. */
function originals(row: Record<string, unknown>) {
  return {
    name: row.name,
    nameNormalized: row.nameNormalized,
    city: row.city,
    district: row.district,
    addressText: row.addressText,
    geom: row.geom,
    areaKey: row.areaKey,
    status: row.status,
  };
}

async function catalogueSnapshot(): Promise<string> {
  const all = await db.select().from(schema.places).orderBy(schema.places.id);
  return JSON.stringify(all.map(originals));
}

async function auditRows(action: string) {
  return db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_backfill_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));

  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: BOUNDARY_VERSION,
    archivePath: FIXTURE,
  });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  backfill = app.get(AdministrativeBackfillService);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
  await db.execute(sql`truncate table administrative_backfill_runs cascade`);
  await db.execute(sql`delete from audit_logs`);
});

describe('dry run', () => {
  it('resolves for real and writes absolutely nothing', async () => {
    const inside = await insidePoint('00004');
    const place = await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const before = await catalogueSnapshot();
    const beforeRow = await placeRow(place.id);

    const result = await backfill.run();
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.counters.autoMatched).toBe(1);
    expect(result.counters.wouldWrite).toBe(1);
    expect(result.counters.written).toBe(0);

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('UNMAPPED');
    expect(after.communeCode).toBeNull();
    expect(after.updatedAt.getTime()).toBe(beforeRow.updatedAt.getTime());
    expect(await catalogueSnapshot()).toBe(before);
    // No per-place audit, because no place was written.
    expect(await auditRows('administrative_mapping.resolve')).toEqual([]);
  });

  it('reports zero provider requests, zero Upstash commands and zero cost', async () => {
    // Structural rather than aspirational: the evidence is stored geometry and
    // GoGo's own pinned data, and nothing on this path can reach either.
    const google = await metricCount('places_provider_requests_total');
    const redis = await metricCount('provider_requests_total', 'upstash');
    await insertPlace();

    const result = await backfill.run();
    expect(result).toMatchObject({
      providerRequests: 0,
      upstashCommands: 0,
      estimatedProviderCostUsd: 0,
    });
    expect(await metricCount('places_provider_requests_total')).toBe(google);
    expect(await metricCount('provider_requests_total', 'upstash')).toBe(redis);
  });

  it('is the default: writing has to be asked for', async () => {
    await insertPlace({ geom: await insidePoint('00004').then((p) => ({ x: p.lng, y: p.lat })) });
    expect((await backfill.run()).dryRun).toBe(true);
    expect((await backfill.run({ dryRun: false })).dryRun).toBe(false);
  });

  it('bounds its samples while keeping the counts complete', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 25; i += 1) {
      await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    }
    const result = await backfill.run({ sampleLimit: 5 });
    expect(result.samples).toHaveLength(5);
    expect(result.counters.eligible).toBe(25);
    expect(result.counters.autoMatched).toBe(25);
  });
});

describe('execute', () => {
  it('writes the mapping and leaves every original field byte-identical', async () => {
    const inside = await insidePoint('00004');
    const place = await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const before = originals(await placeRow(place.id));

    const result = await backfill.run({ dryRun: false });
    expect(result.counters.written).toBe(1);

    const after = await placeRow(place.id);
    expect(originals(after)).toEqual(before);
    expect(after).toMatchObject({
      administrativeMappingStatus: 'AUTO_MATCHED',
      communeCode: '00004',
      provinceCode: '01',
      administrativeMappingSource: 'boundary_point_in_polygon',
      administrativeBoundaryVersion: BOUNDARY_VERSION,
      administrativeDatasetVersion: datasetVersion,
      administrativeMappingConfidence: '1.00',
    });
  });

  it('produces exactly what its dry run predicted', async () => {
    const inside = await insidePoint('00004');
    await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    await insertPlace({ geom: { x: 106.7, y: 10.77 } });
    const edge = await sharedEdgePoint();
    await insertPlace({ geom: { x: edge.lng, y: edge.lat } });

    const dry = await backfill.run();
    const wet = await backfill.run({ dryRun: false });

    expect(wet.counters.autoMatched).toBe(dry.counters.autoMatched);
    expect(wet.counters.needsReview).toBe(dry.counters.needsReview);
    expect(wet.counters.unmapped).toBe(dry.counters.unmapped);
    expect(wet.counters.written).toBe(dry.counters.wouldWrite);
  });

  it.each([
    ['a point strictly inside one commune', 'inside', 'AUTO_MATCHED', '1.00'],
    ['a point on a shared administrative border', 'shared', 'NEEDS_REVIEW', null],
    ['a point in no polygon at all', 'nowhere', 'UNMAPPED', null],
    ['a point outside Vietnam entirely', 'invalid', 'UNMAPPED', null],
  ] as const)('resolves %s', async (_case, kind, status, confidence) => {
    const geom =
      kind === 'inside'
        ? await insidePoint('00004').then((p) => ({ x: p.lng, y: p.lat }))
        : kind === 'shared'
          ? await sharedEdgePoint().then((p) => ({ x: p.lng, y: p.lat }))
          : kind === 'nowhere'
            ? { x: 106.7, y: 10.77 }
            : { x: 0, y: 0 };
    const place = await insertPlace({ geom });

    await backfill.run({ dryRun: false });
    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe(status);
    expect(after.administrativeMappingConfidence).toBe(confidence);
  });

  it('carries a unique edge match with no confidence', async () => {
    const [edge] = await rows<{ lng: number; lat: number }>(sql`
      select st_x(p) as lng, st_y(p) as lat from (
        select st_pointonsurface(st_boundary(geom)) as p from administrative_unit_boundaries
        where boundary_version = ${BOUNDARY_VERSION} and code = '20333') s`);
    const place = await insertPlace({ geom: { x: edge!.lng, y: edge!.lat } });

    await backfill.run({ dryRun: false });
    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('AUTO_MATCHED');
    expect(after.communeCode).toBe('20333');
    expect(after.administrativeMappingConfidence).toBeNull();
  });
});

describe('eligibility', () => {
  it('never touches a VERIFIED place, and counts it as protected', async () => {
    const inside = await insidePoint('00004');
    const place = await insertPlace({
      geom: { x: inside.lng, y: inside.lat },
      communeCode: '00025',
      provinceCode: '01',
      administrativeMappingStatus: 'VERIFIED',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: 'v-older',
    });
    const before = await placeRow(place.id);

    const result = await backfill.run({ dryRun: false });
    // Not selected at all: the eligibility query excludes VERIFIED, so the row
    // never reaches the resolver and never reaches the protected counter either.
    expect(result.counters.eligible).toBe(0);
    const after = await placeRow(place.id);
    expect(after.communeCode).toBe('00025');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('never reopens a REJECTED place, by any route this job has', async () => {
    // ADM-006 can reopen a rejection under an explicit authorised rematch, and
    // this job has no way to authorise one: every CLI-originated audit row in
    // this repository is written as `system` with a null actor id, because no
    // command authenticates anybody. A bulk switch that reopened reviewers'
    // rejections while recording "system" as who asked would be worse than no
    // switch, so there is none — rematch is #462's, where a reviewer exists.
    const inside = await insidePoint('00004');
    const place = await insertPlace({
      geom: { x: inside.lng, y: inside.lat },
      administrativeMappingStatus: 'REJECTED',
      administrativeDatasetVersion: 'v-older',
    });

    expect((await backfill.run({ dryRun: false })).counters.eligible).toBe(0);
    // Named explicitly, which is the one route that could plausibly slip past
    // a status filter applied only to the broad scan.
    const targeted = await backfill.run({ dryRun: false, placeIds: [place.id] });
    expect(targeted.counters.eligible).toBe(0);
    expect(targeted.counters.written).toBe(0);

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('REJECTED');
    expect(after.communeCode).toBeNull();
  });

  it('skips a place already resolved against these exact versions', async () => {
    const inside = await insidePoint('00004');
    await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    await backfill.run({ dryRun: false });

    // A second run over a catalogue with no work in it must not be a full pass
    // over every row: the version predicate excludes it from selection.
    const second = await backfill.run({ dryRun: false });
    expect(second.counters.scanned).toBe(0);
    expect(second.counters.eligible).toBe(0);
    expect(second.counters.alreadyCurrent).toBe(1);
  });

  it('evaluates a place mapped against an older version', async () => {
    const inside = await insidePoint('00004');
    const place = await insertPlace({
      geom: { x: inside.lng, y: inside.lat },
      communeCode: '00008',
      provinceCode: '01',
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'exact_name',
      administrativeDatasetVersion: 'v-older',
    });
    const result = await backfill.run({ dryRun: false });
    expect(result.counters.eligible).toBe(1);
    expect(result.counters.written).toBe(1);
    expect((await placeRow(place.id)).communeCode).toBe('00004');
  });

  it('processes only the places it was given', async () => {
    const inside = await insidePoint('00004');
    const targeted = await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const other = await insertPlace({ geom: { x: inside.lng, y: inside.lat } });

    const result = await backfill.run({ dryRun: false, placeIds: [targeted.id] });
    expect(result.counters.written).toBe(1);
    expect((await placeRow(targeted.id)).communeCode).toBe('00004');
    expect((await placeRow(other.id)).administrativeMappingStatus).toBe('UNMAPPED');
  });
});

describe('batching, checkpoints and resume', () => {
  it('stops at its row cap and records where it got to', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 5; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });

    const capped = await backfill.run({ dryRun: false, batchSize: 2, maxRows: 2 });
    expect(capped.counters.written).toBe(2);
    expect(capped.cursor).not.toBeNull();

    const [run] = await db.select().from(schema.administrativeBackfillRuns);
    expect(run!.cursor).toBe(capped.cursor);
    expect((run!.counters as { written: number }).written).toBe(2);
  });

  it('resumes strictly after its cursor, repeating nothing', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 5; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });

    const first = await backfill.run({ dryRun: false, batchSize: 2, maxRows: 2 });
    const written = await db
      .select({ id: schema.places.id, updatedAt: schema.places.updatedAt })
      .from(schema.places)
      .where(eq(schema.places.administrativeMappingStatus, 'AUTO_MATCHED'));

    const resumed = await backfill.run({ dryRun: false, resumeRunId: first.runId });
    expect(resumed.counters.written).toBe(5);
    expect(resumed.runId).toBe(first.runId);

    // The two already written were not touched again — both because the cursor
    // is past them and because they now carry the current versions.
    for (const row of written) {
      expect((await placeRow(row.id)).updatedAt.getTime()).toBe(row.updatedAt.getTime());
    }
    expect(
      (await db.select().from(schema.places).where(eq(schema.places.communeCode, '00004'))).length,
    ).toBe(5);
  });

  it('keeps earlier committed batches when a later one fails', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 3; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });

    const good = await backfill.run({ dryRun: false, batchSize: 1, maxRows: 1 });
    expect(good.counters.written).toBe(1);

    // An actor id the audit column cannot store. Every remaining place fails at
    // its own write and the run itself fails when it tries to write its summary
    // — and none of that takes the batch that already committed with it.
    await expect(
      backfill.run({
        dryRun: false,
        resumeRunId: good.runId,
        actor: { id: 'not-a-uuid', type: 'admin' },
      }),
    ).rejects.toThrow();

    expect(
      (await db.select().from(schema.places).where(eq(schema.places.communeCode, '00004'))).length,
    ).toBe(1);
    const [run] = await db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, good.runId));
    expect(run!.status).toBe('failed');
    expect((run!.counters as { failures: number }).failures).toBe(2);
    expect((run!.failures as { placeId: string }[]).length).toBe(2);

    // And the failures are retryable by name rather than by re-walking.
    const retried = await backfill.run({
      dryRun: false,
      resumeRunId: good.runId,
      retry: 'failures',
    });
    // Cumulative, because they belong to the run rather than to the attempt:
    // one written before the failure plus the two the retry recovered.
    expect(retried.counters.written).toBe(3);
    expect(
      (await db.select().from(schema.places).where(eq(schema.places.communeCode, '00004'))).length,
    ).toBe(3);
  });

  it('is idempotent: a completed scope re-run writes nothing material', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 3; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    await backfill.run({ dryRun: false });
    const snapshot = await db
      .select({ id: schema.places.id, updatedAt: schema.places.updatedAt })
      .from(schema.places)
      .orderBy(schema.places.id);

    const again = await backfill.run({ dryRun: false });
    expect(again.counters.written).toBe(0);
    expect(again.counters.eligible).toBe(0);
    for (const row of snapshot) {
      expect((await placeRow(row.id)).updatedAt.getTime()).toBe(row.updatedAt.getTime());
    }
  });
});

describe('version pinning', () => {
  it('records the dataset and boundary versions it started against', async () => {
    await insertPlace();
    const result = await backfill.run();
    expect(result.datasetVersion).toBe(datasetVersion);
    expect(result.boundaryVersion).toBe(BOUNDARY_VERSION);

    const [run] = await db.select().from(schema.administrativeBackfillRuns);
    expect(run).toMatchObject({
      pinnedDatasetVersion: datasetVersion,
      pinnedBoundaryVersion: BOUNDARY_VERSION,
      datasetVersionId: datasetId,
    });
  });

  it('stops rather than mixing versions when the active one moves', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 4; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const first = await backfill.run({ dryRun: false, batchSize: 1, maxRows: 1 });
    expect(first.counters.written).toBe(1);

    // An operator loads a new boundary release and points the dataset at it.
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: 'some-newer-release' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));

    const resumed = await backfill.run({ dryRun: false, resumeRunId: first.runId });
    expect(resumed.status).toBe('stopped_version_changed');
    expect(resumed.counters.written).toBe(1);
    // Half a catalogue against one boundary release and half against another is
    // the failure that would be invisible afterwards: every row looks right.
    expect(
      (await db.select().from(schema.places).where(eq(schema.places.communeCode, '00004'))).length,
    ).toBe(1);

    // The old polygons are still sitting in PostgreSQL and still queryable —
    // that is not authorisation. What decides is which version the published
    // dataset points at, not what happens to remain loaded.
    const stillLoaded = await rows<{ n: number }>(
      sql`select count(*)::int as n from administrative_unit_boundaries
          where boundary_version = ${BOUNDARY_VERSION}`,
    );
    expect(stillLoaded[0]!.n).toBeGreaterThan(0);

    // Resuming again while the versions still differ stops again, writes
    // nothing, and leaves the cursor and counters exactly where they were.
    const [before] = await db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, first.runId));
    const again = await backfill.run({ dryRun: false, resumeRunId: first.runId });
    expect(again.status).toBe('stopped_version_changed');
    expect(again.counters.written).toBe(1);
    const [after] = await db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, first.runId));
    expect(after!.cursor).toBe(before!.cursor);
    expect(after!.counters).toEqual(before!.counters);
    expect(after!.pinnedDatasetVersion).toBe(before!.pinnedDatasetVersion);
    expect(after!.pinnedBoundaryVersion).toBe(before!.pinnedBoundaryVersion);
    expect(
      (await db.select().from(schema.places).where(eq(schema.places.communeCode, '00004'))).length,
    ).toBe(1);

    // A rollback that makes the exact recorded versions active again is the one
    // recovery that lets the run continue.
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: BOUNDARY_VERSION })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    const finished = await backfill.run({ dryRun: false, resumeRunId: first.runId });
    expect(finished.status).toBe('completed');
    expect(finished.counters.written).toBe(4);
  });

  it('never stamps a place with a version that is not active', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 3; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const stopped = await backfill.run({ dryRun: false, batchSize: 1, maxRows: 1 });

    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: 'some-newer-release' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    await backfill.run({ dryRun: false, resumeRunId: stopped.runId });

    const stamped = await db
      .select({
        dataset: schema.places.administrativeDatasetVersion,
        boundary: schema.places.administrativeBoundaryVersion,
      })
      .from(schema.places)
      .where(eq(schema.places.administrativeMappingStatus, 'AUTO_MATCHED'));
    // Exactly the one written while the pin was active, and it carries that pin.
    expect(stamped).toEqual([{ dataset: datasetVersion, boundary: BOUNDARY_VERSION }]);

    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: BOUNDARY_VERSION })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  });

  it('abandons a run that will not be resumed, and refuses to resume it', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 2; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const stopped = await backfill.run({ dryRun: false, batchSize: 1, maxRows: 1 });

    await backfill.abandon(stopped.runId, 'boundaries moved to a newer release');
    const [row] = await db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, stopped.runId));
    expect(row!.status).toBe('abandoned');
    expect(row!.failureReason).toBe('boundaries moved to a newer release');
    // The pins stay on the record: what the run was bound to is the point of it.
    expect(row!.pinnedDatasetVersion).toBe(datasetVersion);

    await expect(backfill.run({ dryRun: false, resumeRunId: stopped.runId })).rejects.toThrow(
      /abandoned/,
    );
    await expect(backfill.abandon(stopped.runId, '  ')).rejects.toThrow(/reason/);
    expect(await auditRows('administrative_backfill.abandon')).toHaveLength(1);
  });

  it('starts a new run against the versions that are active now', async () => {
    const inside = await insidePoint('00004');
    await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    const old = await backfill.run({ dryRun: false, batchSize: 1, maxRows: 1 });

    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: 'some-newer-release' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    await backfill.abandon(old.runId, 'superseded by a newer boundary release');

    // A new run pins the new versions and re-evaluates: the place written under
    // the old boundary version is eligible again, because its stamp no longer
    // matches what is active.
    const fresh = await backfill.run();
    expect(fresh.runId).not.toBe(old.runId);
    expect(fresh.boundaryVersion).toBe('some-newer-release');
    expect(fresh.counters.eligible).toBe(1);

    const [oldRow] = await db
      .select()
      .from(schema.administrativeBackfillRuns)
      .where(eq(schema.administrativeBackfillRuns.id, old.runId));
    expect(oldRow!.pinnedBoundaryVersion).toBe(BOUNDARY_VERSION);

    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: BOUNDARY_VERSION })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  });
});

describe('concurrency', () => {
  it('turns a place edited under the run into a conflict, never an overwrite', async () => {
    const inside = await insidePoint('00004');
    for (let i = 0; i < 20; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });

    // Two runs over the same scope. Both select rows carrying the same
    // `updated_at`; whichever writes first makes the other's expectation stale.
    const [a, b] = await Promise.all([
      backfill.run({ dryRun: false, batchSize: 20 }),
      backfill.run({ dryRun: false, batchSize: 20 }),
    ]);

    expect(a.counters.conflicts + b.counters.conflicts).toBeGreaterThan(0);
    // Every place ends up written exactly once, whichever run got there.
    const mapped = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.communeCode, '00004'));
    expect(mapped).toHaveLength(20);
    const audits = await auditRows('administrative_mapping.resolve');
    expect(audits).toHaveLength(20);
  });
});

describe('audit', () => {
  it('writes one run-level row, and one per material place write', async () => {
    const inside = await insidePoint('00004');
    await insertPlace({ geom: { x: inside.lng, y: inside.lat } });
    await insertPlace({ geom: { x: 106.7, y: 10.77 } });

    const result = await backfill.run({ dryRun: false });
    const runAudits = await auditRows('administrative_backfill.run');
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]!.resourceId).toBe(result.runId);
    expect(runAudits[0]!.diff).toMatchObject({
      dryRun: false,
      datasetVersion,
      boundaryVersion: BOUNDARY_VERSION,
    });

    // The unmapped place resolved to UNMAPPED and it was already UNMAPPED, so
    // nothing was written and nothing was audited: a no-op leaves no trace, or
    // a nightly pass would fill the log with news of nothing happening.
    const placeAudits = await auditRows('administrative_mapping.resolve');
    expect(placeAudits).toHaveLength(1);
    expect((placeAudits[0]!.diff as { runId: string }).runId).toBe(result.runId);
  });

  it('audits a dry run as a dry run, with no per-place rows at all', async () => {
    await insertPlace({ geom: await insidePoint('00004').then((p) => ({ x: p.lng, y: p.lat })) });
    const result = await backfill.run();
    const audits = await auditRows('administrative_backfill.dry_run');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.resourceId).toBe(result.runId);
    expect((audits[0]!.diff as { counters: { wouldWrite: number } }).counters.wouldWrite).toBe(1);
    expect(await auditRows('administrative_mapping.resolve')).toEqual([]);
  });
});

describe('selection cost', () => {
  it('walks the primary key rather than sorting the catalogue', async () => {
    // Two thousand rows, because the shape of the plan is the question and at
    // fifty rows PostgreSQL sensibly sorts whatever it finds. Geometry is
    // irrelevant here — this measures selection, not resolution.
    await db.execute(sql`
      insert into places (name, name_normalized, geom)
      select 'bulk' || g, 'bulk' || g, st_setsrid(st_makepoint(105.82, 21.04), 4326)
      from generate_series(1, 2000) g`);
    await db.execute(sql`analyze places`);

    const [first] = await db
      .select({ id: schema.places.id })
      .from(schema.places)
      .orderBy(schema.places.id)
      .limit(1);

    // The cursor form: every batch after the first, and the one that has to
    // stay bounded however large the catalogue grows.
    const plan = await rows<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(sql`
      explain (analyze, format json)
      select p.id, p.updated_at, p.administrative_mapping_status
      from places p
      where p.id > ${first!.id}
        and p.administrative_mapping_status <> 'VERIFIED'
        and p.administrative_mapping_status <> 'REJECTED'
        and (p.administrative_dataset_version is distinct from ${datasetVersion}
             or p.administrative_boundary_version is distinct from ${BOUNDARY_VERSION})
      order by p.id limit 200`);
    const root = plan[0]!['QUERY PLAN'][0]!.Plan;
    const nodes = flatten(root).map((n) => n['Node Type']);

    // An index walk, not a sort of the table: the batch is bounded and the rows
    // arrive already ordered.
    expect(nodes).toContain('Index Scan');
    expect(nodes).not.toContain('Sort');
    expect(root['Actual Rows']).toBeLessThanOrEqual(200);
    process.stdout.write(
      `\n[ADM-008] cursor batch plan ${nodes.join(' <- ')} rows=${root['Actual Rows']} ` +
        `time=${root['Actual Total Time']}ms\n`,
    );
  }, 120_000);

  it('does not load the administrative snapshot once per place', async () => {
    // The resolver answers from targeted indexed lookups, so enriching 50
    // places does not mean building 50 copies of a 14,000-unit index. Measured
    // as throughput rather than asserted structurally.
    const inside = await insidePoint('00004');
    for (let i = 0; i < 50; i += 1) await insertPlace({ geom: { x: inside.lng, y: inside.lat } });

    const started = Date.now();
    const outcome = await backfill.run({ dryRun: false, batchSize: 25 });
    const elapsed = Date.now() - started;
    expect(outcome.counters.written).toBe(50);
    process.stdout.write(
      `\n[ADM-008] ${outcome.counters.written} places in ${elapsed}ms ` +
        `(${(elapsed / outcome.counters.written).toFixed(1)}ms/place, ` +
        `${((outcome.counters.written / elapsed) * 1000).toFixed(0)}/s)\n`,
    );
  }, 120_000);
});

type PlanNode = {
  'Node Type': string;
  'Actual Rows': number;
  'Actual Total Time': number;
  Plans?: PlanNode[];
};

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

async function metricCount(metric: string, contains?: string): Promise<number> {
  // `/v1/metrics`, not `/metrics`: the app sets a global `v1` prefix, and an
  // earlier version of this helper asked for the unprefixed path, got a 404 and
  // returned 0 — so every "the provider counter did not move" assertion built
  // on it was comparing zero to zero. It throws now rather than answering 0,
  // because a scrape that cannot be read is not evidence of anything.
  const metrics = await api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  if (metrics.statusCode !== 200) {
    throw new Error(
      `metrics scrape failed with ${metrics.statusCode}; the assertion would be vacuous`,
    );
  }
  return metrics.body
    .split('\n')
    .filter((line) => line.startsWith(metric) && (!contains || line.includes(contains)))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
