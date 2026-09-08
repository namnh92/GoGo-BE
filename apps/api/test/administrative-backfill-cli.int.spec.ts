import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';

/**
 * #491 — `pnpm admin:backfill` must actually run.
 *
 * It did not. The CLI built its metrics port as `new LogMetrics()`, with no
 * argument; LogMetrics needs an AppLogger for every method it has, so the first
 * metric the run emitted threw `Cannot read properties of undefined (reading
 * 'info')`. Every unit and integration test around the backfill passed, because
 * they all construct the service themselves with a metrics double. Nothing ran
 * the file a person runs.
 *
 * The metrics only fire after the run has talked to the database, so no test
 * without a database can tell the broken wiring from the fixed one — a boot that
 * stops at `DATABASE_URL is required` gets there either way. That is why this is
 * an integration test and not a unit smoke: it runs `pnpm admin:backfill` itself
 * against a real published dataset and lets it complete a dry run.
 *
 * The same invocation covers the second half of the same defect: the script ran
 * under `tsx`, which resolves a tsconfig per file by walking up from that file,
 * and with no tsconfig.json at the repository root every decorated class under
 * libs/ failed to transform. The command could not start at all.
 */

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(ROOT, 'resources/administrative/boundaries-fixture.v5.0.0.zip');
const BOUNDARY_VERSION = 'fixture-v5.0.0';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let connectionString: string;

/** Runs the command the runbook names, and never throws on exit 1. */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('pnpm', ['--silent', 'admin:backfill', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: connectionString },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function insidePoint(code: string): Promise<{ lng: number; lat: number }> {
  const result = await db.execute(sql`
    select st_x(p) as lng, st_y(p) as lat from (
      select st_pointonsurface(geom) as p from administrative_unit_boundaries
      where boundary_version = ${BOUNDARY_VERSION} and code = ${code}) s`);
  return (result as unknown as { rows: { lng: number; lat: number }[] }).rows[0]!;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_backfill_cli_test')
    .start();
  connectionString = container.getConnectionUri();

  pool = new Pool({ connectionString, max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(ROOT, 'migrations') });

  // #489 — an import binds the boundary release that is loaded, so one must be
  // loaded before the dataset is imported. Both use the committed five-entry
  // fixture: real, unmodified geometry from the pinned archive, no network.
  await new AdministrativeBoundaryImportService(db as never).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: FIXTURE,
  });

  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, report.datasetVersionId));

  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: BOUNDARY_VERSION,
    archivePath: FIXTURE,
  });
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
  await db.execute(sql`truncate table administrative_backfill_runs cascade`);
  await db.execute(sql`delete from audit_logs`);
});

describe('pnpm admin:backfill', () => {
  it('completes a dry run over a real place, emitting its metrics', async () => {
    const inside = await insidePoint('00004');
    await db.insert(schema.places).values({
      name: 'Quán Thử',
      nameNormalized: 'quan thu',
      geom: { x: inside.lng, y: inside.lat },
      addressText: '12 Phan Đình Phùng',
    });

    const { code, stdout, stderr } = runCli([]);

    // The failure the CLI had, named so a regression reads as itself rather
    // than as a summary line that went missing.
    expect(stderr).not.toContain("Cannot read properties of undefined (reading 'info')");
    expect(code).toBe(0);
    expect(stdout).toContain('DRY RUN completed');
    expect(stdout).toMatch(/scanned\s+1\s+eligible 1/);

    // The run reached its own end: the summary row is written after the last
    // metric the broken wiring died on.
    const [run] = await db.select().from(schema.administrativeBackfillRuns);
    expect(run?.status).toBe('completed');
    expect(run?.dryRun).toBe(true);
  }, 300_000);

  it('writes nothing without --execute', async () => {
    const inside = await insidePoint('00004');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Quán Thử',
        nameNormalized: 'quan thu',
        geom: { x: inside.lng, y: inside.lat },
        addressText: '12 Phan Đình Phùng',
      })
      .returning();

    const { code, stdout } = runCli([]);
    expect(code).toBe(0);
    expect(stdout).toContain('DRY RUN');

    const [after] = await db.select().from(schema.places).where(eq(schema.places.id, place!.id));
    expect(after?.administrativeMappingStatus).toBe('UNMAPPED');
    expect(after?.communeCode).toBeNull();
  }, 300_000);

  it('fails with a message, not a stack, when no dataset is published', async () => {
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'STAGED' })
      .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'));
    try {
      const { code, stderr } = runCli([]);
      expect(code).toBe(1);
      expect(stderr).toContain('no administrative dataset is published');
      expect(stderr).not.toContain("Cannot read properties of undefined (reading 'info')");
    } finally {
      await db
        .update(schema.administrativeDatasetVersions)
        .set({ status: 'PUBLISHED' })
        .where(eq(schema.administrativeDatasetVersions.status, 'STAGED'));
    }
  }, 300_000);
});
