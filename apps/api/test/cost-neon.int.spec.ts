import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import type { NeonConsumptionDay, NeonProjectConsumption, NeonUsagePort } from '@gogo/providers';
import {
  COST_REGISTRY,
  CollectorSchedulerService,
  CostCenterService,
  CostEstimatorService,
  neonPostgresCollector,
  readNeonState,
} from '@gogo/modules';

/**
 * COST-BE-026 (#385) — the Neon collector against a real Postgres: history
 * rows land under `source = 'neon_api'` with replace semantics; on the Free
 * plan the project snapshot's period-to-date counters become daily deltas
 * whose baseline is read back from the previous row; the freshness row is the
 * collector's own; the Free-plan rules price everything at zero with the caps
 * on record; and a failing call writes nothing.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const ENV = 'dev';
const NOW = new Date('2026-09-03T06:00:00Z');

const entry = (day: string, over: Partial<NeonConsumptionDay> = {}): NeonConsumptionDay => ({
  day,
  timeframeStart: new Date(`${day}T00:00:00Z`),
  timeframeEnd: new Date(`${day}T06:00:00Z`),
  periodPlan: 'launch',
  activeTimeSeconds: 7_200,
  computeTimeSeconds: 5_400,
  writtenDataBytes: 2_600_000_000,
  syntheticStorageSizeBytes: 320_000_000,
  dataStorageBytesHour: null,
  dataTransferBytes: null,
  ...over,
});

const snapshot = (over: Partial<NeonProjectConsumption> = {}): NeonProjectConsumption => ({
  projectId: 'gogo-dev-123456',
  consumptionPeriodStart: new Date('2026-09-01T00:00:00Z'),
  consumptionPeriodEnd: new Date('2026-10-01T00:00:00Z'),
  activeTimeSeconds: 100_000,
  computeTimeSeconds: 25_000,
  writtenDataBytes: 1_200_000_000,
  dataStorageBytesHour: 500_000_000_000,
  dataTransferBytes: 3_500_000_000,
  syntheticStorageSizeBytes: 330_000_000,
  ...over,
});

const unsupported = () => Object.assign(new Error('neon api 403'), { code: 'PLAN_NOT_SUPPORTED' });

type MeterRow = {
  day: string;
  usage_metric_id: string;
  billing_sku_id: string | null;
  quantity: number | string;
  unit: string;
  source: string;
  confidence: string;
  metadata: Record<string, unknown>;
};

async function meterRows(): Promise<MeterRow[]> {
  const { rows } = await db.execute(sql`
    select to_char(day, 'YYYY-MM-DD') as day, usage_metric_id, billing_sku_id,
           quantity, unit, source, confidence, metadata
    from provider_usage_meter_daily
    where environment = ${ENV} and provider_id = 'neon'
    order by day, usage_metric_id
  `);
  return rows as unknown as MeterRow[];
}

const brief = (rows: MeterRow[]) =>
  rows.map((r) => [r.day, r.usage_metric_id, Number(r.quantity), r.confidence]);

async function freshRows() {
  const { rows } = await db.execute(sql`
    select source_id, provider_id, service_id, status, consecutive_failures, last_error_code
    from cost_source_freshness where environment = ${ENV} order by source_id
  `);
  return rows as unknown as {
    source_id: string;
    provider_id: string;
    service_id: string | null;
    status: string;
    consecutive_failures: number;
    last_error_code: string | null;
  }[];
}

function scheduler(client: NeonUsagePort, at: Date = NOW) {
  const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
    environment: ENV,
    now: () => at,
  });
  s.register(neonPostgresCollector(db as never, client, { now: () => at }));
  return s;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_neon_test')
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

describe('usage-based plan: history → meter rows', () => {
  it('writes yesterday and today under neon_api, then replaces rather than adds', async () => {
    let todaySeconds = 5_400;
    const client: NeonUsagePort = {
      consumptionHistory: async () => [
        entry('2026-09-02', { computeTimeSeconds: 9_000 }),
        entry('2026-09-03', { computeTimeSeconds: todaySeconds }),
      ],
      project: async () => snapshot(),
    };
    const report = await scheduler(client).tick();
    expect(report.results).toEqual([{ collector: 'neon_postgres', outcome: 'ok', samples: 9 }]);

    let rows = await meterRows();
    expect(brief(rows)).toEqual([
      ['2026-09-02', 'compute_hours', 3, 'HIGH'],
      ['2026-09-02', 'storage_bytes', 320_000_000, 'HIGH'],
      ['2026-09-02', 'storage_gb_month', 1, 'HIGH'],
      ['2026-09-02', 'written_data_gb', 3, 'HIGH'],
      ['2026-09-03', 'compute_hours', 2, 'HIGH'],
      // Transfer is not in the history: first run measures it from here.
      ['2026-09-03', 'data_transfer_gb', 0, 'MEDIUM'],
      // Today's storage peak takes the live figure over the entry's.
      ['2026-09-03', 'storage_bytes', 330_000_000, 'HIGH'],
      ['2026-09-03', 'storage_gb_month', 1, 'HIGH'],
      ['2026-09-03', 'written_data_gb', 3, 'HIGH'],
    ]);
    for (const r of rows) expect(r.source).toBe('neon_api');
    expect(rows.map((r) => [r.usage_metric_id, r.billing_sku_id])).toEqual(
      expect.arrayContaining([
        ['compute_hours', 'postgres.compute'],
        ['storage_gb_month', 'postgres.storage'],
        ['data_transfer_gb', 'postgres.data_transfer'],
        ['written_data_gb', null],
        ['storage_bytes', null],
      ]),
    );
    expect(
      rows.find((r) => r.day === '2026-09-03' && r.usage_metric_id === 'data_transfer_gb')!
        .metadata,
    ).toMatchObject({ from: 'project', historyStatus: 'not_listed', firstRun: true });

    // The next run sees a bigger day total: the row is the total, not a sum of reads.
    todaySeconds = 12_600;
    await scheduler(client, new Date('2026-09-03T12:00:00Z')).tick();
    rows = await meterRows();
    expect(
      Number(
        rows.find((r) => r.day === '2026-09-03' && r.usage_metric_id === 'compute_hours')!.quantity,
      ),
    ).toBe(4);
    expect(rows).toHaveLength(9);

    expect(await freshRows()).toEqual([
      expect.objectContaining({
        source_id: 'neon_postgres',
        provider_id: 'neon',
        service_id: 'neon.postgres',
        status: 'FRESH',
        consecutive_failures: 0,
      }),
    ]);
  });
});

describe('Free plan: project snapshot → daily deltas', () => {
  it('measures from the first run, carries the baseline through the day and across days', async () => {
    let current = snapshot();
    const client: NeonUsagePort = {
      consumptionHistory: async () => {
        throw unsupported();
      },
      project: async () => current,
    };

    // Run 1, 06:00: nothing on record → zeros, baseline = this snapshot.
    const first = await scheduler(client).tick();
    expect(first.results).toEqual([{ collector: 'neon_postgres', outcome: 'ok', samples: 5 }]);
    expect(brief(await meterRows())).toEqual([
      ['2026-09-03', 'compute_hours', 0, 'MEDIUM'],
      ['2026-09-03', 'data_transfer_gb', 0, 'MEDIUM'],
      ['2026-09-03', 'storage_bytes', 330_000_000, 'MEDIUM'],
      ['2026-09-03', 'storage_gb_month', 1, 'MEDIUM'],
      ['2026-09-03', 'written_data_gb', 0, 'MEDIUM'],
    ]);
    expect((await readNeonState(db as never, ENV, '2026-09-03')).baseline).toEqual({
      counters: {
        computeTimeSeconds: 25_000,
        writtenDataBytes: 1_200_000_000,
        dataTransferBytes: 3_500_000_000,
      },
      at: NOW,
      periodStart: '2026-09-01T00:00:00.000Z',
    });

    // Run 2, 12:00 the same day: +7,400 s, +1.1 GB written, +1.6 GB out; storage dipped.
    current = snapshot({
      computeTimeSeconds: 32_400,
      writtenDataBytes: 2_300_000_000,
      dataTransferBytes: 5_100_000_000,
      syntheticStorageSizeBytes: 310_000_000,
    });
    await scheduler(client, new Date('2026-09-03T12:00:00Z')).tick();
    let rows = await meterRows();
    expect(brief(rows)).toEqual([
      // floor(9) − floor(6.94)
      ['2026-09-03', 'compute_hours', 3, 'MEDIUM'],
      // floor(5.1) − floor(3.5)
      ['2026-09-03', 'data_transfer_gb', 2, 'MEDIUM'],
      // The earlier peak survives the replace.
      ['2026-09-03', 'storage_bytes', 330_000_000, 'MEDIUM'],
      ['2026-09-03', 'storage_gb_month', 1, 'MEDIUM'],
      // floor(2.3) − floor(1.2)
      ['2026-09-03', 'written_data_gb', 1, 'MEDIUM'],
    ]);
    expect(rows.find((r) => r.usage_metric_id === 'compute_hours')!.metadata).toMatchObject({
      baseline: { computeTimeSeconds: 25_000, at: NOW.toISOString() },
      cumulative: { computeTimeSeconds: 32_400 },
      exact: { computeTimeSecondsDelta: 7_400 },
    });

    // Run 3, next day 06:00: yesterday's last totals are today's baseline.
    current = snapshot({
      computeTimeSeconds: 36_500,
      writtenDataBytes: 2_400_000_000,
      dataTransferBytes: 7_000_000_000,
    });
    await scheduler(client, new Date('2026-09-04T06:00:00Z')).tick();
    rows = await meterRows();
    expect(brief(rows.filter((r) => r.day === '2026-09-04'))).toEqual([
      // floor(10.14) − floor(9)
      ['2026-09-04', 'compute_hours', 1, 'MEDIUM'],
      // floor(7) − floor(5.1)
      ['2026-09-04', 'data_transfer_gb', 2, 'MEDIUM'],
      ['2026-09-04', 'storage_bytes', 330_000_000, 'MEDIUM'],
      ['2026-09-04', 'storage_gb_month', 1, 'MEDIUM'],
      ['2026-09-04', 'written_data_gb', 0, 'MEDIUM'],
    ]);
    // Yesterday's rows are untouched by the new day.
    expect(brief(rows.filter((r) => r.day === '2026-09-03')).map((r) => r[2])).toEqual([
      3, 2, 330_000_000, 1, 1,
    ]);
    // Compute over the two days telescopes to floor(36,500 / 3,600) − floor(25,000 / 3,600) = 4.
    expect(
      rows
        .filter((r) => r.usage_metric_id === 'compute_hours')
        .reduce((s, r) => s + Number(r.quantity), 0),
    ).toBe(4);

    // Run 4, a new billing period: totals reset, everything since belongs to today.
    current = snapshot({
      consumptionPeriodStart: new Date('2026-10-01T00:00:00Z'),
      consumptionPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      computeTimeSeconds: 8_000,
      writtenDataBytes: 100_000_000,
      dataTransferBytes: 2_500_000_000,
    });
    await scheduler(client, new Date('2026-10-01T06:00:00Z')).tick();
    rows = await meterRows();
    expect(brief(rows.filter((r) => r.day === '2026-10-01'))).toEqual([
      ['2026-10-01', 'compute_hours', 2, 'MEDIUM'],
      ['2026-10-01', 'data_transfer_gb', 2, 'MEDIUM'],
      ['2026-10-01', 'storage_bytes', 330_000_000, 'MEDIUM'],
      ['2026-10-01', 'storage_gb_month', 1, 'MEDIUM'],
      ['2026-10-01', 'written_data_gb', 0, 'MEDIUM'],
    ]);
    expect(
      rows.find((r) => r.day === '2026-10-01' && r.usage_metric_id === 'compute_hours')!.metadata,
    ).toMatchObject({
      periodRollover: true,
      baseline: { computeTimeSeconds: 0, periodStart: '2026-10-01T00:00:00.000Z' },
    });
    expect((await freshRows())[0]).toMatchObject({ source_id: 'neon_postgres', status: 'FRESH' });
  });

  it('a failing call marks the source UNAVAILABLE with its error code and writes nothing', async () => {
    const client: NeonUsagePort = {
      consumptionHistory: async () => {
        throw Object.assign(new Error('neon api 401'), { code: 'AUTH_FAILED' });
      },
      project: async () => snapshot(),
    };
    const report = await scheduler(client).tick();
    expect(report.results).toEqual([
      { collector: 'neon_postgres', outcome: 'failed', errorCode: 'AUTH_FAILED' },
    ]);
    expect((await freshRows())[0]).toMatchObject({
      source_id: 'neon_postgres',
      status: 'UNAVAILABLE',
      consecutive_failures: 1,
      last_error_code: 'AUTH_FAILED',
    });
    expect(await meterRows()).toEqual([]);
  });
});

describe('estimator prices what the collector wrote (epic §13, §15)', () => {
  it('Free-plan rules: every billed meter prices at zero with the cap on record; byte and written meters stay unpriced', async () => {
    const client: NeonUsagePort = {
      consumptionHistory: async () => [
        entry('2026-09-02', { computeTimeSeconds: 7_200 }),
        entry('2026-09-03', { computeTimeSeconds: 3_600, dataTransferBytes: 6_000_000_000 }),
      ],
      project: async () => snapshot(),
    };
    await scheduler(client).tick();
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    const result = await estimator.recompute({ from: '2026-09-01', to: '2026-09-03' });
    expect(result.unpriced).toEqual([]);

    const { rows } = await db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, billing_sku_id, billable_quantity, amount_micros,
             basis, source, metadata
      from provider_cost_daily
      where environment = ${ENV} and provider_id = 'neon'
      order by day, billing_sku_id
    `);
    const costs = (
      rows as unknown as {
        day: string;
        billing_sku_id: string;
        billable_quantity: number | string;
        amount_micros: number | string;
        basis: string;
        source: string;
        metadata: { listMicros: number; ruleId: string };
      }[]
    ).map((r) => ({
      ...r,
      billable_quantity: Number(r.billable_quantity),
      amount_micros: Number(r.amount_micros),
    }));
    expect(
      costs.map((c) => [c.day, c.billing_sku_id, c.billable_quantity, c.amount_micros]),
    ).toEqual([
      ['2026-09-02', 'postgres.compute', 2, 0],
      ['2026-09-02', 'postgres.storage', 1, 0],
      ['2026-09-03', 'postgres.compute', 1, 0],
      ['2026-09-03', 'postgres.data_transfer', 6, 0],
      ['2026-09-03', 'postgres.storage', 1, 0],
    ]);
    for (const c of costs) {
      expect(c).toMatchObject({ basis: 'ESTIMATED', source: 'estimator' });
      expect(c.metadata).toMatchObject({ listMicros: 0 });
      expect(c.metadata.ruleId).toMatch(/^neon-postgres\./);
    }

    // The Cost Center reads it back: active, FRESH, a known zero.
    const center = new CostCenterService(db as never, COST_REGISTRY, {
      environment: ENV,
      ledgerEnabled: true,
      now: () => NOW,
    });
    const provider = await center.provider('neon', 'mtd');
    expect(provider).toMatchObject({ status: 'active', spendMicros: 0 });
    expect(provider!.freshness.status).toBe('FRESH');
    expect(provider!.freshness.sources.map((s) => s.sourceId)).toEqual(['neon_postgres']);
    const postgres = provider!.services.find((s) => s.serviceId === 'neon.postgres')!;
    expect(postgres.usage.map((u) => u.usageMetricId).sort()).toEqual([
      'compute_hours',
      'data_transfer_gb',
      'storage_bytes',
      'storage_gb_month',
      'written_data_gb',
    ]);
  });
});
