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
import {
  DbUsageLedger,
  ProviderBudgetService,
  ProviderUsageReportService,
  budgetLimitsFrom,
  utcDay,
} from '@gogo/modules';

/**
 * #335 (PR2) — durable provider usage accounting and the hard budget, against
 * a real Postgres.
 *
 * Three properties live here and nowhere else, because none of them is a
 * property a fake can have:
 *
 * 1. **The ledger's counts equal the calls that happened.** Driven through the
 *    real adapters with `fetch` stubbed, so what is under test is the
 *    production path — adapter → metrics port → tee → ledger → upsert — and
 *    not a re-statement of the ledger's own arithmetic.
 * 2. **Two concurrent callers cannot both take the last reservation.** That is
 *    a statement about Postgres locking, and it is the whole reason the guard
 *    is a table rather than a counter.
 * 3. **A restart changes nothing.** A fresh service against the same rows sees
 *    the same consumed budget, which an in-process counter would not.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ENV = 'dev';
const TODAY = utcDay();

/** Responses the stubbed `fetch` hands back, in order. */
type Stub = { status: number; body?: unknown; url?: string };
let queued: Stub[] = [];
let requested = 0;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const next = queued.shift() ?? { status: 200, body: {} };
      requested += 1;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        url: next.url ?? String(input),
        json: async () => next.body ?? {},
        text: async () => JSON.stringify(next.body ?? {}),
      };
    }),
  );
}

async function usageRows() {
  const rows = await db.execute(sql`
    select operation, calls_attempted, calls_succeeded, billable_units
    from provider_usage_daily where environment = ${ENV} order by operation
  `);
  return (
    rows.rows as unknown as {
      operation: string;
      calls_attempted: number;
      calls_succeeded: number;
      billable_units: string | number;
    }[]
  ).map((r) => ({
    operation: r.operation,
    attempted: Number(r.calls_attempted),
    succeeded: Number(r.calls_succeeded),
    units: Number(r.billable_units),
  }));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_test')
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
  requested = 0;
  await db.execute(sql`delete from provider_usage_daily`);
  await db.execute(sql`delete from provider_budget_daily`);
});

