import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import type {
  AwsCostExplorerPort,
  AwsServiceCost,
  GitHubBillingPort,
  GitHubUsageItem,
} from '@gogo/providers';
import {
  COST_REGISTRY,
  CollectorSchedulerService,
  CostCenterService,
  CostEstimatorService,
  ReconciliationService,
  awsCostExplorerCollector,
  githubActionsCollector,
} from '@gogo/modules';

/**
 * COST-BE-027 (#386) — both collectors against a real Postgres: AWS ACTUAL
 * rows land and replace, the calls cap of 1/day survives a fresh scheduler
 * (it lives in `cost_source_freshness`, not in memory), reconciliation stamps
 * the ESTIMATED twin and reports the variance, GitHub writes a minute meter
 * and an ACTUAL row from one report, and the monitoring-cost row includes the
 * paid AWS collector.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const ENV = 'dev';
const NOW = new Date('2026-09-03T06:00:00Z');

const awsCost = (over: Partial<AwsServiceCost> = {}): AwsServiceCost => ({
  day: '2026-09-02',
  service: 'AWS Systems Manager',
  unblendedMicros: 133_746,
  amortizedMicros: 133_746,
  currency: 'USD',
  estimated: false,
  ...over,
});

const ghItem = (over: Partial<GitHubUsageItem> = {}): GitHubUsageItem => ({
  day: '2026-09-02',
  product: 'actions',
  sku: 'Actions Linux',
  quantity: 380,
  unitType: 'minutes',
  pricePerUnit: 0.006,
  grossAmount: 2.28,
  discountAmount: 2.28,
  netAmount: 0,
  repositoryName: 'namnh92/GoGo-BE',
  organizationName: null,
  ...over,
});

type CostRow = {
  day: string;
  provider_id: string;
  service_id: string;
  billing_sku_id: string | null;
  billable_quantity: number | string | null;
  amount_micros: number | string;
  currency: string;
  basis: string;
  confidence: string;
  source: string;
  reconciled_at: Date | null;
  metadata: Record<string, unknown>;
};

async function costRows(providerId?: string): Promise<CostRow[]> {
  const { rows } = await db.execute(sql`
    select to_char(day, 'YYYY-MM-DD') as day, provider_id, service_id, billing_sku_id,
           billable_quantity, amount_micros, currency, basis, confidence, source,
           reconciled_at, metadata
    from provider_cost_daily
    where environment = ${ENV}
      and (${providerId ?? null}::text is null or provider_id = ${providerId ?? null})
    order by day, provider_id, service_id, basis
  `);
  return rows as unknown as CostRow[];
}

const brief = (rows: CostRow[]) =>
  rows.map((r) => [r.day, r.service_id, Number(r.amount_micros), r.basis, r.confidence]);

async function meterRows() {
  const { rows } = await db.execute(sql`
    select to_char(day, 'YYYY-MM-DD') as day, provider_id, usage_metric_id, billing_sku_id,
           quantity, unit, source, confidence, metadata
    from provider_usage_meter_daily
    where environment = ${ENV}
    order by day, usage_metric_id
  `);
  return rows as unknown as {
    day: string;
    provider_id: string;
    usage_metric_id: string;
    billing_sku_id: string | null;
    quantity: number | string;
    unit: string;
    source: string;
    confidence: string;
    metadata: Record<string, unknown>;
  }[];
}

async function freshRows() {
  const { rows } = await db.execute(sql`
    select source_id, provider_id, service_id, status, consecutive_failures, last_error_code,
           to_char(calls_day, 'YYYY-MM-DD') as calls_day, calls_count
    from cost_source_freshness where environment = ${ENV} order by source_id
  `);
  return rows as unknown as {
    source_id: string;
    provider_id: string;
    service_id: string | null;
    status: string;
    consecutive_failures: number;
    last_error_code: string | null;
    calls_day: string | null;
    calls_count: number;
  }[];
}

/** A fresh scheduler each time — nothing about a cap may live in memory. */
function awsScheduler(client: AwsCostExplorerPort, at: Date = NOW) {
  const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
    environment: ENV,
    now: () => at,
  });
  s.register(awsCostExplorerCollector(db as never, client, COST_REGISTRY, { now: () => at }));
  return s;
}

