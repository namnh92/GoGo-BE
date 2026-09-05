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
 * `provider_cost_daily` with mixed bases — with the forecast as COST-BE-034
 * (ADR-0015) defines it: usage extrapolated, subscriptions committed,
 * one-offs counted once.
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
    kind: 'USAGE' | 'RECURRING' | 'ONE_TIME';
    periodAmount: number;
  }> = {},
) {
  const p = over.provider ?? 'google';
  const s = over.service ?? 'google.places';
  const sku = over.sku === undefined ? 'places.details.enterprise' : over.sku;
  const kind = over.kind ?? 'USAGE';
  await db.execute(sql`
    insert into provider_cost_daily
      (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
       amount_micros, currency, basis, confidence, source, cost_kind, billing_cadence, period_amount_micros)
    values (${day}::date, ${ENV}, ${p}, ${s}, ${sku === null ? null : 'google.details.quality'}, ${sku === null ? null : 'requests'}, ${sku},
            ${over.amount ?? 0}, 'USD', ${over.basis ?? 'ESTIMATED'}, ${over.confidence ?? 'MEDIUM'}, ${over.source ?? 'estimator'},
            ${kind}, ${kind === 'RECURRING' ? 'MONTHLY' : null},
            ${kind === 'RECURRING' ? (over.periodAmount ?? over.amount ?? 0) : null})
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

  it('reports the month after precedence, per budget scope, with the three forecast numbers', async () => {
    // 10 elapsed days (NOW = Sept 10). Places: $1.00/day estimated for 10 days,
    // with day 3 also ACTUAL $1.10 (shadows the estimate). Routes: nothing.
    // Cost-of-cost FIXED $0.01/day against a declared $0.30/month. Upstash
    // MANUAL one-off $2.00 on day 1.
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
        kind: 'RECURRING',
        periodAmount: 300_000,
      });
    await cost('2026-09-01', {
      provider: 'upstash',
      service: 'upstash.redis',
      sku: null,
      amount: 2_000_000,
      basis: 'MANUAL',
      confidence: 'HIGH',
      source: 'manual_cost_items',
      kind: 'ONE_TIME',
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
    expect(o.spend.byKind).toEqual({ USAGE: 10_100_000, RECURRING: 100_000, ONE_TIME: 2_000_000 });

    // ADR-0015: only usage is extrapolated — 10.10 over 10 days × 30 = 30.30.
    // The monitoring model is committed at its declared 0.30 (0.10 landed,
    // 0.20 to come); the one-off is counted once. Never 12.20 ÷ 10 × 30.
    expect(o.forecast.actual).toEqual({
      micros: 12_200_000,
      byKind: { USAGE: 10_100_000, RECURRING: 100_000, ONE_TIME: 2_000_000 },
    });
    expect(o.forecast.usage).toEqual({
      mtdMicros: 10_100_000,
      projectedMicros: 30_300_000,
      reason: null,
    });
    expect(o.forecast.recurring).toEqual({
      landedMicros: 100_000,
      scheduledMicros: 200_000,
      committedMicros: 300_000,
    });
    expect(o.forecast.oneTime).toEqual({ landedMicros: 2_000_000, scheduledMicros: 0 });
    expect(o.forecast.cash).toEqual({ micros: 32_600_000, floorMicros: 2_300_000, partial: false });
    expect(o.forecast.runRate).toEqual({
      micros: 30_600_000,
      usageMicros: 30_300_000,
      recurringMonthlyMicros: 300_000,
      annualEquivalentMicros: 0,
      oneTimeExcludedMicros: 2_000_000,
    });
    expect(o.forecast.scheduled).toEqual([
      expect.objectContaining({
        key: 'monitoring_cost_model|gogo|gogo.cost_observability',
        amountMicros: 200_000,
        day: null,
      }),
    ]);

    const byScope = Object.fromEntries(
      o.budgets.map((b) => [`${b.scope.kind}:${b.scope.id ?? ''}`, b]),
    );
    expect(byScope['TOTAL:']).toMatchObject({
      usedMicros: 12_200_000,
      projectedMicros: 32_600_000,
      projectedFloorMicros: 2_300_000,
      runRateMicros: 30_600_000,
      state: 'projected_exceed',
    });
    expect(byScope['SERVICE:google.places']).toMatchObject({
      usedMicros: 10_100_000,
      projectedMicros: 30_300_000,
      projectedFloorMicros: 0,
      state: 'projected_exceed',
    });
    // Upstash collects usage but priced nothing this month: its cash forecast
    // is partial (null) with the one-off as its floor; already exceeded anyway.
    expect(byScope['PROVIDER:upstash']).toMatchObject({
      usedMicros: 2_000_000,
      projectedMicros: null,
      projectedFloorMicros: 2_000_000,
      runRateMicros: null,
      state: 'exceeded',
      remainingMicros: 0,
    });
    expect(o.byService.map((s) => [s.serviceId, s.micros])).toEqual([
      ['gogo.cost_observability', 100_000],
      ['google.places', 10_100_000],
      ['upstash.redis', 2_000_000],
    ]);
  });

  it('a manual item bills on its date: ahead of it the cash forecast schedules it, past it the row is landed', async () => {
    // A $12 VPS anchored on the 15th, entered on the 10th; nothing landed yet.
    await db.execute(sql`
      insert into manual_cost_items (environment, provider_id, service_id, name, amount_micros, currency, period, effective_from)
      values (${ENV}, 'hosting', 'hosting.vps', 'VPS', 12_000_000, 'USD', 'MONTHLY', '2026-01-15'::date)
    `);
    // A $99 Apple fee renewing in January: run-rate as a twelfth, never September cash.
    await db.execute(sql`
      insert into manual_cost_items (environment, provider_id, service_id, name, amount_micros, currency, period, effective_from)
      values (${ENV}, 'apple', 'apple.developer_program', 'Apple', 99_000_000, 'USD', 'YEARLY', '2026-01-15'::date)
    `);
    const svc = new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: NOW,
      audit: writeAudit,
    });
    await svc.upsert(
      { scope: { kind: 'PROVIDER', id: 'hosting' }, monthMicros: 10_000_000 },
      { adminId: null },
    );
    const before = await svc.overview('2026-09');
    expect(before.forecast.actual.micros).toBe(0);
    expect(before.forecast.recurring).toEqual({
      landedMicros: 0,
      scheduledMicros: 12_000_000,
      committedMicros: 12_000_000,
    });
    expect(before.forecast.scheduled.map((c) => [c.name, c.day, c.amountMicros])).toEqual([
      ['VPS', '2026-09-15', 12_000_000],
    ]);
    // Usage is expected somewhere in TOTAL scope and none was priced: partial, with a floor.
    expect(before.forecast.usage.reason).toBe('NO_USAGE_ROWS');
    expect(before.forecast.cash).toEqual({ micros: null, floorMicros: 12_000_000, partial: true });
    expect(before.forecast.runRate).toMatchObject({
      micros: null,
      recurringMonthlyMicros: 12_000_000,
      annualEquivalentMicros: 8_250_000,
    });
    // The hosting budget: a manual-only provider, so its usage half is a known 0
    // and its $12 commitment already exceeds the $10 budget.
    const hosting = before.budgets.find((b) => b.scope.id === 'hosting')!;
    expect(hosting).toMatchObject({
      usedMicros: 0,
      projectedMicros: 12_000_000,
      projectedFloorMicros: 12_000_000,
      runRateMicros: 12_000_000,
      state: 'projected_exceed',
    });

    // The 15th passes and the materialiser writes the charge: landed, nothing scheduled, same cash.
    await cost('2026-09-15', {
      provider: 'hosting',
      service: 'hosting.vps',
      sku: null,
      amount: 12_000_000,
      basis: 'MANUAL',
      confidence: 'HIGH',
      source: `manual_cost_items:${
        (
          (await db.execute(sql`select id from manual_cost_items where name = 'VPS'`)).rows[0] as {
            id: string;
          }
        ).id
      }`,
      kind: 'RECURRING',
      periodAmount: 12_000_000,
    });
    const after = await new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: () => new Date('2026-09-20T12:00:00Z'),
      audit: writeAudit,
    }).overview('2026-09');
    expect(after.forecast.actual.byKind.RECURRING).toBe(12_000_000);
    expect(after.forecast.recurring).toEqual({
      landedMicros: 12_000_000,
      scheduledMicros: 0,
      committedMicros: 12_000_000,
    });
    expect(after.forecast.scheduled).toEqual([]);
    expect(after.forecast.cash.floorMicros).toBe(12_000_000);
    await db.execute(sql`delete from manual_cost_items`);
  });

  it('the usage half is null early in the month, and an empty month reports zero spend with no forecast', async () => {
    const early = new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: () => new Date('2026-09-02T00:00:00Z'),
      audit: writeAudit,
    });
    await cost('2026-09-01', { amount: 1 });
    const o = await early.overview();
    expect(o.forecast.usage).toMatchObject({
      projectedMicros: null,
      reason: 'INSUFFICIENT_HISTORY',
    });
    expect(o.forecast.cash).toEqual({ micros: null, floorMicros: 0, partial: true });
    const empty = await new BudgetService(db as never, COST_REGISTRY, {
      environment: ENV,
      now: NOW,
      audit: writeAudit,
    }).overview('2026-07');
    expect(empty.spend.micros).toBe(0);
    expect(empty.forecast.usage).toMatchObject({ projectedMicros: null, reason: 'NO_USAGE_ROWS' });
    expect(empty.forecast.cash.micros).toBeNull();
    expect(empty.byService).toEqual([]);
  });
});
