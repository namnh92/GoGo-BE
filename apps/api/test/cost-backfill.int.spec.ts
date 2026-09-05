import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import type { MetricsQueryPort, PromSeries } from '@gogo/providers';
import {
  BACKFILL_SOURCE,
  CostEstimatorService,
  PrometheusBackfillService,
  ReconciliationService,
  writeAudit,
} from '@gogo/modules';

/**
 * COST-BE-021 (#380) — backfill and reconciliation against a real Postgres:
 * rows land under their own source, a re-run replaces rather than adds, the
 * estimator prices the backfilled view separately, ACTUAL rows are never
 * touched, and `reconciled_at` is stamped only on matched pairs.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';

/** A store that answers the two backfill queries from a per-day fixture. */
function fakeMetrics(
  fixture: Record<string, { requests: PromSeries[]; costUnits: PromSeries[] }>,
): MetricsQueryPort {
  return {
    async query() {
      return [];
    },
    async queryRange(promql, start) {
      const day = start.toISOString().slice(0, 10);
      const f = fixture[day];
      if (!f) return [];
      return promql.includes('places_provider_cost_units') ? f.costUnits : f.requests;
    },
  };
}

const s = (labels: Record<string, string>, v: number): PromSeries => ({
  labels,
  points: [
    { t: 0, v: 0 },
    { t: 1, v },
  ],
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_backfill_test')
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
  await db.execute(sql`delete from provider_usage_meter_daily`);
  await db.execute(sql`delete from provider_cost_daily`);
  await db.execute(sql`delete from audit_logs`);
});

describe('PrometheusBackfillService (epic §25)', () => {
  it('writes LOW-confidence rows under its own source, replaces on re-run, audits, and the estimator prices them', async () => {
    const metrics = fakeMetrics({
      '2026-09-01': {
        requests: [
          s({ method: 'google.routeMatrix', status: '200' }, 6.02),
          s({ method: 'google.details.quality', status: '200' }, 1_100.4),
        ],
        costUnits: [
          s({ sku: 'routes.computeRouteMatrix' }, 25.9),
          s({ sku: 'google.details.quality' }, 1_100.4),
        ],
      },
      '2026-09-02': {
        requests: [s({ method: 'google.routeMatrix', status: '200' }, 4)],
        costUnits: [s({ sku: 'routes.computeRouteMatrix' }, 14)],
      },
    });
    const backfill = new PrometheusBackfillService(db as never, metrics, writeAudit);
    const first = await backfill.run({ environment: ENV, from: '2026-09-01', to: '2026-09-03' });
    expect(first).toMatchObject({ days: 3, rowsWritten: 6, emptyDays: ['2026-09-03'] });

    const again = await backfill.run({ environment: ENV, from: '2026-09-01', to: '2026-09-03' });
    expect(again.rowsWritten).toBe(6);
    const rows = await db.execute(sql`
      select to_char(day,'YYYY-MM-DD') as day, operation_id, usage_metric_id, quantity, source, confidence
      from provider_usage_meter_daily where environment = ${ENV} order by day, operation_id, usage_metric_id
    `);
    expect(
      rows.rows.map((r) => [
        (r as { day: string }).day,
        (r as { operation_id: string }).operation_id,
        (r as { usage_metric_id: string }).usage_metric_id,
        Number((r as { quantity: number }).quantity),
        (r as { source: string }).source,
        (r as { confidence: string }).confidence,
      ]),
    ).toEqual([
      ['2026-09-01', 'google.details.quality', 'calls', 1_100, BACKFILL_SOURCE, 'LOW'],
      ['2026-09-01', 'google.details.quality', 'requests', 1_100, BACKFILL_SOURCE, 'LOW'],
      ['2026-09-01', 'google.routeMatrix', 'billable_elements', 25, BACKFILL_SOURCE, 'LOW'],
      ['2026-09-01', 'google.routeMatrix', 'calls', 6, BACKFILL_SOURCE, 'LOW'],
      ['2026-09-02', 'google.routeMatrix', 'billable_elements', 14, BACKFILL_SOURCE, 'LOW'],
      ['2026-09-02', 'google.routeMatrix', 'calls', 4, BACKFILL_SOURCE, 'LOW'],
    ]);
    const audits = await db.execute(
      sql`select action, resource_id, diff from audit_logs order by created_at`,
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows[0]).toMatchObject({
      action: 'cost.backfill',
      resource_id: 'dev:2026-09-01..2026-09-03',
    });

    // The estimator prices the backfilled source on its own: 1,100 Enterprise
    // Details, 1,000 free → 100 × $20/1k = $2.00; Routes 25 + 14 elements sit
    // inside the 10,000/month cap → two $0 rows (COST-BE-031, #410).
    const est = new CostEstimatorService(db as never, { environment: ENV });
    const result = await est.recompute({ from: '2026-09-01', to: '2026-09-02' });
    expect(result.rowsWritten).toBe(3);
    expect(result.unpriced).toEqual([]);
    const cost = await db.execute(sql`
      select billing_sku_id, amount_micros, basis, source, metadata from provider_cost_daily
      where environment = ${ENV} order by billing_sku_id, day
    `);
    expect(
      cost.rows.map((r) => [
        (r as { billing_sku_id: string }).billing_sku_id,
        Number((r as { amount_micros: number }).amount_micros),
        (r as { metadata: { usageSource: string } }).metadata.usageSource,
      ]),
    ).toEqual([
      ['places.details.enterprise', 2_000_000, BACKFILL_SOURCE],
      ['routes.computeRouteMatrix', 0, BACKFILL_SOURCE],
      ['routes.computeRouteMatrix', 0, BACKFILL_SOURCE],
    ]);
  });

  it('refuses a range past the bound and never touches cost rows', async () => {
    await db.execute(sql`
      insert into provider_cost_daily (day, environment, provider_id, service_id, billing_sku_id, amount_micros, currency, basis, confidence, source)
      values ('2026-09-01', ${ENV}, 'google', 'google.places', 'places.details.enterprise', 8_310_000, 'USD', 'ACTUAL', 'HIGH', 'gcp_billing_export')
    `);
    const backfill = new PrometheusBackfillService(db as never, fakeMetrics({}), writeAudit);
    await expect(
      backfill.run({ environment: ENV, from: '2026-01-01', to: '2026-12-31' }),
    ).rejects.toThrow(/62-day bound/);
    await backfill.run({ environment: ENV, from: '2026-09-01', to: '2026-09-01' });
    const cost = await db.execute(
      sql`select count(*)::int as n, max(amount_micros)::bigint as a from provider_cost_daily`,
    );
    expect(cost.rows[0]).toMatchObject({ n: 1 });
    expect(Number((cost.rows[0] as { a: number }).a)).toBe(8_310_000);
  });
});