function githubScheduler(client: GitHubBillingPort, at: Date = NOW) {
  const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
    environment: ENV,
    now: () => at,
  });
  s.register(githubActionsCollector(db as never, client, { now: () => at }));
  return s;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_aws_github_test')
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
  await db.execute(sql`delete from provider_usage_meter_daily`);
});

describe('AWS Cost Explorer → ACTUAL rows (epic §26, §41-P2)', () => {
  it('writes one row per registry service and replaces on a re-read, never adds', async () => {
    let ssm = 133_746;
    const client: AwsCostExplorerPort = {
      costsByService: async () => [
        awsCost({ unblendedMicros: ssm }),
        awsCost({ service: 'Amazon Simple Storage Service', unblendedMicros: 39_160_330 }),
        awsCost({
          day: '2026-09-03',
          service: 'AWS Lambda',
          unblendedMicros: 1_000,
          estimated: true,
        }),
      ],
    };
    const report = await awsScheduler(client).tick();
    expect(report.results).toEqual([{ collector: 'aws_cost_explorer', outcome: 'ok', samples: 3 }]);

    let rows = await costRows('aws');
    expect(brief(rows)).toEqual([
      ['2026-09-02', 'aws.aggregate_billing', 39_160_330, 'ACTUAL', 'HIGH'],
      ['2026-09-02', 'aws.ssm', 133_746, 'ACTUAL', 'HIGH'],
      // AWS still calls this day estimated, so the row is MEDIUM — still ACTUAL.
      ['2026-09-03', 'aws.aggregate_billing', 1_000, 'ACTUAL', 'MEDIUM'],
    ]);
    for (const r of rows) expect(r).toMatchObject({ source: 'aws_cost_explorer', currency: 'USD' });
    expect(rows[1]!.metadata).toMatchObject({
      metric: 'UnblendedCost',
      awsServices: ['AWS Systems Manager'],
    });

    // AWS restates the day; the row is the restated figure, not a sum.
    ssm = 200_000;
    await awsScheduler(client, new Date('2026-09-04T06:00:00Z')).tick();
    rows = await costRows('aws');
    expect(rows).toHaveLength(3);
    expect(Number(rows.find((r) => r.service_id === 'aws.ssm')!.amount_micros)).toBe(200_000);

    expect((await freshRows())[0]).toMatchObject({
      source_id: 'aws_cost_explorer',
      provider_id: 'aws',
      service_id: 'aws.aggregate_billing',
      status: 'FRESH',
      consecutive_failures: 0,
    });
  });

  it('respects maxCallsPerDay = 1 across a restart — the cap lives in the table, not in memory', async () => {
    let calls = 0;
    const client: AwsCostExplorerPort = {
      costsByService: async () => {
        calls += 1;
        return [awsCost()];
      },
    };
    // Three ticks the same UTC day, each from a brand-new scheduler, the last
    // one long after the 24h frequency would otherwise allow a second run.
    expect((await awsScheduler(client).tick()).results[0]).toMatchObject({ outcome: 'ok' });
    expect(
      (await awsScheduler(client, new Date('2026-09-03T12:00:00Z')).tick()).results[0],
    ).toMatchObject({
      outcome: 'skipped_not_due',
    });
    // Age the attempt past the 24h frequency while leaving calls_day on today,
    // so the run is due and only the cap can stop it.
    await db.execute(sql`
      update cost_source_freshness set last_attempt_at = ${'2026-09-02T00:00:00Z'}
      where environment = ${ENV} and source_id = 'aws_cost_explorer'
    `);
    expect(
      (await awsScheduler(client, new Date('2026-09-03T23:59:00Z')).tick()).results[0],
    ).toMatchObject({
      outcome: 'skipped_calls_cap',
    });
    expect(calls).toBe(1);
    const fresh = (await freshRows())[0]!;
    expect(fresh).toMatchObject({ calls_day: '2026-09-03', calls_count: 1 });

    // The next UTC day the cap resets and it runs again.
    expect(
      (await awsScheduler(client, new Date('2026-09-04T06:00:00Z')).tick()).results[0],
    ).toMatchObject({
      outcome: 'ok',
    });
    expect(calls).toBe(2);
  });

  it('a failing call marks the source UNAVAILABLE with its code and writes nothing', async () => {
    const client: AwsCostExplorerPort = {
      costsByService: async () => {
        throw Object.assign(new Error('cost explorer 403'), { code: 'ACCESS_DENIED' });
      },
    };
    const report = await awsScheduler(client).tick();
    expect(report.results).toEqual([
      { collector: 'aws_cost_explorer', outcome: 'failed', errorCode: 'ACCESS_DENIED' },
    ]);
    expect((await freshRows())[0]).toMatchObject({
      source_id: 'aws_cost_explorer',
      status: 'UNAVAILABLE',
      consecutive_failures: 1,
      last_error_code: 'ACCESS_DENIED',
    });
    expect(await costRows('aws')).toEqual([]);
  });

  it('stamps reconciled_at on the ESTIMATED twin and reports the variance (epic §26)', async () => {
    // An estimate already on record for the same day and meter key.
    await db.execute(sql`
      insert into provider_cost_daily
        (day, environment, provider_id, service_id, amount_micros, currency, basis, confidence, source, cost_kind)
      values ('2026-09-02'::date, ${ENV}, 'aws', 'aws.ssm', 100_000, 'USD', 'ESTIMATED', 'MEDIUM', 'estimator', 'USAGE')
    `);
    await awsScheduler({ costsByService: async () => [awsCost()] }).tick();

    const rows = await costRows('aws');
    expect(rows.map((r) => [r.basis, Number(r.amount_micros), r.reconciled_at !== null])).toEqual([
      ['ACTUAL', 133_746, true],
      ['ESTIMATED', 100_000, true],
    ]);

    const lines = await new ReconciliationService(db as never, { environment: ENV }).compute(
      '2026-09',
    );
    expect(lines).toEqual([
      {
        providerId: 'aws',
        serviceId: 'aws.ssm',
        estimatedMicros: 100_000,
        actualMicros: 133_746,
        varianceMicros: 33_746,
        variancePct: 0.2523,
        currency: 'USD',
        matchedKeys: 1,
      },
    ]);
  });

  it('the monitoring-cost row counts the paid collector (epic §20/§21)', async () => {
    const s = awsScheduler({ costsByService: async () => [] });
    await s.writeMonitoringCostRow(NOW);
    const rows = await costRows('gogo');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service_id: 'gogo.cost_observability', basis: 'FIXED' });
    // $0.30/month over 30 days in September = 10,000 micros a day.
    expect(Number(rows[0]!.amount_micros)).toBe(10_000);
    expect(rows[0]!.metadata).toMatchObject({
      knownMonthlyMicros: 300_000,
      unknownCollectors: [],
      needsApproval: [],
      overBudget: false,
      collectors: ['aws_cost_explorer'],
    });
  });
});

