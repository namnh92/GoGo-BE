import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  COST_REGISTRY,
  CollectorSchedulerService,
  DbUsageLedger,
  freshnessStatus,
  ledgerFreshnessCollector,
  type CollectorDefinition,
} from '@gogo/modules';

/**
 * COST-BE-017 (#369) — the collector scheduler against a real Postgres.
 *
 * What only a database can prove: the freshness upsert's SQL (including the
 * failure path's CASE that keeps FRESH/UNAVAILABLE apart from stored facts),
 * `maxCallsPerDay` surviving a restart, and the cost-of-cost row landing in
 * `provider_cost_daily` under the internal provider through the same
 * COALESCE unique key as every other cost row.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';

type FreshRow = {
  source_id: string;
  provider_id: string;
  status: string;
  last_successful_at: Date | null;
  last_attempt_at: Date | null;
  source_as_of: Date | null;
  consecutive_failures: number;
  last_error_code: string | null;
  calls_count: number;
};

async function freshRows(): Promise<FreshRow[]> {
  const { rows } = await db.execute(sql`
    select source_id, provider_id, status, last_successful_at, last_attempt_at, source_as_of,
           consecutive_failures, last_error_code, calls_count
    from cost_source_freshness where environment = ${ENV} order by source_id
  `);
  return rows as unknown as FreshRow[];
}

function paidCollector(over: Partial<CollectorDefinition> & { id: string }): CollectorDefinition {
  return {
    providerId: 'google',
    serviceId: 'google.places',
    capability: 'USAGE_COLLECTOR',
    frequencyMs: 1,
    staleAfterMs: 60 * 60 * 1000,
    timeoutMs: 2_000,
    retry: { maxAttemptsPerTick: 1 },
    maxCallsPerDay: 2,
    enabledEnvironments: 'all',
    essential: false,
    monitoringCost: {
      model: 'PER_REQUEST',
      estimatedMonthlyMicros: 300_000,
      currency: 'USD',
      expectedRequestsPerMonth: 30,
      pricingSource: 'test',
      lastPricingReview: '2026-09-02',
    },
    run: async () => ({ sourceAsOf: null, samples: 1 }),
    ...over,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_collectors_test')
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
  await db.execute(sql`delete from cost_source_freshness`);
  await db.execute(sql`delete from provider_cost_daily`);
  await db.execute(sql`delete from provider_usage_daily`);
  await db.execute(sql`delete from provider_usage_meter_daily`);
});

describe('ledger freshness collector (epic §23)', () => {
  it('records a FRESH row whose sourceAsOf is the newest ledger write', async () => {
    const ledger = new DbUsageLedger(db as never, { environment: ENV });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.liveness',
      status: '200',
    });
    await ledger.stop();

    const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
      environment: ENV,
    }).register(ledgerFreshnessCollector(db as never));
    const report = await s.tick();
    expect(report.results).toEqual([{ collector: 'ledger', outcome: 'ok', samples: 1 }]);
    const [row] = await freshRows();
    expect(row).toMatchObject({
      source_id: 'ledger',
      provider_id: 'google',
      status: 'FRESH',
      consecutive_failures: 0,
    });
    expect(row!.source_as_of).not.toBeNull();
    // The derived status agrees with the stored one right now.
    expect(
      freshnessStatus(
        {
          // pg hands timestamptz back as a string through raw `execute`.
          lastSuccessfulAt: new Date(row!.last_successful_at as unknown as string),
          lastAttemptAt: new Date(row!.last_attempt_at as unknown as string),
          staleAfterMs: 24 * 60 * 60 * 1000,
          consecutiveFailures: 0,
        },
        new Date(),
      ),
    ).toBe('FRESH');
  });

  it('a measured zero is a success with samples 0, not an UNKNOWN', async () => {
    const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
      environment: ENV,
    }).register(ledgerFreshnessCollector(db as never));
    const report = await s.tick();
    expect(report.results).toEqual([{ collector: 'ledger', outcome: 'ok', samples: 0 }]);
    const [row] = await freshRows();
    expect(row?.status).toBe('FRESH');
    expect(row?.source_as_of).toBeNull();
  });
});

describe('failure path and daily cap (epic §22, §38)', () => {
  it('keeps FRESH inside the window after a failure, then UNAVAILABLE once the window passes', async () => {
    let fail = false;
    const def = paidCollector({
      id: 'flappy',
      maxCallsPerDay: null,
      staleAfterMs: 60 * 60 * 1000,
      run: async () => {
        if (fail) throw Object.assign(new Error('nope'), { code: 'PROVIDER_503' });
        return { sourceAsOf: null, samples: 1 };
      },
    });
    const at = (t: string) =>
      new CollectorSchedulerService(db as never, COST_REGISTRY, {
        environment: ENV,
        now: () => new Date(t),
      }).register(def);

    await at('2026-09-02T12:00:00Z').tick();
    fail = true;
    await at('2026-09-02T12:30:00Z').tick();
    let [row] = await freshRows();
    expect(row).toMatchObject({
      status: 'FRESH',
      consecutive_failures: 1,
      last_error_code: 'PROVIDER_503',
    });

    // Backoff: not due at +1 ms, due at +2 × frequency… frequency is 1 ms here,
    // so a later clock is enough. Past the trust window, the failure reads UNAVAILABLE.
    await at('2026-09-02T14:00:00Z').tick();
    [row] = await freshRows();
    expect(row).toMatchObject({ status: 'UNAVAILABLE', consecutive_failures: 2 });
    expect(row!.last_successful_at).not.toBeNull();
  });

  it('enforces maxCallsPerDay across scheduler instances (a restart does not reset it)', async () => {
    const def = paidCollector({ id: 'capped' });
    const mk = (offsetMs: number) =>
      new CollectorSchedulerService(db as never, COST_REGISTRY, {
        environment: ENV,
        now: () => new Date(Date.UTC(2026, 8, 2, 12, 0, 0, offsetMs)),
      }).register(def);
    expect((await mk(0).tick()).results[0]?.outcome).toBe('ok');
    expect((await mk(10).tick()).results[0]?.outcome).toBe('ok');
    expect((await mk(20).tick()).results[0]?.outcome).toBe('skipped_calls_cap');
    const [row] = await freshRows();
    expect(row?.calls_count).toBe(2);
  });
});

describe('cost of cost (epic §20–§21)', () => {
  it('writes the internal provider FIXED row from declared monitoring costs, idempotently', async () => {
    const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: () => new Date('2026-09-02T12:00:00Z'),
    })
      .register(ledgerFreshnessCollector(db as never))
      .register(paidCollector({ id: 'aws_ce', maxCallsPerDay: null }));
    await s.writeMonitoringCostRow();
    await s.writeMonitoringCostRow();
    const { rows } = await db.execute(sql`
      select provider_id, service_id, amount_micros, basis, confidence, source, metadata
      from provider_cost_daily where environment = ${ENV}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_id: 'gogo',
      service_id: 'gogo.cost_observability',
      basis: 'FIXED',
      confidence: 'HIGH',
      source: 'monitoring_cost_model',
    });
    // 300,000 micros/month over September's 30 days → 10,000 a day.
    expect(Number((rows[0] as { amount_micros: number | string }).amount_micros)).toBe(10_000);
    expect((rows[0] as { metadata: { collectors: string[] } }).metadata.collectors).toEqual([
      'ledger',
      'aws_ce',
    ]);
  });

  it('pauses the paid collector over budget and keeps the FREE essential one running', async () => {
    const paid = paidCollector({
      id: 'aws_ce',
      maxCallsPerDay: null,
      monitoringCost: {
        model: 'PER_REQUEST',
        estimatedMonthlyMicros: 2_000_000,
        currency: 'USD',
        expectedRequestsPerMonth: 60,
        pricingSource: 't',
        lastPricingReview: '2026-09-02',
      },
    });
    const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
      environment: ENV,
      monitoringBudgetMicros: 1_000_000,
    })
      .register(ledgerFreshnessCollector(db as never))
      .register(paid);
    const report = await s.tick();
    expect(report.monitoring.overBudget).toBe(true);
    expect(report.results).toEqual([
      { collector: 'ledger', outcome: 'ok', samples: 0 },
      { collector: 'aws_ce', outcome: 'skipped_budget' },
    ]);
  });
});
