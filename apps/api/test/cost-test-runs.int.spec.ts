import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { DbUsageLedger, TestCostService } from '@gogo/modules';

/**
 * COST-BE-019 (#378) — test-run cost records against a real Postgres.
 *
 * What only a database can prove: the before-snapshot survives in the delta
 * rows while a run is open, `finish` rewrites them in one transaction, the
 * COALESCE key holds for meters that repeat across operations, and a provider
 * the code never named lands in the delta because the key is the table's.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';

async function ledgerWrite(operation: string, attempted: number, units: number) {
  const ledger = new DbUsageLedger(db as never, { environment: ENV });
  for (let i = 0; i < attempted; i += 1) {
    ledger.increment('places_provider_requests_total', { method: operation, status: '200' });
  }
  if (units > 0) {
    ledger.increment(
      'places_provider_cost_units',
      { sku: operation === 'google.routeMatrix' ? 'routes.computeRouteMatrix' : operation },
      units,
    );
  }
  await ledger.stop();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_test_runs_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  await db.execute(sql`delete from cost_test_runs`);
  await db.execute(sql`delete from provider_usage_daily`);
  await db.execute(sql`delete from provider_usage_meter_daily`);
});

describe('TestCostService (epic §28–§30)', () => {
  it('start → traffic → finish yields per-meter deltas, Routes as two meters, unknown price as null', async () => {
    await ledgerWrite('google.details.quality', 5, 5); // pre-existing usage
    const svc = new TestCostService(db as never);
    const id = await svc.start('bulk-import-smoke', {
      environment: ENV,
      gitSha: 'abc1234',
      budget: { maxProviderCalls: 100 },
    });

    // Open run: before-snapshot stored, status running.
    const open = await db.execute(sql`select status from cost_test_runs where id = ${id}`);
    expect((open.rows[0] as { status: string }).status).toBe('running');

    await ledgerWrite('google.details.quality', 3, 2); // 3 calls, 2 billed
    await ledgerWrite('google.routeMatrix', 1, 14);

    const result = await svc.finish(id);
    expect(result.status).toBe('ok');
    expect(
      result.deltas.map((d) => [
        d.operationId,
        d.usageMetricId,
        d.usageDelta,
        d.estimatedCostDelta,
        d.basis,
      ]),
    ).toEqual([
      ['google.details.quality', 'calls', 3, null, 'UNKNOWN'],
      ['google.details.quality', 'requests', 2, 40_000, 'ESTIMATED'],
      ['google.routeMatrix', 'billable_elements', 14, null, 'UNKNOWN'],
      ['google.routeMatrix', 'calls', 1, null, 'UNKNOWN'],
    ]);
    expect(result.estimatedCostMicros).toBe(40_000);
    expect(result.unpriced).toEqual(['google.routes/billable_elements']);

    const rows = await db.execute(sql`
      select usage_metric_id, usage_before, usage_after, usage_delta from cost_test_run_deltas
      where test_run_id = ${id} order by operation_id, usage_metric_id
    `);
    expect(
      rows.rows.map((r) => [
        (r as { usage_metric_id: string }).usage_metric_id,
        Number((r as { usage_before: number }).usage_before),
        Number((r as { usage_after: number }).usage_after),
      ]),
    ).toEqual([
      ['calls', 5, 8],
      ['requests', 5, 7],
      ['billable_elements', 0, 14],
      ['calls', 0, 1],
    ]);
    const run = await db.execute(
      sql`select status, ended_at, git_sha from cost_test_runs where id = ${id}`,
    );
    expect(run.rows[0]).toMatchObject({ status: 'ok', git_sha: 'abc1234' });
    expect((run.rows[0] as { ended_at: unknown }).ended_at).not.toBeNull();
  });

  it('marks over_budget without throwing, and scopes deltas to declared services', async () => {
    const svc = new TestCostService(db as never);
    const id = await svc.start('scoped', {
      environment: ENV,
      services: ['google.routes'],
      budget: { maxProviderCalls: 0 },
    });
    await ledgerWrite('google.details.quality', 2, 2);
    await ledgerWrite('google.routeMatrix', 1, 3);
    const result = await svc.finish(id);
    expect(result.status).toBe('over_budget');
    expect(result.budgetViolations).toEqual(['provider calls 1 > 0']);
    expect(result.deltas.map((d) => d.serviceId)).toEqual(['google.routes', 'google.routes']);
  });

  it('a provider the code never named appears in the delta (§44.17)', async () => {
    const svc = new TestCostService(db as never);
    const id = await svc.start('foreign', { environment: ENV });
    await db.execute(sql`
      insert into provider_usage_meter_daily
        (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id, quantity, unit, source, confidence)
      values (current_date, ${ENV}, 'upstash', 'upstash.redis', null, 'commands', null, 4200, 'command', 'upstash_api', 'HIGH')
    `);
    const result = await svc.finish(id);
    expect(result.deltas).toEqual([
      expect.objectContaining({
        providerId: 'upstash',
        serviceId: 'upstash.redis',
        operationId: null,
        usageMetricId: 'commands',
        usageDelta: 4_200,
        estimatedCostDelta: null,
      }),
    ]);
  });

  it('fail() closes a run that never finished', async () => {
    const svc = new TestCostService(db as never);
    const id = await svc.start('crashed', { environment: ENV });
    await svc.fail(id, 'harness threw');
    const run = await db.execute(sql`select status, notes from cost_test_runs where id = ${id}`);
    expect(run.rows[0]).toMatchObject({ status: 'failed', notes: 'harness threw' });
  });
});