describe('ReconciliationService (epic §26)', () => {
  it('computes variance only where an actual exists, and stamps reconciled_at on matched pairs only', async () => {
    const ins = (
      day: string,
      sku: string | null,
      amount: number,
      basis: string,
      source: string,
      service = 'google.places',
    ) =>
      db.execute(sql`
        insert into provider_cost_daily (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id, amount_micros, currency, basis, confidence, source)
        values (${day}::date, ${ENV}, 'google', ${service}, ${sku === null ? null : 'google.details.quality'}, ${sku === null ? null : 'requests'}, ${sku}, ${amount}, 'USD', ${basis}, ${basis === 'ACTUAL' ? 'HIGH' : 'MEDIUM'}, ${source})
      `);
    await ins('2026-09-01', 'places.details.enterprise', 8_200_000, 'ESTIMATED', 'estimator');
    await ins('2026-09-01', 'places.details.enterprise', 8_310_000, 'ACTUAL', 'gcp_billing_export');
    await ins('2026-09-02', 'places.details.enterprise', 1_000_000, 'ESTIMATED', 'estimator');
    await ins(
      '2026-09-02',
      'routes.computeRouteMatrix',
      500_000,
      'ESTIMATED',
      'estimator',
      'google.routes',
    );

    const svc = new ReconciliationService(db as never, { environment: ENV });
    const lines = await svc.compute('2026-09');
    expect(lines).toEqual([
      expect.objectContaining({
        serviceId: 'google.places',
        estimatedMicros: 9_200_000,
        actualMicros: 8_310_000,
        varianceMicros: -890_000,
        matchedKeys: 1,
      }),
      expect.objectContaining({
        serviceId: 'google.routes',
        estimatedMicros: 500_000,
        actualMicros: null,
        varianceMicros: null,
        variancePct: null,
      }),
    ]);

    expect(await svc.markReconciled('2026-09')).toBe(2);
    expect(await svc.markReconciled('2026-09')).toBe(0);
    const stamped = await db.execute(
      sql`select count(*)::int as n from provider_cost_daily where reconciled_at is not null`,
    );
    expect((stamped.rows[0] as { n: number }).n).toBe(2);
  });
});
