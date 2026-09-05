import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { MetricsRegistry, TeeMetrics } from '@gogo/observability';
import { GooglePlacesAdapter, GoogleRoutesAdapter } from '@gogo/providers';
import { CostEstimatorService, DbUsageLedger, ESTIMATOR_SOURCE, utcDay } from '@gogo/modules';

/**
 * COST-BE-016 (#368) — the canonical usage-meter and cost tables, against a
 * real Postgres.
 *
 * What only a database can prove:
 *
 * 1. **The ledger's dual-write is one transaction and lands as meters.** The
 *    same adapter calls that fill `provider_usage_daily` now also produce
 *    `provider_usage_meter_daily` rows keyed by registry ids, with Routes as
 *    two meters for one call.
 * 2. **The estimator is idempotent, bounded and touches nothing but its own
 *    rows.** Recomputing twice yields the same rows once; an ACTUAL row in the
 *    same range survives untouched; an unpriced SKU produces no row.
 * 3. **Unique keys hold with nullable ids.** The COALESCE expression index is
 *    what ON CONFLICT resolves against, so a second flush accumulates rather
 *    than duplicating.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';
const TODAY = utcDay();

type Stub = { status: number; body?: unknown };
let queued: Stub[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const next = queued.shift() ?? { status: 200, body: {} };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        url: String(input),
        headers: { get: () => null },
        json: async () => next.body ?? {},
        text: async () => JSON.stringify(next.body ?? {}),
      };
    }),
  );
}

type MeterRow = {
  provider_id: string;
  service_id: string;
  operation_id: string | null;
  usage_metric_id: string;
  billing_sku_id: string | null;
  quantity: number;
  unit: string;
  source: string;
  confidence: string;
};

async function meterRows(): Promise<MeterRow[]> {
  const { rows } = await db.execute(sql`
    select provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
           quantity, unit, source, confidence
    from provider_usage_meter_daily
    where environment = ${ENV}
    order by operation_id, usage_metric_id
  `);
  return (rows as unknown as MeterRow[]).map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

type CostRow = {
  billing_sku_id: string | null;
  amount_micros: number;
  basis: string;
  source: string;
  pricing_version: string | null;
  billable_quantity: number | null;
};

async function costRows(): Promise<CostRow[]> {
  const { rows } = await db.execute(sql`
    select billing_sku_id, amount_micros, basis, source, pricing_version, billable_quantity
    from provider_cost_daily
    where environment = ${ENV}
    order by basis, source, billing_sku_id
  `);
  return (rows as unknown as CostRow[]).map((r) => ({
    ...r,
    amount_micros: Number(r.amount_micros),
    billable_quantity: r.billable_quantity === null ? null : Number(r.billable_quantity),
  }));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_canonical_test')
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
  vi.unstubAllGlobals();
  queued = [];
  await db.execute(sql`delete from provider_usage_daily`);
  await db.execute(sql`delete from provider_usage_meter_daily`);
  await db.execute(sql`delete from provider_cost_daily`);
});

describe('ledger dual-write → provider_usage_meter_daily (epic §9)', () => {
  it('writes calls and billed meters per operation, Routes as two meters for one call', async () => {
    stubFetch();
    const ledger = new DbUsageLedger(db as never, { environment: ENV });
    const metrics = new TeeMetrics([new MetricsRegistry(), ledger]);
    const places = new GooglePlacesAdapter('test-key', metrics);
    const routes = new GoogleRoutesAdapter('test-key', metrics);

    queued = [
      { status: 200, body: { id: 'ChIJ-a', displayName: { text: 'A' } } },
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      // One matrix call, three destinations → three billable elements.
      {
        status: 200,
        body: [
          {
            originIndex: 0,
            destinationIndex: 0,
            duration: '60s',
            distanceMeters: 100,
            condition: 'ROUTE_EXISTS',
          },
          {
            originIndex: 0,
            destinationIndex: 1,
            duration: '120s',
            distanceMeters: 200,
            condition: 'ROUTE_EXISTS',
          },
          {
            originIndex: 0,
            destinationIndex: 2,
            duration: '180s',
            distanceMeters: 300,
            condition: 'ROUTE_EXISTS',
          },
        ],
      },
    ];
    await places.details('ChIJ-a', 'quality');
    await places.details('ChIJ-b', 'quality').catch(() => undefined);
    await routes.matrix({ lat: 10.77, lng: 106.7 }, [
      { lat: 10.78, lng: 106.71 },
      { lat: 10.79, lng: 106.72 },
      { lat: 10.8, lng: 106.73 },
    ]);
    await ledger.stop();

    const rows = await meterRows();
    expect(rows).toEqual([
      expect.objectContaining({
        provider_id: 'google',
        service_id: 'google.places',
        operation_id: 'google.details.quality',
        usage_metric_id: 'calls',
        billing_sku_id: null,
        quantity: 2,
        unit: 'request',
        source: 'ledger',
        confidence: 'HIGH',
      }),
      expect.objectContaining({
        operation_id: 'google.details.quality',
        usage_metric_id: 'requests',
        billing_sku_id: 'places.details.enterprise',
        quantity: 1,
      }),
      expect.objectContaining({
        service_id: 'google.routes',
        operation_id: 'google.routeMatrix',
        usage_metric_id: 'billable_elements',
        billing_sku_id: 'routes.computeRouteMatrix',
        quantity: 3,
        unit: 'matrix_element',
      }),
      expect.objectContaining({
        operation_id: 'google.routeMatrix',
        usage_metric_id: 'calls',
        billing_sku_id: null,
        quantity: 1,
      }),
    ]);

    // The legacy table is untouched in shape and agrees on the totals.
    const legacy = await db.execute(sql`
      select operation, calls_attempted, calls_succeeded, billable_units
      from provider_usage_daily where environment = ${ENV} order by operation
    `);
    expect(legacy.rows).toEqual([
      expect.objectContaining({
        operation: 'google.details.quality',
        calls_attempted: 2,
        calls_succeeded: 1,
      }),
      expect.objectContaining({
        operation: 'google.routeMatrix',
        calls_attempted: 1,
        calls_succeeded: 1,
      }),
    ]);
  });

  it('accumulates across flushes through the COALESCE unique key', async () => {
    const ledger = new DbUsageLedger(db as never, { environment: ENV });
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.core',
      status: '200',
    });
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' });
    await ledger.flush();
    ledger.increment('places_provider_requests_total', {
      method: 'google.details.core',
      status: '200',
    });
    ledger.increment('places_provider_cost_units', { sku: 'google.details.core' });
    await ledger.flush();

    const rows = await meterRows();
    expect(rows.map((r) => [r.usage_metric_id, r.quantity])).toEqual([
      ['calls', 2],
      ['requests', 2],
    ]);
  });
});

describe('estimator → provider_cost_daily (epic §11, §25)', () => {
  async function seedUsage(
    sku: string,
    quantity: number,
    over: Partial<{ day: string; source: string }> = {},
  ) {
    // Three shapes: Routes (elements), the Maps SDK (map loads, price still
    // unverified), and Places Details (the default).
    const shape =
      sku === 'routes.computeRouteMatrix'
        ? {
            service: 'google.routes',
            operation: 'google.routeMatrix',
            metric: 'billable_elements',
            unit: 'matrix_element',
          }
        : sku === 'maps.dynamic.ios'
          ? {
              service: 'google.maps_sdk_ios',
              operation: 'google.maps_sdk_ios',
              metric: 'map_loads',
              unit: 'map_load',
            }
          : {
              service: 'google.places',
              operation: 'google.details.quality',
              metric: 'requests',
              unit: 'request',
            };
    await db.execute(sql`
      insert into provider_usage_meter_daily
        (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
         quantity, unit, source, confidence)
      values (${over.day ?? TODAY}::date, ${ENV}, 'google', ${shape.service}, ${shape.operation},
              ${shape.metric}, ${sku}, ${quantity}, ${shape.unit}, ${over.source ?? 'ledger'}, 'HIGH')
    `);
  }

  it('writes ESTIMATED rows for priced SKUs, none for unknown prices, and is idempotent', async () => {
    await seedUsage('places.details.enterprise', 1_100);
    await seedUsage('routes.computeRouteMatrix', 50);
    await seedUsage('maps.dynamic.ios', 7);
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    const range = { from: `${TODAY.slice(0, 7)}-01`, to: TODAY };

    const first = await estimator.recompute(range);
    expect(first.rowsWritten).toBe(2);
    expect(first.unpriced).toEqual([{ billingSkuId: 'maps.dynamic.ios', day: TODAY }]);

    const second = await estimator.recompute(range);
    expect(second).toMatchObject({ rowsWritten: 2, rowsDeleted: 2 });

    const rows = await costRows();
    expect(rows).toEqual([
      expect.objectContaining({
        billing_sku_id: 'places.details.enterprise',
        // 1,100 Enterprise Details, 1,000 free → 100 × $20/1k = $2.00.
        amount_micros: 2_000_000,
        basis: 'ESTIMATED',
        source: ESTIMATOR_SOURCE,
        pricing_version: '2026-09-01',
        billable_quantity: 1_100,
      }),
      expect.objectContaining({
        billing_sku_id: 'routes.computeRouteMatrix',
        // 50 matrix elements inside the 10,000/month cap → a $0 row, not an
        // absent one (COST-BE-031, #410).
        amount_micros: 0,
        basis: 'ESTIMATED',
        source: ESTIMATOR_SOURCE,
        pricing_version: '2026-09-01',
        billable_quantity: 50,
      }),
    ]);
  });

  it('never touches an ACTUAL row or another source in the same range', async () => {
    await seedUsage('places.details.enterprise', 10);
    await db.execute(sql`
      insert into provider_cost_daily
        (day, environment, provider_id, service_id, billing_sku_id, amount_micros, currency,
         basis, confidence, source)
      values (${TODAY}::date, ${ENV}, 'google', 'google.places', 'places.details.enterprise',
              8_310_000, 'USD', 'ACTUAL', 'HIGH', 'gcp_billing_export'),
             (${TODAY}::date, ${ENV}, 'google', 'google.places', 'places.details.enterprise',
              1, 'USD', 'ESTIMATED', 'LOW', 'prometheus_backfill')
    `);
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    await estimator.recompute({ from: TODAY, to: TODAY });
    await estimator.recompute({ from: TODAY, to: TODAY });

    const rows = await costRows();
    expect(rows.map((r) => [r.basis, r.source, r.amount_micros])).toEqual([
      ['ACTUAL', 'gcp_billing_export', 8_310_000],
      ['ESTIMATED', 'estimator', 0],
      ['ESTIMATED', 'prometheus_backfill', 1],
    ]);
  });

  it('walks the monthly allowance from the 1st even when recomputing one day', async () => {
    const first = `${TODAY.slice(0, 7)}-01`;
    if (first === TODAY) return; // nothing earlier in the month to walk over
    await seedUsage('places.details.enterprise', 1_000, { day: first });
    await seedUsage('places.details.enterprise', 100);
    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    const result = await estimator.recompute({ from: TODAY, to: TODAY });
    expect(result.rowsWritten).toBe(1);
    const rows = await costRows();
    // The 1,000 on the 1st consumed the cap; today's 100 are all billable.
    expect(rows[0]).toMatchObject({ amount_micros: 2_000_000, billable_quantity: 100 });
  });
});
