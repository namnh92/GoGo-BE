import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import {
  BudgetService,
  COST_REGISTRY,
  COST_REGISTRY_DATA,
  CostCenterService,
  CostRegistry,
  TestCostService,
  writeAudit,
} from '@gogo/modules';

/**
 * COST-BE-022 (#381) — the Cost API v2 against a real Postgres and the booted
 * app: the permission gate on every route, the input surface, and the row
 * semantics the epic insists on — ACTUAL beats ESTIMATED and is never added
 * to it (§12), an unknown cost is null and never 0 (§35), a measured zero is
 * 0 and says so (§23), freshness is per row (§23), and a provider added to
 * the registry appears with no code change (§44.2).
 *
 * Seeded on today's UTC day, because the app reads the real clock: the month
 * window and the `today` card then agree on what they contain.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.72.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

const tokens: Record<string, string> = {};
const ENV = 'dev';
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
let runId = '';

async function createAdmin(role: 'editor' | 'moderator' | 'ops_admin' | 'super_admin') {
  const email = `cost-center-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db.insert(schema.adminUsers).values({ email, passwordHash, displayName: role, role });
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

const get = (url: string, role?: string) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    ...(role ? { headers: { authorization: `Bearer ${tokens[role]}` } } : {}),
  });

async function cost(over: {
  provider?: string;
  service?: string;
  operation?: string | null;
  metric?: string | null;
  sku?: string | null;
  amount: number;
  basis?: string;
  confidence?: string;
  source?: string;
}) {
  await db.execute(sql`
    insert into provider_cost_daily
      (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
       amount_micros, currency, basis, confidence, source)
    values (${TODAY}::date, ${ENV}, ${over.provider ?? 'google'}, ${over.service ?? 'google.places'},
            ${over.operation === undefined ? 'google.details.quality' : over.operation},
            ${over.metric === undefined ? 'requests' : over.metric},
            ${over.sku === undefined ? 'places.details.enterprise' : over.sku},
            ${over.amount}, 'USD', ${over.basis ?? 'ESTIMATED'}, ${over.confidence ?? 'MEDIUM'},
            ${over.source ?? 'estimator'})
  `);
}

async function usage(over: {
  service: string;
  operation: string;
  metric: string;
  sku: string | null;
  unit: string;
  quantity: number;
  source?: string;
  confidence?: string;
}) {
  await db.execute(sql`
    insert into provider_usage_meter_daily
      (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
       quantity, unit, source, confidence)
    values (${TODAY}::date, ${ENV}, 'google', ${over.service}, ${over.operation}, ${over.metric},
            ${over.sku}, ${over.quantity}, ${over.unit}, ${over.source ?? 'ledger'},
            ${over.confidence ?? 'HIGH'})
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_center_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.APP_ENV = ENV;
  process.env.COST_LEDGER_ENABLED = 'true';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  // Places: an estimate and an invoice for the same spend. Never summed.
  await cost({ amount: 8_200_000 });
  await cost({
    amount: 8_310_000,
    basis: 'ACTUAL',
    confidence: 'HIGH',
    source: 'gcp_billing_export',
  });
  // Routes: usage, no cost row — the price is not verified.
  await usage({
    service: 'google.routes',
    operation: 'google.routeMatrix',
    metric: 'calls',
    sku: null,
    unit: 'request',
    quantity: 12,
  });
  await usage({
    service: 'google.routes',
    operation: 'google.routeMatrix',
    metric: 'billable_elements',
    sku: 'routes.computeRouteMatrix',
    unit: 'matrix_element',
    quantity: 50,
  });
  // A backfill view of the same Routes day: a second source, never added.
  await usage({
    service: 'google.routes',
    operation: 'google.routeMatrix',
    metric: 'billable_elements',
    sku: 'routes.computeRouteMatrix',
    unit: 'matrix_element',
    quantity: 999,
    source: 'prometheus_backfill',
    confidence: 'LOW',
  });
  // The cost of tracking cost (epic §21).
  await cost({
    provider: 'gogo',
    service: 'gogo.cost_observability',
    operation: null,
    metric: null,
    sku: null,
    amount: 10_000,
    basis: 'FIXED',
    confidence: 'HIGH',
    source: 'monitoring_cost_model',
  });
  // Freshness: the ledger covers Google and is fresh; a Sheets-only probe is stale.
  await db.execute(sql`
    insert into cost_source_freshness
      (environment, source_id, provider_id, service_id, last_successful_at, last_attempt_at,
       source_as_of, stale_after_s, status, consecutive_failures)
    values
      (${ENV}, 'ledger', 'google', null, now(), now(), now(), 86400, 'FRESH', 0),
      (${ENV}, 'sheets_probe', 'google', 'google.sheets', now() - interval '3 days',
       now() - interval '3 days', now() - interval '3 days', 86400, 'STALE', 0)
  `);
  // A TOTAL budget large enough that today's spend cannot project past it.
  await new BudgetService(db as never, COST_REGISTRY, {
    environment: ENV,
    audit: writeAudit,
  }).upsert({ scope: { kind: 'TOTAL', id: null }, monthMicros: 1_000_000_000 }, { adminId: null });
  // One finished test run with a priced delta.
  const tests = new TestCostService(db as never);
  runId = await tests.start('cost-center-smoke', { environment: ENV, gitSha: 'abc1234' });
  await usage({
    service: 'google.places',
    operation: 'google.details.quality',
    metric: 'requests',
    sku: 'places.details.enterprise',
    unit: 'request',
    quantity: 5,
  });
  await tests.finish(runId);

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
    await createAdmin(role);
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const routes = () => [
  '/v1/cms/ops/costs?window=mtd',
  '/v1/cms/ops/costs/providers?window=mtd',
  '/v1/cms/ops/costs/providers/google?window=mtd',
  '/v1/cms/ops/costs/providers/google/services/google.places?window=mtd',
  '/v1/cms/ops/costs/test-runs',
  `/v1/cms/ops/costs/test-runs/${runId}`,
];

describe('#381 — RBAC on every Cost API v2 route', () => {
  it('refuses an unauthenticated caller, an editor and a moderator; allows ops_admin and super_admin', async () => {
    for (const url of routes()) {
      expect((await get(url)).statusCode, url).toBe(401);
      const editor = await get(url, 'editor');
      expect(editor.statusCode, url).toBe(403);
      expect(editor.json().code).toBe('ROLE_DENIED');
      expect((await get(url, 'moderator')).statusCode, url).toBe(403);
      expect((await get(url, 'ops_admin')).statusCode, url).toBe(200);
      expect((await get(url, 'super_admin')).statusCode, url).toBe(200);
    }
  });
});

describe('#381 — input surface', () => {
  it('defaults the window to mtd and rejects anything that is not a day-shaped window', async () => {
    const res = await get('/v1/cms/ops/costs', 'ops_admin');
    expect(res.statusCode).toBe(200);
    expect(res.json().window).toBe('mtd');
    for (const w of ['today', '7d', '30d', 'mtd']) {
      expect((await get(`/v1/cms/ops/costs/providers?window=${w}`, 'ops_admin')).statusCode).toBe(
        200,
      );
    }
    for (const w of ['1h', '24h', '', '90d', 'sum(up)']) {
      const bad = await get(
        `/v1/cms/ops/costs/providers?window=${encodeURIComponent(w)}`,
        'ops_admin',
      );
      expect(bad.statusCode, w).toBe(400);
    }
  });

  it('answers 404 for an unregistered provider, a service under the wrong provider, and a missing run', async () => {
    const provider = await get('/v1/cms/ops/costs/providers/vietmap', 'ops_admin');
    expect(provider.statusCode).toBe(404);
    expect(provider.json().code).toBe('COST_PROVIDER_NOT_FOUND');
    const wrong = await get(
      '/v1/cms/ops/costs/providers/google/services/upstash.redis',
      'ops_admin',
    );
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().code).toBe('COST_SERVICE_NOT_FOUND');
    expect(
      (await get('/v1/cms/ops/costs/providers/google/services/google.nope', 'ops_admin'))
        .statusCode,
    ).toBe(404);
    const run = await get(`/v1/cms/ops/costs/test-runs/${randomUUID()}`, 'ops_admin');
    expect(run.statusCode).toBe(404);
    expect(run.json().code).toBe('COST_TEST_RUN_NOT_FOUND');
    expect((await get('/v1/cms/ops/costs/test-runs/not-a-uuid', 'ops_admin')).statusCode).toBe(400);
    expect((await get('/v1/cms/ops/costs/providers/Google!', 'ops_admin')).statusCode).toBe(400);
  });
});

describe('#381 — the overview keeps the legacy payload and adds the Cost Center', () => {
  it('carries every #335 field unchanged beside the v2 fields', async () => {
    const body = (await get('/v1/cms/ops/costs', 'ops_admin')).json();
    // Legacy (#335): still keyed places|routes|sheets, still an estimate.
    expect(body.sourcesConfigured).toBe(true);
    expect(body.basis).toBe('ESTIMATED');
    expect(body.confidence).toBe('MEDIUM');
    expect(body.currency).toBe('USD');
    expect(Array.isArray(body.providers)).toBe(true);
    expect(Array.isArray(body.gaps)).toBe(true);
    expect(body.providers.find((p: { key: string }) => p.key === 'places')).toBeDefined();
    // v2 (#381).
    expect(body.environment).toBe(ENV);
    expect(body.ledgerEnabled).toBe(true);
    expect(body.range).toEqual({ from: `${MONTH}-01`, to: TODAY });
    expect(body.month).toBe(MONTH);
    expect(body.today).toBe(TODAY);
    expect(typeof body.generatedAt).toBe('string');
    expect(body.unattributed).toEqual({ providerIds: [], serviceIds: [] });
  });

  it('cards: today and MTD after precedence, projected per §33, budget, unknown, cost of monitoring', async () => {
    const { cards } = (await get('/v1/cms/ops/costs', 'ops_admin')).json();
    // Places actual 8.31 (estimate 8.20 shadowed, never added) + monitoring 0.01.
    expect(cards.monthToDate).toMatchObject({
      spendMicros: 8_320_000,
      byBasis: { ACTUAL: 8_310_000, ESTIMATED: 0, FIXED: 10_000, MANUAL: 0 },
      currency: 'USD',
      mixedCurrency: false,
      services: 2,
      month: MONTH,
    });
    expect(cards.today).toMatchObject({ spendMicros: 8_320_000, day: TODAY });
    expect(cards.projected.month).toBe(MONTH);
    expect(cards.projected.minElapsedDays).toBe(3);
    if (cards.projected.elapsedDays < 3) expect(cards.projected.micros).toBeNull();
    else expect(cards.projected.micros).toBeGreaterThan(0);
    expect(cards.budget.total).toMatchObject({
      scope: { kind: 'TOTAL', id: null },
      monthMicros: 1_000_000_000,
      usedMicros: 8_320_000,
      state: 'ok',
    });
    expect(cards.budget.budgets).toHaveLength(1);
    // Unknown: the planned providers with no source; Google and GoGo are known.
    expect(cards.unknown.providerIds).toEqual(
      expect.arrayContaining(['cloudflare', 'upstash', 'neon', 'aws', 'github']),
    );
    expect(cards.unknown.providerIds).not.toContain('google');
    expect(cards.unknown.providerIds).not.toContain('gogo');
    // Routes has usage and no price; the SDK is not instrumented.
    expect(cards.unknown.serviceIds).toEqual(
      expect.arrayContaining(['google.routes', 'google.maps_sdk_ios']),
    );
    expect(cards.unknown.serviceIds).not.toContain('google.places');
    expect(cards.costOfMonitoring).toMatchObject({
      spendMicros: 10_000,
      serviceIds: ['gogo.cost_observability'],
    });
  });

  it('provider rows: registry order, and ACTUAL > ESTIMATED never summed on the Places row', async () => {
    const body = (await get('/v1/cms/ops/costs/providers', 'ops_admin')).json();
    expect(body.providers.map((p: { providerId: string }) => p.providerId)).toEqual(
      COST_REGISTRY.providers().map((p) => p.id),
    );
    const google = body.providers.find((p: { providerId: string }) => p.providerId === 'google');
    expect(google).toMatchObject({
      status: 'active',
      spendMicros: 8_310_000,
      actualMicros: 8_310_000,
      estimatedMicros: 8_200_000,
      shadowedEstimatedMicros: 8_200_000,
      basis: 'ACTUAL',
      confidence: 'HIGH',
      costStatus: 'KNOWN',
      currency: 'USD',
    });
    // The provider row takes the worst of every source under it: the stale
    // Sheets probe taints Google as a whole, while Places (covered by the
    // ledger alone) stays FRESH below.
    expect(google.freshness.status).toBe('STALE');
    expect(google.freshness.sources.map((s: { sourceId: string }) => s.sourceId)).toEqual([
      'ledger',
      'sheets_probe',
    ]);
    expect(google.unknownServices).toEqual(
      expect.arrayContaining(['google.routes', 'google.maps_sdk_ios', 'google.maps_sdk_android']),
    );
    const places = google.services.find(
      (s: { serviceId: string }) => s.serviceId === 'google.places',
    );
    expect(places).toMatchObject({
      spendMicros: 8_310_000,
      actualMicros: 8_310_000,
      estimatedMicros: 8_200_000,
      basis: 'ACTUAL',
      costStatus: 'KNOWN',
      quota: null,
      instrumented: true,
    });
    expect(places.freshness).toMatchObject({ status: 'FRESH' });
    expect(places.freshness.sources.map((s: { sourceId: string }) => s.sourceId)).toEqual([
      'ledger',
    ]);
    expect(typeof places.lastUpdated).toBe('string');
  });

  it('ADR-0014 — registry status, runtime coverage, cost source and cost freshness are four fields, not one', async () => {
    const body = (await get('/v1/cms/ops/costs/providers', 'ops_admin')).json();
    const byId = Object.fromEntries(
      body.providers.map((p: { providerId: string }) => [p.providerId, p]),
    );
    // Google: active; three of five runtime services measured; the ledger is
    // AUTO and the stale Sheets probe makes the cost data STALE.
    expect(byId['google']).toMatchObject({
      status: 'active',
      runtime: {
        coverage: 'PARTIAL',
        services: { full: 3, partial: 0, notInstrumented: 2 },
        operations: { instrumented: 10, total: 12 },
      },
      cost: { kind: 'AUTO', freshness: 'STALE' },
    });
    const places = byId['google'].services.find(
      (s: { serviceId: string }) => s.serviceId === 'google.places',
    );
    expect(places.runtime).toEqual({
      surface: 'in_process',
      coverage: 'FULL',
      operations: { instrumented: 7, total: 7 },
    });
    expect(places.cost).toEqual({ kind: 'AUTO', freshness: 'FRESH' });
    const sdk = byId['google'].services.find(
      (s: { serviceId: string }) => s.serviceId === 'google.maps_sdk_ios',
    );
    expect(sdk.runtime).toMatchObject({ surface: 'client_sdk', coverage: 'NOT_INSTRUMENTED' });
    const play = byId['google'].services.find(
      (s: { serviceId: string }) => s.serviceId === 'google.play_console',
    );
    expect(play.runtime.coverage).toBe('N/A');
    expect(play.cost).toEqual({ kind: 'MANUAL', freshness: null });
    // Upstash: this process calls Redis and measures nothing (#414); its
    // collector has no credentials here and has never run — UNKNOWN, not an
    // error, because nothing was attempted.
    expect(byId['upstash']).toMatchObject({
      status: 'active',
      runtime: { coverage: 'NOT_INSTRUMENTED', services: { notInstrumented: 1 } },
      cost: { kind: 'AUTO', freshness: 'UNKNOWN' },
    });
    // A fee: active (the form exists), no runtime, manual, nothing entered.
    expect(byId['apple']).toMatchObject({
      status: 'active',
      runtime: { coverage: 'N/A' },
      cost: { kind: 'MANUAL', freshness: null },
    });
    // Planned: nothing wired, nothing to measure, no way for money in.
    expect(byId['onesignal']).toMatchObject({
      status: 'planned',
      runtime: { coverage: 'N/A' },
      cost: { kind: 'NONE', freshness: null },
    });
    for (const p of body.providers) {
      expect(['active', 'planned'], p.providerId).toContain(p.status);
    }
  });

  it('a service with usage and no price is UNKNOWN (null, not 0) and still shows its meters', async () => {
    const body = (
      await get('/v1/cms/ops/costs/providers/google/services/google.routes', 'ops_admin')
    ).json();
    const routes = body.service;
    expect(routes).toMatchObject({
      serviceId: 'google.routes',
      costStatus: 'UNKNOWN',
      spendMicros: null,
      estimatedMicros: null,
      actualMicros: null,
      basis: 'UNKNOWN',
      confidence: null,
    });
    // Ledger over backfill for the same day: 50, not 1049.
    expect(routes.usage).toEqual([
      expect.objectContaining({
        meterId: 'google.routeMatrix/billable_elements',
        quantity: 50,
        billable: true,
        sources: ['ledger'],
      }),
      expect.objectContaining({
        meterId: 'google.routeMatrix/calls',
        quantity: 12,
        billable: false,
      }),
    ]);
    expect(routes.operations).toEqual([
      expect.objectContaining({ operationId: 'google.routeMatrix', unregistered: false }),
    ]);
    expect(routes.operations[0].meters).toHaveLength(2);
    expect(routes.freshness.status).toBe('FRESH');
  });

  it('measured zero vs unknown, and freshness per row: Sheets is a STALE measured zero, the SDK is unknown', async () => {
    const { provider } = (await get('/v1/cms/ops/costs/providers/google', 'ops_admin')).json();
    const byId = Object.fromEntries(
      provider.services.map((s: { serviceId: string }) => [s.serviceId, s]),
    );
    // Instrumented, no usage, no cost, covered by the fresh ledger and a stale probe.
    expect(byId['google.sheets']).toMatchObject({
      costStatus: 'MEASURED_ZERO',
      spendMicros: 0,
      basis: 'ESTIMATED',
    });
    expect(byId['google.sheets'].freshness.status).toBe('STALE');
    expect(
      byId['google.sheets'].freshness.sources.map((s: { sourceId: string; status: string }) => [
        s.sourceId,
        s.status,
      ]),
    ).toEqual([
      ['ledger', 'FRESH'],
      ['sheets_probe', 'STALE'],
    ]);
    // Not instrumented: never a zero, whatever the source says.
    expect(byId['google.maps_sdk_ios']).toMatchObject({
      costStatus: 'UNKNOWN',
      spendMicros: null,
      instrumented: false,
    });
    expect(byId['google.maps_sdk_ios'].freshness.status).toBe('FRESH');
  });

  it('the FIXED monitoring row is KNOWN on the internal provider, with no source of its own', async () => {
    const { provider } = (await get('/v1/cms/ops/costs/providers/gogo', 'ops_admin')).json();
    expect(provider).toMatchObject({
      providerId: 'gogo',
      spendMicros: 10_000,
      fixedMicros: 10_000,
      basis: 'FIXED',
      confidence: 'HIGH',
      costStatus: 'KNOWN',
    });
    expect(provider.freshness).toEqual({ status: 'UNKNOWN', sourceAsOf: null, sources: [] });
    // No collector row, but the scheduler wrote today's FIXED row: AUTO and FRESH.
    expect(provider.cost).toEqual({ kind: 'AUTO', freshness: 'FRESH' });
    expect(provider.runtime.coverage).toBe('N/A');
    // An active provider whose collector has no credentials (#384): no rows,
    // no source, unknown — and present.
    const { provider: upstash } = (
      await get('/v1/cms/ops/costs/providers/upstash', 'ops_admin')
    ).json();
    expect(upstash).toMatchObject({
      status: 'active',
      costStatus: 'UNKNOWN',
      spendMicros: null,
      unknownServices: ['upstash.redis'],
    });
  });

  it('the today window excludes nothing seeded today and mtd starts on the first', async () => {
    const today = (
      await get('/v1/cms/ops/costs/providers/google?window=today', 'ops_admin')
    ).json();
    expect(today.provider.spendMicros).toBe(8_310_000);
    const week = (await get('/v1/cms/ops/costs?window=7d', 'ops_admin')).json();
    expect(week.range.to).toBe(TODAY);
    expect(week.window).toBe('7d');
  });
});

describe('#381 — test-run report', () => {
  it('lists runs newest first and returns one run with its priced deltas', async () => {
    const list = (await get('/v1/cms/ops/costs/test-runs?limit=5', 'ops_admin')).json();
    expect(list.testRuns).toHaveLength(1);
    expect(list.testRuns[0]).toMatchObject({
      id: runId,
      name: 'cost-center-smoke',
      environment: ENV,
      status: 'ok',
      gitSha: 'abc1234',
      services: null,
      budget: null,
    });
    expect(list.testRuns[0].endedAt).not.toBeNull();

    const { testRun } = (await get(`/v1/cms/ops/costs/test-runs/${runId}`, 'ops_admin')).json();
    expect(testRun.id).toBe(runId);
    expect(testRun.deltas).toHaveLength(1);
    expect(testRun.deltas[0]).toMatchObject({
      serviceId: 'google.places',
      operationId: 'google.details.quality',
      usageMetricId: 'requests',
      billingSkuId: 'places.details.enterprise',
      usageDelta: 5,
      basis: 'ESTIMATED',
      actualCostDelta: null,
    });
    expect(testRun.deltas[0].estimatedCostDelta).toBeGreaterThan(0);
    expect(testRun.estimatedCostMicros).toBe(testRun.deltas[0].estimatedCostDelta);
    expect(testRun.actualCostMicros).toBeNull();
    expect(testRun.unpriced).toEqual([]);
    expect((await get('/v1/cms/ops/costs/test-runs?limit=0', 'ops_admin')).statusCode).toBe(400);
  });
});

describe('#381 — epic §44.2: a provider added to the registry appears with no code change', () => {
  it('shows up in providers() as planned and UNKNOWN, and counts a manual row once it has one', async () => {
    const acme = {
      id: 'acme',
      displayName: 'Acme',
      status: 'planned' as const,
      capabilities: [],
      services: [
        {
          id: 'acme.widgets',
          providerId: 'acme',
          displayName: 'Widgets',
          category: 'edge_compute' as const,
          runtime: 'none' as const,
          capabilities: [],
          operations: [],
        },
      ],
    };
    const registry = new CostRegistry({
      ...COST_REGISTRY_DATA,
      providers: [...COST_REGISTRY_DATA.providers, acme],
    });
    const center = new CostCenterService(db as never, registry, {
      environment: ENV,
      ledgerEnabled: true,
    });
    const before = await center.providers('mtd');
    expect(before.map((p) => p.providerId)).toContain('acme');
    expect(before.find((p) => p.providerId === 'acme')).toMatchObject({
      status: 'planned',
      costStatus: 'UNKNOWN',
      spendMicros: null,
      unknownServices: ['acme.widgets'],
    });
    const overviewBefore = await center.overview('mtd');
    expect(overviewBefore.cards.unknown.providerIds).toContain('acme');

    await cost({
      provider: 'acme',
      service: 'acme.widgets',
      operation: null,
      metric: null,
      sku: null,
      amount: 42,
      basis: 'MANUAL',
      confidence: 'HIGH',
      source: 'manual_cost_items',
    });
    const after = await center.provider('acme', 'mtd');
    expect(after).toMatchObject({ spendMicros: 42, manualMicros: 42, basis: 'MANUAL' });
    // The same row is `unattributed` through the production registry, which
    // has never heard of Acme: the money is not dropped, it is named.
    const prod = (await get('/v1/cms/ops/costs', 'ops_admin')).json();
    expect(prod.unattributed).toEqual({ providerIds: ['acme'], serviceIds: ['acme.widgets'] });
    expect(prod.providerRows.map((p: { providerId: string }) => p.providerId)).not.toContain(
      'acme',
    );
  });
});
