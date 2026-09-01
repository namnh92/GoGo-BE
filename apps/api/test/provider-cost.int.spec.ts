import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { DbUsageLedger, ProviderBudgetService, UsageReportService } from '@gogo/modules';
import { NoopMetrics } from '@gogo/observability';
import { FakePlaceProvider } from '@gogo/providers';

/**
 * COST-BE-002 (#335) — the two cost tables against a real Postgres.
 *
 * The unit tests prove the arithmetic. These prove the two things only a real
 * database can: that the ledger's count matches the number of provider calls
 * actually made, and that the reservation is atomic when two callers race.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let budget: ProviderBudgetService;
let usage: UsageReportService;

const ENV = 'int-test';
const DAY = '2026-09-15';

const ledgerFor = (enabled = true) =>
  new DbUsageLedger(new NoopMetrics(), db, { environment: ENV, enabled, flushMs: 60_000 });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  budget = new ProviderBudgetService(db);
  usage = new UsageReportService(db);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate provider_usage_daily`);
  await db.execute(sql`truncate provider_budget_daily`);
});

describe('the ledger counts what the provider was actually asked for', () => {
  it('matches the number of fake-adapter calls, one row per operation', async () => {
    const ledger = ledgerFor();
    const places = new FakePlaceProvider(ledger);
    places.seed({ providerPlaceId: 'ChIJ1' });
    places.seed({ providerPlaceId: 'ChIJ2' });

    // Three real resolutions through the adapter, which emits the same
    // counters the Google adapter does.
    await places.details('ChIJ1');
    await places.details('ChIJ2');
    await places.details('ChIJ1');
    await ledger.flush();

    const rows = await usage.dailyUsage(ENV);
    const quality = rows.find((r) => r.operation === 'google.details.quality');
    // The acceptance criterion in #335: ledger delta equals the fake call
    // count. Not "roughly equals" — a cost figure that drifts from the calls
    // that produced it cannot be reconciled against an invoice.
    expect(quality?.callsAttempted).toBe(3);
    expect(quality?.callsSucceeded).toBe(3);
    expect(quality?.billableUnits).toBe(3);
  });

  it('accumulates across flushes instead of overwriting the day', async () => {
    const ledger = ledgerFor();
    const places = new FakePlaceProvider(ledger);
    places.seed({ providerPlaceId: 'ChIJ1' });

    await places.details('ChIJ1');
    await ledger.flush();
    await places.details('ChIJ1');
    await ledger.flush();

    const rows = await usage.dailyUsage(ENV);
    // The upsert adds; a second flush must not replace the first window's
    // count with its own.
    expect(rows.find((r) => r.operation === 'google.details.quality')?.callsAttempted).toBe(2);
  });

  it('keeps environments apart, so DEV traffic is not production spend', async () => {
    const dev = new DbUsageLedger(new NoopMetrics(), db, {
      environment: 'dev',
      enabled: true,
      flushMs: 60_000,
    });
    const prod = new DbUsageLedger(new NoopMetrics(), db, {
      environment: 'prod',
      enabled: true,
      flushMs: 60_000,
    });
    const devPlaces = new FakePlaceProvider(dev);
    const prodPlaces = new FakePlaceProvider(prod);
    devPlaces.seed({ providerPlaceId: 'ChIJdev' });
    prodPlaces.seed({ providerPlaceId: 'ChIJprod' });

    await devPlaces.details('ChIJdev');
    await devPlaces.details('ChIJdev');
    await prodPlaces.details('ChIJprod');
    await dev.flush();
    await prod.flush();

    expect((await usage.dailyUsage('dev'))[0]?.callsAttempted).toBe(2);
    expect((await usage.dailyUsage('prod'))[0]?.callsAttempted).toBe(1);
  });

  it('writes nothing at all while disabled', async () => {
    const ledger = ledgerFor(false);
    const places = new FakePlaceProvider(ledger);
    places.seed({ providerPlaceId: 'ChIJ1' });

    await places.details('ChIJ1');
    await ledger.flush();

    // The rollback path: off means the table stays empty, not that it fills
    // with zeroes.
    expect(await usage.dailyUsage(ENV)).toEqual([]);
  });

  it('reports month-to-date units per operation for the free-cap estimate', async () => {
    const ledger = ledgerFor();
    const places = new FakePlaceProvider(ledger);
    places.seed({ providerPlaceId: 'ChIJ1' });
    await places.details('ChIJ1');
    await ledger.flush();

    const mtd = await usage.monthToDateUnits(ENV);
    expect(mtd.get('google.details.quality')).toBe(1);
    // A different month must not leak in.
    expect((await usage.monthToDateUnits(ENV, '2026-08-15')).size).toBe(0);
  });
});

describe('the budget is a ceiling, not a suggestion', () => {
  const limits = {
    maxCallsPerDay: 10,
    maxUnitsPerOperation: 10,
    // $0.20 = 10 quality calls at $20/1k. The cost ceiling binds at exactly
    // the same point as the call ceiling here, which the tests below separate.
    maxListCostMicrosPerDay: 200_000,
  };

  it('grants up to the ceiling and refuses the call after it', async () => {
    for (let i = 0; i < 10; i += 1) {
      const granted = await budget.reserve({
        scope: 'google.places.refresh',
        operation: 'google.details.quality',
        calls: 1,
        units: 1,
        limits,
        day: DAY,
      });
      expect(granted.granted, `call ${i + 1}`).toBe(true);
    }

    const refused = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 1,
      units: 1,
      limits,
      day: DAY,
    });
    expect(refused.granted).toBe(false);
  });

  it('refuses the (N+1)th under two concurrent callers, not the (N+2)th', async () => {
    // The whole point of doing this in one statement. Two callers checking and
    // then writing would both pass a check the other invalidated, and the
    // ceiling would be exceeded by exactly the number of racers.
    const attempts = Array.from({ length: 20 }, () =>
      budget.reserve({
        scope: 'google.places.refresh',
        operation: 'google.details.quality',
        calls: 1,
        units: 1,
        limits,
        day: DAY,
      }),
    );
    const results = await Promise.all(attempts);

    expect(results.filter((r) => r.granted)).toHaveLength(10);
    expect(results.filter((r) => !r.granted)).toHaveLength(10);

    const [row] = await budget.reservedToday('google.places.refresh', DAY);
    expect(row?.calls).toBe(10);
  });

  it('survives a restart, because the ceiling lives in Postgres', async () => {
    await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 10,
      units: 10,
      limits,
      day: DAY,
    });

    // A brand-new service instance, as after a deploy. An in-memory or
    // per-replica counter would hand out the whole ceiling again here.
    const afterRestart = new ProviderBudgetService(db);
    const refused = await afterRestart.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 1,
      units: 1,
      limits,
      day: DAY,
    });
    expect(refused.granted).toBe(false);
  });

  it('caps units per operation, while calls stay under the scope ceiling', async () => {
    const wide = { ...limits, maxCallsPerDay: 1_000, maxListCostMicrosPerDay: 1_000_000_000 };
    const first = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'routes.computeRouteMatrix',
      calls: 1,
      units: 10,
      limits: wide,
      day: DAY,
    });
    expect(first.granted).toBe(true);

    // One more call, but it would take the operation's units past 10.
    const refused = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'routes.computeRouteMatrix',
      calls: 1,
      units: 1,
      limits: wide,
      day: DAY,
    });
    expect(refused.granted).toBe(false);
    expect(refused.granted === false && refused.reason).toBe('UNITS');
  });

  it('caps list cost across operations within a scope', async () => {
    const wide = {
      maxCallsPerDay: 1_000,
      maxUnitsPerOperation: 1_000,
      maxListCostMicrosPerDay: 200_000,
    };
    // 9 quality calls = $0.18. Under the cost ceiling.
    expect(
      (
        await budget.reserve({
          scope: 'google.places.refresh',
          operation: 'google.details.quality',
          calls: 9,
          units: 9,
          limits: wide,
          day: DAY,
        })
      ).granted,
    ).toBe(true);

    // 2 core calls = $0.034, which would take the scope past $0.20 in total.
    // The ceiling is per scope, not per operation, so a cheap SKU cannot slip
    // past a budget an expensive one has nearly exhausted.
    const refused = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.core',
      calls: 2,
      units: 2,
      limits: wide,
      day: DAY,
    });
    expect(refused.granted).toBe(false);
    expect(refused.granted === false && refused.reason).toBe('COST');
  });

  it('never deducts the free tier — the guard prices as if nothing were free', async () => {
    // 100 quality calls sit entirely inside Google's 1,000/month free cap, and
    // the guard still charges $2.00 against the budget. GoGo cannot see the
    // real pool (it spans every project on the billing account), so an
    // optimistic "still free" reading must never authorise a paid call.
    const refused = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 100,
      units: 100,
      limits: {
        maxCallsPerDay: 1_000,
        maxUnitsPerOperation: 1_000,
        maxListCostMicrosPerDay: 1_999_999,
      },
      day: DAY,
    });
    expect(refused.granted).toBe(false);
    expect(refused.granted === false && refused.reason).toBe('COST');
  });

  it('refuses an operation it cannot price rather than treating it as free', async () => {
    const refused = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.maps_sdk_ios',
      calls: 1,
      units: 1,
      limits,
      day: DAY,
    });
    // Treating an unpriced SKU as costing nothing is how an unmetered surface
    // runs up an invoice nobody budgeted for.
    expect(refused.granted).toBe(false);
    expect(refused.granted === false && refused.reason).toBe('UNPRICEABLE');
    expect(await budget.reservedToday('google.places.refresh', DAY)).toEqual([]);
  });

  it('keeps scopes independent', async () => {
    await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 10,
      units: 10,
      limits,
      day: DAY,
    });
    // Import has its own ceiling; a refresh that used all of its own budget
    // must not close the door on a different spender.
    const importReservation = await budget.reserve({
      scope: 'google.places.import',
      operation: 'google.details.quality',
      calls: 1,
      units: 1,
      limits,
      day: DAY,
    });
    expect(importReservation.granted).toBe(true);
  });

  it('does not refund a day that has rolled over', async () => {
    await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 10,
      units: 10,
      limits,
      day: DAY,
    });
    // Tomorrow is a fresh ceiling — the budget is per day, and yesterday's
    // reservations are history rather than a running total.
    const tomorrow = await budget.reserve({
      scope: 'google.places.refresh',
      operation: 'google.details.quality',
      calls: 1,
      units: 1,
      limits,
      day: '2026-09-16',
    });
    expect(tomorrow.granted).toBe(true);
  });
});