describe('usage ledger against the real adapters', () => {
  it('records exactly the calls the adapters made, split three ways', async () => {
    stubFetch();
    const ledger = new DbUsageLedger(db as never, { environment: ENV });
    const metrics = new TeeMetrics([new MetricsRegistry(), ledger]);
    const places = new GooglePlacesAdapter('test-key', metrics);

    queued = [
      { status: 200, body: { places: [{ id: 'ChIJ-a' }] } },
      { status: 200, body: { id: 'ChIJ-a', displayName: { text: 'A' } } },
      // Google refusing to serve us is a call that happened and was not
      // billed. Counting it as a success would inflate the invoice estimate;
      // not counting it at all would hide an outage.
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
    ];
    await places.searchCandidates('cà phê quận 1', 1);
    await places.details('ChIJ-a', 'quality');
    await places.details('ChIJ-b', 'quality').catch(() => undefined);
    await ledger.stop();

    const rows = await usageRows();
    expect(rows).toEqual([
      { operation: 'google.details.quality', attempted: 2, succeeded: 1, units: 1 },
      { operation: 'google.searchText', attempted: 1, succeeded: 1, units: 1 },
    ]);
    // The ledger's totals are the calls that were made, not an approximation
    // of them: three fetches, three attempts.
    expect(rows.reduce((n, r) => n + r.attempted, 0)).toBe(requested);
  });

  it('counts Routes by matrix element and folds the SKU onto one operation', async () => {
    stubFetch();
    const ledger = new DbUsageLedger(db as never, { environment: ENV });
    const metrics = new TeeMetrics([new MetricsRegistry(), ledger]);
    const routes = new GoogleRoutesAdapter('test-key', metrics);

    queued = [{ status: 200, body: [] }];
    await routes.matrix(
      { lat: 10.77, lng: 106.7 },
      [
        { lat: 10.78, lng: 106.7 },
        { lat: 10.79, lng: 106.7 },
        { lat: 10.8, lng: 106.7 },
      ],
    );
    await ledger.stop();

    // One row, not two. Unfolded, `routes.computeRouteMatrix` and
    // `google.routeMatrix` render as one operation with the calls and another
    // with the bill (#332) — and the obvious reading of that is backwards.
    expect(await usageRows()).toEqual([
      { operation: 'google.routeMatrix', attempted: 1, succeeded: 1, units: 3 },
    ]);
  });

  it('counts the short-link expansion that used to emit nothing', async () => {
    stubFetch();
    const ledger = new DbUsageLedger(db as never, { environment: ENV });
    const metrics = new TeeMetrics([new MetricsRegistry(), ledger]);
    const places = new GooglePlacesAdapter('test-key', metrics);

    queued = [{ status: 200, url: 'https://maps.google.com/maps?place_id=ChIJ-short' }];
    await places.resolveUrl('https://maps.app.goo.gl/abc123');
    await ledger.stop();

    // Free, but not unmeasured — baseline scenario C2 counts it, and an
    // absence would have read as zero.
    expect(await usageRows()).toEqual([
      { operation: 'google.expand', attempted: 1, succeeded: 1, units: 0 },
    ]);
  });

  it('keeps one environment out of another', async () => {
    stubFetch();
    const dev = new DbUsageLedger(db as never, { environment: 'dev' });
    const prod = new DbUsageLedger(db as never, { environment: 'prod' });
    for (const ledger of [dev, prod]) {
      ledger.increment('places_provider_requests_total', {
        method: 'google.details.core',
        status: 200,
      });
      await ledger.stop();
    }
    // One database serves several deployments. Without the column a DEV
    // console would quietly add production spend to its own numbers.
    expect(await usageRows()).toEqual([
      { operation: 'google.details.core', attempted: 1, succeeded: 1, units: 0 },
    ]);
  });
});

