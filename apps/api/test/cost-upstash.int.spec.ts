import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import type { UpstashPoint, UpstashRedisStats, UpstashRedisStatsPort } from '@gogo/providers';
import {
  COST_REGISTRY,
  CollectorSchedulerService,
  CostCenterService,
  CostEstimatorService,
  upstashRedisCollector,
} from '@gogo/modules';

/**
 * COST-BE-025 (#384) — the Upstash collector against a real Postgres: meter
 * rows land under `source = 'upstash_api'` with replace semantics, the
 * freshness row is the collector's own, the estimator prices the commands it
 * wrote (free tier consumed in date order) and leaves the byte meters
 * unpriced, and a failing call writes nothing.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const ENV = 'dev';
const NOW = new Date('2026-09-03T06:00:00Z');

const pt = (day: string, value: number, time = '12:00:00'): UpstashPoint => ({
  day,
  at: new Date(`${day}T${time}Z`),
  value,
});

function stats(over: Partial<UpstashRedisStats> = {}): UpstashRedisStats {
  return {
    dailyNetCommands: 4_200,
    dailyBandwidthBytes: 9_000_000,
    currentStorageBytes: 12_000_000,
    totalMonthlyRequests: 7_300,
    totalMonthlyBandwidthBytes: 16_000_000,
    totalMonthlyStorageBytes: 12_000_000,
    dailyRequests: [pt('2026-09-02', 3_100), pt('2026-09-03', 4_200)],
    dailyBandwidth: [pt('2026-09-02', 7_000_000), pt('2026-09-03', 9_000_000)],
    diskUsage: [pt('2026-09-02', 11_500_000), pt('2026-09-03', 11_900_000)],
    windowDays: 7,
    ...over,
  };
}

type MeterRow = {
  day: string;
  service_id: string;
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
    select to_char(day, 'YYYY-MM-DD') as day, service_id, usage_metric_id, billing_sku_id,
           quantity, unit, source, confidence, metadata
    from provider_usage_meter_daily
    where environment = ${ENV} and provider_id = 'upstash'
    order by day, usage_metric_id
  `);
  return rows as unknown as MeterRow[];
}

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

function scheduler(client: UpstashRedisStatsPort, at: Date = NOW) {
  const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
    environment: ENV,
    now: () => at,
  });
  s.register(upstashRedisCollector(db as never, client, { now: () => at }));
  return s;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_upstash_test')
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

describe('collect → meter rows (epic §42.7)', () => {
  it('writes yesterday and today under upstash_api, then replaces rather than adds', async () => {
    let today = 4_200;
    const client: UpstashRedisStatsPort = {
      stats: async () =>
        stats({
          dailyNetCommands: today,
          dailyRequests: [pt('2026-09-02', 3_100), pt('2026-09-03', today)],
        }),
    };
    const report = await scheduler(client).tick();
    expect(report.results).toEqual([{ collector: 'upstash_redis', outcome: 'ok', samples: 6 }]);

    let rows = await meterRows();
    expect(rows.map((r) => [r.day, r.usage_metric_id, Number(r.quantity), r.confidence])).toEqual([
      ['2026-09-02', 'bandwidth_bytes', 7_000_000, 'MEDIUM'],
      ['2026-09-02', 'commands', 3_100, 'HIGH'],
      ['2026-09-02', 'storage_bytes', 11_500_000, 'MEDIUM'],
      ['2026-09-03', 'bandwidth_bytes', 9_000_000, 'HIGH'],
      ['2026-09-03', 'commands', 4_200, 'HIGH'],
      ['2026-09-03', 'storage_bytes', 12_000_000, 'MEDIUM'],
    ]);
    for (const r of rows)
      expect(r).toMatchObject({ source: 'upstash_api', service_id: 'upstash.redis' });
    // Only commands is billed; the byte meters carry no SKU.
    expect(rows.map((r) => [r.usage_metric_id, r.billing_sku_id])).toEqual(
      expect.arrayContaining([
        ['commands', 'redis.commands'],
        ['bandwidth_bytes', null],
        ['storage_bytes', null],
      ]),
    );
    expect(
      rows.find((r) => r.day === '2026-09-03' && r.usage_metric_id === 'commands')!.metadata,
    ).toMatchObject({
      from: 'dailyrequests',
      dailyNetCommands: 4_200,
      totalMonthlyRequests: 7_300,
    });

    // The next run sees a bigger day total: the row is the total, not a sum of reads.
    today = 4_800;
    await scheduler(client, new Date('2026-09-03T12:00:00Z')).tick();
    rows = await meterRows();
    expect(
      Number(
        rows.find((r) => r.day === '2026-09-03' && r.usage_metric_id === 'commands')!.quantity,
      ),
    ).toBe(4_800);
    expect(rows).toHaveLength(6);

    expect(await freshRows()).toEqual([
      expect.objectContaining({
        source_id: 'upstash_redis',
        provider_id: 'upstash',
        service_id: 'upstash.redis',
        status: 'FRESH',
        consecutive_failures: 0,
      }),
    ]);
  });

  it('a quiet day inside the window is written as zeros — measured, not unknown', async () => {
    const client: UpstashRedisStatsPort = {
      stats: async () =>
        stats({
          dailyNetCommands: 0,
          dailyBandwidthBytes: 0,
          dailyRequests: [],
          dailyBandwidth: [],
          diskUsage: [],
        }),
    };
    await scheduler(client).tick();
    const rows = await meterRows();
    // Yesterday: commands + bandwidth zero, no storage sample → no storage row.
    // Today: all three, storage from the live figure.
    expect(rows.map((r) => [r.day, r.usage_metric_id, Number(r.quantity)])).toEqual([
      ['2026-09-02', 'bandwidth_bytes', 0],
      ['2026-09-02', 'commands', 0],
      ['2026-09-03', 'bandwidth_bytes', 0],
      ['2026-09-03', 'commands', 0],
      ['2026-09-03', 'storage_bytes', 12_000_000],
    ]);
  });

  it('a failing call marks the source UNAVAILABLE with its error code and writes nothing', async () => {
    const client: UpstashRedisStatsPort = {
      stats: async () => {
        throw Object.assign(new Error('upstash developer api 401'), { code: 'AUTH_FAILED' });
      },
    };
    const report = await scheduler(client).tick();
    expect(report.results).toEqual([
      { collector: 'upstash_redis', outcome: 'failed', errorCode: 'AUTH_FAILED' },
    ]);
    expect((await freshRows())[0]).toMatchObject({
      source_id: 'upstash_redis',
      status: 'UNAVAILABLE',
      consecutive_failures: 1,
      last_error_code: 'AUTH_FAILED',
    });
    expect(await meterRows()).toEqual([]);
  });
});

describe('estimator prices what the collector wrote (epic §13, §15)', () => {
  it('consumes the 500K/month free tier in date order and leaves the byte meters unpriced', async () => {
    const client: UpstashRedisStatsPort = {
      stats: async () =>
        stats({
          dailyNetCommands: 600_000,
          dailyRequests: [pt('2026-09-02', 100_000), pt('2026-09-03', 600_000)],
        }),
    };
    await scheduler(client).tick();
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    const result = await estimator.recompute({ from: '2026-09-01', to: '2026-09-03' });
    expect(result.unpriced).toEqual([]);

    const { rows } = await db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, billing_sku_id, billable_quantity, amount_micros,
             basis, confidence, source, metadata
      from provider_cost_daily
      where environment = ${ENV} and provider_id = 'upstash'
      order by day, billing_sku_id
    `);
    const costs = (
      rows as unknown as {
        day: string;
        billing_sku_id: string;
        billable_quantity: number | string;
        amount_micros: number | string;
        basis: string;
        confidence: string;
        source: string;
        metadata: { listMicros: number; allowancePriorQuantity: number };
      }[]
    ).map((r) => ({
      ...r,
      billable_quantity: Number(r.billable_quantity),
      amount_micros: Number(r.amount_micros),
    }));
    // Day 2: 100K within the allowance. Day 3: 600K with 100K already used →
    // 400K free, 200K billable at $0.2/100K = $0.40.
    expect(costs.map((c) => [c.day, c.billing_sku_id, c.amount_micros])).toEqual([
      ['2026-09-02', 'redis.commands', 0],
      ['2026-09-03', 'redis.commands', 400_000],
    ]);
    expect(costs[1]).toMatchObject({
      billable_quantity: 600_000,
      basis: 'ESTIMATED',
      confidence: 'MEDIUM',
      source: 'estimator',
    });
    expect(costs[1]!.metadata).toMatchObject({
      listMicros: 1_200_000,
      allowancePriorQuantity: 100_000,
    });

    // The Cost Center reads it back: active, FRESH, KNOWN spend from ESTIMATED rows.
    const center = new CostCenterService(db as never, COST_REGISTRY, {
      environment: ENV,
      ledgerEnabled: true,
      now: () => NOW,
    });
    const provider = await center.provider('upstash', 'mtd');
    expect(provider).toMatchObject({
      status: 'active',
      costStatus: 'KNOWN',
      basis: 'ESTIMATED',
      spendMicros: 400_000,
      estimatedMicros: 400_000,
    });
    expect(provider!.freshness.status).toBe('FRESH');
    expect(provider!.freshness.sources.map((s) => s.sourceId)).toEqual(['upstash_redis']);
    const redis = provider!.services.find((s) => s.serviceId === 'upstash.redis')!;
    expect(redis.costStatus).toBe('KNOWN');
    expect(redis.usage.map((u) => u.usageMetricId).sort()).toEqual([
      'bandwidth_bytes',
      'commands',
      'storage_bytes',
    ]);
  });
});
