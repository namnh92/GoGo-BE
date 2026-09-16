import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/**
 * #493 — `pnpm db:boundaries` must actually run.
 *
 * It did not. The script ran under `tsx`, which resolves a tsconfig per file
 * by walking up from that file; with no tsconfig.json at the repository root
 * every decorated class under libs/ transformed with `experimentalDecorators`
 * off, and the command died in esbuild before a line of its own code ran:
 *
 *   Transform failed with 2 errors: Parameter decorators only work when
 *   experimental decorators are enabled
 *
 * Every test around the loader passed, because every one of them constructs
 * `AdministrativeBoundaryImportService` itself. Nothing ran the file a person
 * runs. This does — through `pnpm db:boundaries`, never the file directly,
 * because invoking it under a different runner is exactly what hid the defect.
 *
 * The committed fixture is used so no network is needed, and no dataset is
 * imported first: since #489 the loader checks boundary codes against the
 * pinned units snapshot, not against a published dataset.
 */

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(ROOT, 'resources/administrative/boundaries-fixture.v5.0.0.zip');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let connectionString: string;

/** Runs the command the runbook names, and never throws on exit 1. */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('pnpm', ['--silent', 'db:boundaries', ...args], {
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_boundaries_cli_test')
    .start();
  connectionString = container.getConnectionUri();
  pool = new Pool({ connectionString, max: 2 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(ROOT, 'migrations') });
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('pnpm db:boundaries', () => {
  it('starts, loads the committed fixture, and writes the ledger', async () => {
    const { code, stdout, stderr } = runCli([
      '--role',
      'boundaries-fixture',
      '--version',
      'fixture-v1',
      '--archive',
      FIXTURE,
    ]);

    // The failure the CLI had, named so a regression reads as itself rather
    // than as a summary line that went missing.
    expect(stderr).not.toContain('Parameter decorators only work');
    expect(stderr).not.toContain('Transform failed');
    expect(code).toBe(0);
    expect(stdout).toContain('loaded: fixture-v1');
    expect(stdout).toMatch(/loaded\s+2 provinces, 3 communes/);

    // The run reached its own end: the ledger row is the last thing written.
    const [load] = await db.select().from(schema.administrativeBoundaryLoads);
    expect(load?.boundaryVersion).toBe('fixture-v1');
    expect(load?.provinceCount).toBe(2);
    expect(load?.communeCount).toBe(3);
  }, 300_000);

  it('is idempotent: a second run against the same archive writes nothing', async () => {
    const { code, stdout } = runCli([
      '--role',
      'boundaries-fixture',
      '--version',
      'fixture-v1',
      '--archive',
      FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('unchanged: fixture-v1');
    const loads = await db.select().from(schema.administrativeBoundaryLoads);
    expect(loads).toHaveLength(1);
  }, 300_000);
});
