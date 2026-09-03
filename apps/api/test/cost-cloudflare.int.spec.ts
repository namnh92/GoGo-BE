import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import type {
  CloudflareAnalyticsPort,
  CloudflareR2DayUsage,
  CloudflareWorkersDayUsage,
} from '@gogo/providers';
import {
  COST_REGISTRY,
  CollectorSchedulerService,
  CostCenterService,
  CostEstimatorService,
  cloudflareCollectors,
} from '@gogo/modules';

/**
 * COST-BE-024 (#383) — the Cloudflare collectors against a real Postgres:
 * meter rows land under `source = 'cloudflare_api'` with replace semantics,
 * the freshness rows are the collectors' own, the estimator prices what was
 * written (free tier consumed, GB-month prorated), and one collector failing
 * leaves the other's row alone.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const ENV = 'dev';
const NOW = new Date('2026-09-03T06:00:00Z');

function r2(over: Partial<CloudflareR2DayUsage> = {}): CloudflareR2DayUsage {
  return {
    bucketName: 'gogo-dev-assets',
    classA: 120,
    classB: 5_000,
    unclassified: 0,
    byAction: { PutObject: 120, GetObject: 5_000 },
    peakBytes: 1_502_000_000,
    peakObjects: 1_234,
    ...over,
  };
}

function workers(over: Partial<CloudflareWorkersDayUsage> = {}): CloudflareWorkersDayUsage {
  return { scriptName: 'gogo-dev-share-link', requests: 3_210, errors: 4, subrequests: 0, ...over };
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
    where environment = ${ENV} and provider_id = 'cloudflare'
    order by day, service_id, usage_metric_id
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

function scheduler(client: CloudflareAnalyticsPort, at: Date = NOW) {
  const s = new CollectorSchedulerService(db as never, COST_REGISTRY, {
    environment: ENV,
    now: () => at,
  });
  for (const def of cloudflareCollectors(db as never, client, {
    buckets: ['gogo-dev-assets'],
    scripts: ['gogo-dev-share-link'],
    now: () => at,
  })) {
    s.register(def);
  }
  return s;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_cloudflare_test')
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

describe('collect → meter rows (epic §42.8–.9)', () => {
  it('writes yesterday and today under cloudflare_api, then replaces rather than adds', async () => {
    let classA = 120;
    const client: CloudflareAnalyticsPort = {
      r2Usage: async ({ day }) => [r2({ classA: day === '2026-09-03' ? classA : 40 })],
      workersUsage: async () => [workers()],
    };
    const report = await scheduler(client).tick();
    expect(report.results).toEqual([
      { collector: 'cloudflare_r2', outcome: 'ok', samples: 6 },
      { collector: 'cloudflare_workers', outcome: 'ok', samples: 2 },
    ]);

    let rows = await meterRows();
    expect(rows.map((r) => [r.day, r.usage_metric_id, Number(r.quantity)])).toEqual([
      ['2026-09-02', 'class_a', 40],
      ['2026-09-02', 'class_b', 5_000],
      ['2026-09-02', 'storage_gb_month', 2],
      ['2026-09-02', 'requests', 3_210],
      ['2026-09-03', 'class_a', 120],
      ['2026-09-03', 'class_b', 5_000],
      ['2026-09-03', 'storage_gb_month', 2],
      ['2026-09-03', 'requests', 3_210],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ source: 'cloudflare_api', confidence: 'HIGH' });
      expect(r.billing_sku_id).not.toBeNull();
    }
    expect(rows.find((r) => r.usage_metric_id === 'class_a')!.metadata).toMatchObject({
      scope: 'filtered',
      buckets: ['gogo-dev-assets'],
      byAction: { PutObject: 120, GetObject: 5_000 },
    });

    // The next run sees a bigger day total: the row is the total, not a sum of reads.
    classA = 130;
    await scheduler(client, new Date('2026-09-03T12:00:00Z')).tick();
    rows = await meterRows();
    expect(
      Number(rows.find((r) => r.day === '2026-09-03' && r.usage_metric_id === 'class_a')!.quantity),
    ).toBe(130);
    expect(rows).toHaveLength(8);

    const fresh = await freshRows();
    expect(fresh).toEqual([
      expect.objectContaining({
        source_id: 'cloudflare_r2',
        provider_id: 'cloudflare',
        service_id: 'cloudflare.r2',
        status: 'FRESH',
        consecutive_failures: 0,
      }),
      expect.objectContaining({
        source_id: 'cloudflare_workers',
        provider_id: 'cloudflare',
        service_id: 'cloudflare.workers',
        status: 'FRESH',
      }),
    ]);
  });

  it('a quiet day is written as zeros — measured, not unknown', async () => {
    const client: CloudflareAnalyticsPort = {
      r2Usage: async () => [],
      workersUsage: async () => [],
    };
    await scheduler(client).tick();
    const rows = await meterRows();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => Number(r.quantity) === 0)).toBe(true);
  });

  it('isolates a failing collector: R2 UNAVAILABLE with its error code, Workers FRESH', async () => {
    const client: CloudflareAnalyticsPort = {
      r2Usage: async () => {
        throw Object.assign(new Error('cloudflare graphql 403'), { code: 'AUTH_FAILED' });
      },
      workersUsage: async () => [workers()],
    };
    const report = await scheduler(client).tick();
    expect(report.results).toEqual([
      { collector: 'cloudflare_r2', outcome: 'failed', errorCode: 'AUTH_FAILED' },
      { collector: 'cloudflare_workers', outcome: 'ok', samples: 2 },
    ]);
    const fresh = await freshRows();
    expect(fresh[0]).toMatchObject({
      source_id: 'cloudflare_r2',
      status: 'UNAVAILABLE',
      consecutive_failures: 1,
      last_error_code: 'AUTH_FAILED',
    });
    expect(fresh[1]).toMatchObject({ source_id: 'cloudflare_workers', status: 'FRESH' });
    const rows = await meterRows();
    expect(rows.map((r) => r.service_id)).toEqual(['cloudflare.workers', 'cloudflare.workers']);
  });
});

describe('estimator prices what the collector wrote (epic §13, §15)', () => {
  it('consumes the free tier per SKU and prorates storage by days in the month', async () => {
    const client: CloudflareAnalyticsPort = {
      // 1.5M Class A today: 0.5M over the monthly million. 20 GB peak.
      r2Usage: async ({ day }) => [
        r2({
          classA: day === '2026-09-03' ? 1_500_000 : 0,
          classB: 10,
          peakBytes: 20_000_000_000,
        }),
      ],
      workersUsage: async () => [workers({ requests: 250_000 })],
    };
    await scheduler(client).tick();
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    const result = await estimator.recompute({ from: '2026-09-01', to: '2026-09-03' });
    expect(result.unpriced).toEqual([]);

    const { rows } = await db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, billing_sku_id, billable_quantity, amount_micros, basis,
             confidence, source, metadata
      from provider_cost_daily
      where environment = ${ENV} and provider_id = 'cloudflare'
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
    // Zero-quantity days produce no ESTIMATED row (nothing to price); the
    // storage and Workers rows exist for both days.
    expect(costs.map((c) => [c.day, c.billing_sku_id, c.amount_micros])).toEqual([
      ['2026-09-02', 'r2.class_b', 0],
      ['2026-09-02', 'r2.storage', 0],
      ['2026-09-02', 'workers.requests', 0],
      ['2026-09-03', 'r2.class_a', 2_250_000],
      ['2026-09-03', 'r2.class_b', 0],
      ['2026-09-03', 'r2.storage', 0],
      ['2026-09-03', 'workers.requests', 0],
    ]);
    const classA = costs.find((c) => c.billing_sku_id === 'r2.class_a')!;
    // 1.5M × $4.50/M = $6.75 list; 1M free → $2.25.
    expect(classA).toMatchObject({
      billable_quantity: 1_500_000,
      basis: 'ESTIMATED',
      confidence: 'MEDIUM',
      source: 'estimator',
    });
    expect(classA.metadata.listMicros).toBe(6_750_000);
    // 20 GB on a 30-day month: 20 × 15,000 / 30 = 10,000 list; 300 GB-days free.
    const storage = costs.find((c) => c.day === '2026-09-03' && c.billing_sku_id === 'r2.storage')!;
    expect(storage.metadata).toMatchObject({ listMicros: 10_000, allowancePriorQuantity: 20 });
    // Workers Free plan: known zero, never unpriced.
    expect(costs.filter((c) => c.billing_sku_id === 'workers.requests')).toHaveLength(2);

    // The Cost Center reads it back: active, FRESH, KNOWN spend from ESTIMATED rows.
    const center = new CostCenterService(db as never, COST_REGISTRY, {
      environment: ENV,
      ledgerEnabled: true,
      now: () => NOW,
    });
    const provider = await center.provider('cloudflare', 'mtd');
    expect(provider).toMatchObject({
      status: 'active',
      costStatus: 'KNOWN',
      basis: 'ESTIMATED',
      spendMicros: 2_250_000,
      estimatedMicros: 2_250_000,
    });
    expect(provider!.freshness.status).toBe('FRESH');
    expect(provider!.freshness.sources.map((s) => s.sourceId)).toEqual([
      'cloudflare_r2',
      'cloudflare_workers',
    ]);
    const r2Row = provider!.services.find((s) => s.serviceId === 'cloudflare.r2')!;
    expect(r2Row.costStatus).toBe('KNOWN');
    expect(r2Row.usage.map((u) => u.usageMetricId).sort()).toEqual([
      'class_a',
      'class_b',
      'storage_gb_month',
    ]);
  });
});