describe('GitHub Actions → minutes and ACTUAL cost from one report', () => {
  it('writes the meter and the cost row for both days, replacing on a re-read', async () => {
    let todayMinutes = 40;
    const client: GitHubBillingPort = {
      usage: async () => [
        ghItem(),
        ghItem({
          day: '2026-09-03',
          quantity: todayMinutes,
          grossAmount: todayMinutes * 0.006,
          discountAmount: todayMinutes * 0.006,
          netAmount: 0,
        }),
        ghItem({
          day: '2026-09-02',
          sku: 'Actions macOS',
          quantity: 12,
          netAmount: 0.744,
          discountAmount: 0,
          grossAmount: 0.744,
        }),
      ],
    };
    const report = await githubScheduler(client).tick();
    expect(report.results).toEqual([{ collector: 'github_actions', outcome: 'ok', samples: 4 }]);

    let meters = await meterRows();
    expect(meters.map((m) => [m.day, m.usage_metric_id, Number(m.quantity), m.confidence])).toEqual(
      [
        ['2026-09-02', 'minutes', 392, 'HIGH'],
        ['2026-09-03', 'minutes', 40, 'MEDIUM'],
      ],
    );
    for (const m of meters) {
      expect(m).toMatchObject({
        provider_id: 'github',
        billing_sku_id: 'actions.minutes',
        unit: 'minute',
        source: 'github_api',
      });
    }
    expect(brief(await costRows('github'))).toEqual([
      ['2026-09-02', 'github.actions', 744_000, 'ACTUAL', 'HIGH'],
      ['2026-09-03', 'github.actions', 0, 'ACTUAL', 'MEDIUM'],
    ]);

    // More minutes accrue today: the row is the day's figure, not a sum.
    todayMinutes = 95;
    await githubScheduler(client, new Date('2026-09-03T12:00:00Z')).tick();
    meters = await meterRows();
    expect(Number(meters.find((m) => m.day === '2026-09-03')!.quantity)).toBe(95);
    expect(meters).toHaveLength(2);
  });

  it('the estimator prices the minutes and the Cost Center prefers the actual (epic §12, §15)', async () => {
    const client: GitHubBillingPort = {
      usage: async () => [
        ghItem({
          day: '2026-09-02',
          quantity: 1_500,
          netAmount: 0,
          grossAmount: 9,
          discountAmount: 9,
        }),
        ghItem({
          day: '2026-09-03',
          quantity: 900,
          netAmount: 2.4,
          grossAmount: 5.4,
          discountAmount: 3,
        }),
      ],
    };
    await githubScheduler(client).tick();
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    const result = await estimator.recompute({ from: '2026-09-01', to: '2026-09-03' });
    expect(result.unpriced).toEqual([]);

    const rows = await costRows('github');
    // Day 2: 1,500 minutes inside the 2,000/month allowance → $0 estimated.
    // Day 3: 900 more, 500 free then 400 at $0.006 = $2.40 — which is exactly
    // what GitHub charged, so the variance is zero.
    expect(rows.map((r) => [r.day, r.basis, Number(r.amount_micros)])).toEqual([
      ['2026-09-02', 'ACTUAL', 0],
      ['2026-09-02', 'ESTIMATED', 0],
      ['2026-09-03', 'ACTUAL', 2_400_000],
      ['2026-09-03', 'ESTIMATED', 2_400_000],
    ]);

    const center = new CostCenterService(db as never, COST_REGISTRY, {
      environment: ENV,
      ledgerEnabled: true,
      now: () => NOW,
    });
    const provider = await center.provider('github', 'mtd');
    // ACTUAL beats ESTIMATED for the same spend; the two are never added.
    expect(provider).toMatchObject({
      status: 'active',
      costStatus: 'KNOWN',
      basis: 'ACTUAL',
      spendMicros: 2_400_000,
      actualMicros: 2_400_000,
    });
    expect(provider!.freshness.sources.map((s) => s.sourceId)).toEqual(['github_actions']);
  });

  it('a failing call marks the source UNAVAILABLE and writes nothing', async () => {
    const client: GitHubBillingPort = {
      usage: async () => {
        throw Object.assign(new Error('github billing 404'), { code: 'NOT_FOUND' });
      },
    };
    const report = await githubScheduler(client).tick();
    expect(report.results).toEqual([
      { collector: 'github_actions', outcome: 'failed', errorCode: 'NOT_FOUND' },
    ]);
    expect((await freshRows())[0]).toMatchObject({
      source_id: 'github_actions',
      status: 'UNAVAILABLE',
      last_error_code: 'NOT_FOUND',
    });
    expect(await meterRows()).toEqual([]);
    expect(await costRows('github')).toEqual([]);
  });
});