describe('hard budget reservation', () => {
  const limits = budgetLimitsFrom('google.places.refresh', {
    PLACE_REFRESH_DAILY_MAX_CALLS: '3',
    PLACE_REFRESH_DAILY_MAX_LIST_COST_USD: '1',
    PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_LIVENESS: '3',
    PLACE_REFRESH_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY: '2',
  });

  const reserve = (service: ProviderBudgetService, operation: string, calls = 1, units = 1) =>
    service.reserve({ scope: 'google.places.refresh', operation, calls, units }, limits);

  it('refuses the call past the ceiling, even when two callers race for it', async () => {
    const service = new ProviderBudgetService(db as never);
    await reserve(service, 'google.details.liveness');
    await reserve(service, 'google.details.liveness');

    // Two callers, one slot. Exactly one may win — this is the property a
    // Redis counter or an in-process number cannot give across replicas.
    const [a, b] = await Promise.all([
      reserve(service, 'google.details.liveness'),
      reserve(service, 'google.details.liveness'),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const refused = a.ok ? b : a;
    expect(refused).toEqual({ ok: false, reason: 'call_ceiling' });

    const [row] = await db.execute(
      sql`select reserved_calls from provider_budget_daily where scope = 'google.places.refresh'`,
    ).then((r) => r.rows as unknown as { reserved_calls: number }[]);
    expect(Number(row!.reserved_calls)).toBe(3);
  });

  it('holds the per-operation unit ceiling separately from the call ceiling', async () => {
    const service = new ProviderBudgetService(db as never);
    await reserve(service, 'google.details.quality', 1, 2);
    // Calls are still under 3; units for this SKU are not. One expensive tier
    // must not be able to eat the whole allowance.
    expect(await reserve(service, 'google.details.quality', 1, 1)).toEqual({
      ok: false,
      reason: 'unit_ceiling',
    });
  });

  it('refuses on worst-case list price before the call ceiling is reached', async () => {
    const service = new ProviderBudgetService(db as never);
    const costLimits = { ...limits, maxListCostMicrosPerDay: 30_000 };
    // Enterprise Details at $20/1k is 20,000 micros a call. Two calls exceed a
    // $0.03 ceiling while the call ceiling of 3 is still untouched — which is
    // the whole point of a cost-aware guard: "1,000 calls" means $0 of
    // liveness or $20 of Enterprise, and a calls-only ceiling cannot tell
    // those apart.
    expect(
      (
        await service.reserve(
          { scope: 'google.places.refresh', operation: 'google.details.quality', calls: 1, units: 1 },
          costLimits,
        )
      ).ok,
    ).toBe(true);
    expect(
      await service.reserve(
        { scope: 'google.places.refresh', operation: 'google.details.quality', calls: 1, units: 1 },
        costLimits,
      ),
    ).toEqual({ ok: false, reason: 'cost_ceiling' });
  });

  it('refuses an operation whose price nobody has verified', async () => {
    const service = new ProviderBudgetService(db as never);
    // Routes bills per matrix element and no per-element figure is in the
    // registry. A ceiling in dollars cannot bound an unknown price, so the
    // answer is no — not "assume free".
    expect(
      await service.reserve(
        { scope: 'google.places.refresh', operation: 'google.routeMatrix', calls: 1, units: 10 },
        { ...limits, maxUnitsByOperation: { 'google.routeMatrix': 100 } },
      ),
    ).toEqual({ ok: false, reason: 'price_unknown' });
  });

  it('refuses when no ceiling is configured at all', async () => {
    const service = new ProviderBudgetService(db as never);
    // An unset environment variable is the most likely way this guard goes
    // missing in production. It must not read as "no limit".
    expect(
      await service.reserve(
        { scope: 'google.places.refresh', operation: 'google.details.liveness', calls: 1, units: 1 },
        budgetLimitsFrom('google.places.refresh', {}),
      ),
    ).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('survives a restart — the budget is the row, not the process', async () => {
    const first = new ProviderBudgetService(db as never);
    await reserve(first, 'google.details.liveness');
    await reserve(first, 'google.details.liveness');
    await reserve(first, 'google.details.liveness');

    const afterRestart = new ProviderBudgetService(db as never);
    expect(await reserve(afterRestart, 'google.details.liveness')).toEqual({
      ok: false,
      reason: 'call_ceiling',
    });
    expect(await afterRestart.consumed('google.places.refresh', TODAY)).toEqual([
      { operation: 'google.details.liveness', calls: 3, units: 3, costMicros: 0 },
    ]);
  });

  it('does not refund a reservation whose call failed', async () => {
    const service = new ProviderBudgetService(db as never);
    await reserve(service, 'google.details.liveness');
    // There is deliberately no release path. A call that failed still burned
    // Google quota and may still have been billed; refunding it would let a
    // retry storm spend past the ceiling.
    expect('release' in service).toBe(false);
    expect((await service.consumed('google.places.refresh', TODAY))[0]?.calls).toBe(1);
  });

  it('keeps scopes apart', async () => {
    const service = new ProviderBudgetService(db as never);
    await reserve(service, 'google.details.liveness');
    await reserve(service, 'google.details.liveness');
    await reserve(service, 'google.details.liveness');
    const importLimits = budgetLimitsFrom('google.places.import', {
      PLACE_IMPORT_DAILY_MAX_CALLS: '1',
      PLACE_IMPORT_DAILY_MAX_LIST_COST_USD: '1',
      PLACE_IMPORT_DAILY_MAX_UNITS_GOOGLE_DETAILS_LIVENESS: '1',
    });
    expect(
      (
        await service.reserve(
          { scope: 'google.places.import', operation: 'google.details.liveness', calls: 1, units: 1 },
          importLimits,
        )
      ).ok,
    ).toBe(true);
  });
});

describe('cost report from the ledger', () => {
  const report = (ledgerEnabled = true) =>
    new ProviderUsageReportService(db as never, { environment: ENV, ledgerEnabled }).report(TODAY);

  async function seed(operation: string, units: number, day = TODAY) {
    await db.execute(sql`
      insert into provider_usage_daily (day, environment, operation, calls_attempted, calls_succeeded, billable_units)
      values (${day}::date, ${ENV}, ${operation}, ${units}, ${units}, ${units})
      on conflict (day, environment, operation) do update
        set billable_units = provider_usage_daily.billable_units + excluded.billable_units
    `);
  }

  it('prices a known operation and states the estimate as an estimate', async () => {
    await seed('google.details.quality', 1_500);
    const result = await report();
    const places = result.providers.find((p) => p.key === 'places');
    // 1,000 free, 500 billable at $20/1k = $10.00.
    expect(places?.monthToDateMicros).toBe(10_000_000);
    expect(places?.monthToDate).toBe(1_000);
    expect(places?.currency).toBe('USD');
    expect(places?.basis).toBe('estimated');
    expect(result.basis).toBe('ESTIMATED');
    expect(result.confidence).toBe('MEDIUM');
  });

  it('reports a measured zero as zero', async () => {
    const result = await report();
    const places = result.providers.find((p) => p.key === 'places');
    // With the ledger on, no rows means the instrumented operations made no
    // calls. That is a measured zero and it is allowed to be one.
    expect(result.sourcesConfigured).toBe(true);
    expect(places?.monthToDate).toBe(0);
    expect(places?.billableUnitsMonthToDate).toBe(0);
  });

  it('never reports an unpriced provider as free', async () => {
    await seed('google.routeMatrix', 400);
    const result = await report();
    // Units measured exactly, money unknown. The provider is absent from the
    // money list and named in `gaps` — a floor with a currency symbol beside
    // it would be a false claim.
    expect(result.providers.map((p) => p.key)).not.toContain('routes');
    expect(result.gaps.find((g) => g.key === 'google.routeMatrix')?.kind).toBe('price_unknown');
  });

  it('never reports the uninstrumented Maps SDK as zero', async () => {
    const result = await report();
    expect(result.providers.map((p) => p.key)).not.toContain('maps_sdk');
    for (const key of ['google.maps_sdk_ios', 'google.maps_sdk_android']) {
      expect(result.gaps.find((g) => g.key === key)?.kind).toBe('not_instrumented');
    }
  });

  it('consumes the free cap in date order, so the day it is crossed is the day charges start', async () => {
    const first = `${TODAY.slice(0, 7)}-01`;
    await seed('google.details.core', 4_800, first);
    await seed('google.details.core', 400);
    const result = await report();
    const places = result.providers.find((p) => p.key === 'places')!;
    // Details Pro: 5,000 free, $17/1k. 5,200 units → 200 billable = $3.40.
    expect(places.monthToDateMicros).toBe(3_400_000);
    // And all of it lands on today, because that is the day the cap was
    // crossed. Applying the monthly cap per day would have zeroed both.
    expect(places.todayMicros).toBe(3_400_000);
  });

  it('says there is no source when the ledger is off', async () => {
    await seed('google.details.quality', 10);
    const result = await report(false);
    // `COST_LEDGER_ENABLED=false` is the rollback, and the endpoint answers
    // exactly as it did before this PR: an empty list that must not render as
    // a zero amount.
    expect(result.sourcesConfigured).toBe(false);
    expect(result.providers).toEqual([]);
  });

  it('reports freshness, so a stale number can be recognised as one', async () => {
    await seed('google.details.quality', 1);
    const result = await report();
    expect(result.asOf).not.toBeNull();
    expect(Date.parse(result.asOf!)).toBeGreaterThan(0);
    expect(result.pricingVersion).toBe('2026-09-01');
  });
});
