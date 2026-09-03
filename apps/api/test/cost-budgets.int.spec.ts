import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { BudgetService, COST_REGISTRY, writeAudit } from '@gogo/modules';

/**
 * COST-BE-020 (#379) — monthly budgets and forecast against a real Postgres:
 * the COALESCE key on TOTAL scope, the audit rows, and the month window over
 * `provider_cost_daily` with mixed bases.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';
const NOW = () => new Date('2026-09-10T12:00:00Z');

async function cost(
  day: string,
  over: Partial<{
    provider: string;
    service: string;
    sku: string | null;
    amount: number;
    basis: string;
    confidence: string;
    source: string;
  }> = {},
) {
  const p = over.provider ?? 'google';
  const s = over.service ?? 'google.places';
  const sku = over.sku === undefined ? 'places.details.enterprise' : over.sku;
  await db.execute(sql`
    insert into provider_cost_daily
      (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
       amount_micros, currency, basis, confidence, source)
    values (${day}::date, ${ENV}, ${p}, ${s}, ${sku === null ? null : 'google.details.quality'}, ${sku === null ? null : 'requests'}, ${sku},
            ${over.amount ?? 0}, 'USD', ${over.basis ?? 'ESTIMATED'}, ${over.confidence ?? 'MEDIUM'}, ${over.source ?? 'estimator'})
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_budgets_test')
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
  await db.execute(sql`delete from cost_budgets`);
  await db.execute(sql`delete from provider_cost_daily`);
  await db.execute(sql`delete from audit_logs`);
});

describe('BudgetService (epic §32–§33)', () => {
  it('upserts one budget per scope, refuses unknown registry ids, and audits the change', async () => {
    const svc = new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: NOW,
      audit: writeAudit,
    });
    await svc.upsert(
      { scope: { kind: 'TOTAL', id: null }, monthMicros: 50_000_000 },
      { adminId: null },
    );
    await svc.upsert(
      { scope: { kind: 'TOTAL', id: null }, monthMicros: 60_000_000 },
      { adminId: null },
    );
    await svc.upsert(
      { scope: { kind: 'PROVIDER', id: 'google' }, monthMicros: 30_000_000 },
      { adminId: null },
    );
    await svc.upsert(
      {
        scope: { kind: 'SERVICE', id: 'google.places' },
        monthMicros: 20_000_000,
        note: 'Places only',
      },
      { adminId: null },
    );
    await expect(
      svc.upsert({ scope: { kind: 'PROVIDER', id: 'vietmap' }, monthMicros: 1 }, { adminId: null }),
    ).rejects.toThrow(/unknown provider/);
    await expect(
      svc.upsert(
        { scope: { kind: 'SERVICE', id: 'google.nope' }, monthMicros: 1 },
        { adminId: null },
      ),
    ).rejects.toThrow(/unknown service/);

    const list = await svc.list();
    expect(list.map((b) => [b.scope.kind, b.scope.id, b.monthMicros])).toEqual([
      ['PROVIDER', 'google', 30_000_000],
      ['SERVICE', 'google.places', 20_000_000],
      ['TOTAL', null, 60_000_000],
    ]);
    const audits = await db.execute(sql`select action, diff from audit_logs order by created_at`);
    expect(audits.rows.map((r) => (r as { action: string }).action)).toEqual([
      'cost.budget.set',
      'cost.budget.set',
      'cost.budget.set',
      'cost.budget.set',
    ]);
    expect(
      (audits.rows[1] as { diff: { monthMicros: { before: number; after: number } } }).diff
        .monthMicros,
    ).toEqual({ before: 50_000_000, after: 60_000_000 });
  });

  it('reports the month after precedence, per budget scope, with a forecast', async () => {
    // 10 elapsed days (NOW = Sept 10). Places: $1.00/day estimated for 10 days,
    // with day 3 also ACTUAL $1.10 (shadows the estimate). Routes: nothing.
    // Cost-of-cost FIXED $0.01/day. Upstash MANUAL one-off $2.00 on day 1.
    for (let d = 1; d <= 10; d += 1)
      await cost(`2026-09-${String(d).padStart(2, '0')}`, { amount: 1_000_000 });
    await cost('2026-09-03', {
      amount: 1_100_000,
      basis: 'ACTUAL',
      confidence: 'HIGH',
      source: 'gcp_billing_export',
    });
    for (let d = 1; d <= 10; d += 1)
      await cost(`2026-09-${String(d).padStart(2, '0')}`, {
        provider: 'gogo',
        service: 'gogo.cost_observability',
        sku: null,
        amount: 10_000,
        basis: 'FIXED',
        confidence: 'HIGH',
        source: 'monitoring_cost_model',
      });
    await cost('2026-09-01', {
      provider: 'upstash',
      service: 'upstash.redis',
      sku: null,
      amount: 2_000_000,
      basis: 'MANUAL',
      confidence: 'HIGH',
      source: 'manual_cost_items',
    });
    // Outside the month: ignored.
    await cost('2026-08-31', { amount: 9_000_000 });

    const svc = new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: NOW,
      audit: writeAudit,
    });
    await svc.upsert(
      { scope: { kind: 'TOTAL', id: null }, monthMicros: 30_000_000 },
      { adminId: null },
    );
    await svc.upsert(
      { scope: { kind: 'SERVICE', id: 'google.places' }, monthMicros: 20_000_000 },
      { adminId: null },
    );
    await svc.upsert(
      { scope: { kind: 'PROVIDER', id: 'upstash' }, monthMicros: 1_000_000 },
      { adminId: null },
    );

    const o = await svc.overview('2026-09');
    // Places: 9 × 1.00 + 1.10 = 10.10; fixed 0.10; manual 2.00 → 12.20.
    expect(o.spend.micros).toBe(12_200_000);
    expect(o.spend.byBasis).toEqual({
      ACTUAL: 1_100_000,
      ESTIMATED: 9_000_000,
      FIXED: 100_000,
      MANUAL: 2_000_000,
    });
    expect(o.spend.shadowedEstimatedMicros).toBe(1_000_000);
    // 12.20 over 10 days × 30 days = 36.60.
    expect(o.forecastMicros).toBe(36_600_000);

    const byScope = Object.fromEntries(
      o.budgets.map((b) => [`${b.scope.kind}:${b.scope.id ?? ''}`, b]),
    );
    expect(byScope['TOTAL:']).toMatchObject({
      usedMicros: 12_200_000,
      projectedMicros: 36_600_000,
      state: 'projected_exceed',
    });
    expect(byScope['SERVICE:google.places']).toMatchObject({
      usedMicros: 10_100_000,
      projectedMicros: 30_300_000,
      state: 'projected_exceed',
    });
    expect(byScope['PROVIDER:upstash']).toMatchObject({
      usedMicros: 2_000_000,
      state: 'exceeded',
      remainingMicros: 0,
    });
    expect(o.byService.map((s) => [s.serviceId, s.micros])).toEqual([
      ['gogo.cost_observability', 100_000],
      ['google.places', 10_100_000],
      ['upstash.redis', 2_000_000],
    ]);
  });

  it('forecast is null early in the month, and an empty month reports zero spend with no forecast', async () => {
    const early = new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: () => new Date('2026-09-02T00:00:00Z'),
      audit: writeAudit,
    });
    await cost('2026-09-01', { amount: 1 });
    expect((await early.overview()).forecastMicros).toBeNull();
    const empty = await new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: NOW,
      audit: writeAudit,
    }).overview('2026-07');
    expect(empty.spend.micros).toBe(0);
    expect(empty.forecastMicros).toBeNull();
    expect(empty.byService).toEqual([]);
  });
});
