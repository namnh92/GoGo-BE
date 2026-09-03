import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import {
  COST_REGISTRY,
  CostCenterService,
  CostEstimatorService,
  MOBILE_USAGE_SOURCE,
  ProviderUsageReportService,
  utcDay,
} from '@gogo/modules';

/**
 * COST-BE-028 (#387), epic §18 — client-reported Maps SDK usage over real
 * HTTP and a real Postgres.
 *
 * What only this level can prove:
 *
 * 1. **The flag is a switch, not a suggestion.** Off, a well-formed batch
 *    writes nothing and the response says so; the cost screen keeps reporting
 *    `not_instrumented`, which is the truth.
 * 2. **A retry does not double-count.** These rows add, so `Idempotency-Key`
 *    is what makes an uploader safe — and the global interceptor has to be in
 *    front of this route for that to be true.
 * 3. **The payload cannot smuggle identity.** An unknown property is a 422,
 *    not a silently dropped field.
 * 4. **The number reaches the money.** Rows land as `mobile_sdk` / `LOW`, the
 *    estimator prices them at the verified Dynamic Maps price with the shared
 *    10,000/month allowance, and the Cost Center reports the operation as
 *    instrumented with a FRESH source.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const ENV = 'dev';
const TODAY = utcDay();

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.70.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

async function register(email: string): Promise<string> {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'U' },
  });
  return res.json().accessToken as string;
}

let token = '';

const event = (over: Record<string, unknown> = {}) => ({
  providerId: 'google',
  serviceId: 'google.maps_sdk_ios',
  usageMetricId: 'map_loads',
  quantity: 1,
  occurredAt: new Date().toISOString(),
  platform: 'ios',
  appVersion: '1.4.2',
  ...over,
});

function post(events: unknown[], headers: Record<string, string> = {}) {
  return api().inject({
    method: 'POST',
    url: '/v1/telemetry/provider-usage',
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: { events },
  });
}

async function enableFlag(platform: 'all' | 'ios' | 'android') {
  await db.execute(sql`
    insert into feature_flags (key, environment, platform, enabled)
    values ('mobile_provider_usage.enabled', 'dev', ${platform}, true)
    on conflict (key, environment, platform) do update set enabled = true
  `);
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
  metadata: Record<string, unknown> | null;
};

async function meterRows(): Promise<MeterRow[]> {
  const { rows } = await db.execute(sql`
    select provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
           quantity::int as quantity, unit, source, confidence, metadata
    from provider_usage_meter_daily
    where environment = ${ENV}
    order by service_id, usage_metric_id
  `);
  return rows as unknown as MeterRow[];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_mobile_usage_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = ENV;
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  token = await register('telemetry-user@example.com');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  await db.execute(sql`delete from provider_usage_meter_daily`);
  await db.execute(sql`delete from provider_cost_daily`);
  await db.execute(sql`delete from cost_source_freshness`);
  await db.execute(sql`delete from feature_flags`);
  await db.execute(sql`delete from idempotency_keys`);
});

describe('POST /v1/telemetry/provider-usage — the flag', () => {
  it('records nothing while it is off, and tells the client to stop', async () => {
    const res = await post([event(), event()]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ enabled: false, accepted: 0, discarded: 2, quantity: 0 });
    expect(await meterRows()).toEqual([]);
  });

  it('keeps the Maps SDK measurement gap while it is off', async () => {
    const report = await new ProviderUsageReportService(db as never, {
      environment: ENV,
      ledgerEnabled: true,
    }).report(TODAY);
    const byKey = Object.fromEntries(report.gaps.map((g) => [g.key, g.kind]));
    expect(byKey['google.maps_sdk_ios']).toBe('not_instrumented');
    expect(byKey['google.maps_sdk_android']).toBe('not_instrumented');
  });

  it('answers per platform', async () => {
    await enableFlag('ios');
    expect((await post([event()])).json()).toMatchObject({ enabled: true });
    const android = await post([
      event({ serviceId: 'google.maps_sdk_android', platform: 'android' }),
    ]);
    expect(android.json()).toMatchObject({ enabled: false });
    expect((await meterRows()).map((r) => r.service_id)).toEqual(['google.maps_sdk_ios']);
  });
});

describe('POST /v1/telemetry/provider-usage — what it records', () => {
  it('writes one row per meter, as mobile_sdk at LOW confidence', async () => {
    await enableFlag('all');
    const res = await post([event({ quantity: 4 }), event({ quantity: 6 })]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ enabled: true, accepted: 2, discarded: 0, quantity: 10 });

    expect(await meterRows()).toEqual([
      expect.objectContaining({
        provider_id: 'google',
        service_id: 'google.maps_sdk_ios',
        operation_id: 'google.maps_sdk_ios',
        usage_metric_id: 'map_loads',
        billing_sku_id: 'maps.dynamic.ios',
        quantity: 10,
        unit: 'map_load',
        source: MOBILE_USAGE_SOURCE,
        confidence: 'LOW',
        metadata: { platform: 'ios', appVersion: '1.4.2' },
      }),
    ]);
  });

  it('accumulates across requests instead of replacing the day', async () => {
    await enableFlag('all');
    await post([event({ quantity: 3 })]);
    await post([event({ quantity: 5 })]);
    expect((await meterRows())[0]!.quantity).toBe(8);
  });

  it('replays an Idempotency-Key instead of counting the batch twice', async () => {
    await enableFlag('all');
    const headers = { 'idempotency-key': 'uploader-flush-0001' };
    // The same bytes both times: a retry re-sends the flush it already built,
    // and the interceptor keys on the body as well as the key.
    const batch = [event({ quantity: 9 })];
    const first = await post(batch, headers);
    const second = await post(batch, headers);

    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect((await meterRows())[0]!.quantity).toBe(9);
  });

  it('marks the reporting source FRESH so a quiet day is not a broken uploader', async () => {
    await enableFlag('all');
    await post([event()]);
    const { rows } = await db.execute(sql`
      select source_id, provider_id, service_id, status, consecutive_failures::int as failures
      from cost_source_freshness where environment = ${ENV}
    `);
    expect(rows).toEqual([
      expect.objectContaining({
        source_id: `${MOBILE_USAGE_SOURCE}:google.maps_sdk_ios`,
        provider_id: 'google',
        service_id: 'google.maps_sdk_ios',
        status: 'FRESH',
        failures: 0,
      }),
    ]);
  });
});

describe('POST /v1/telemetry/provider-usage — what it refuses', () => {
  it('rejects an unknown property rather than dropping it', async () => {
    await enableFlag('all');
    // Epic §18: a place id must never travel with a usage event. Ignoring the
    // field would still have logged it on the way in.
    const res = await post([{ ...event(), placeId: 'ChIJsomething' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    expect(await meterRows()).toEqual([]);
  });

  it('rejects a service nothing reports for, and a mixed-platform batch', async () => {
    await enableFlag('all');
    expect((await post([event({ serviceId: 'google.places' })])).statusCode).toBe(400);
    expect(
      (await post([event(), event({ serviceId: 'google.maps_sdk_android', platform: 'android' })]))
        .statusCode,
    ).toBe(400);
    expect(await meterRows()).toEqual([]);
  });

  it('rejects an over-long batch and an implausible count', async () => {
    await enableFlag('all');
    const tooMany = Array.from({ length: 101 }, () => event());
    expect((await post(tooMany)).statusCode).toBe(400);
    expect((await post([event({ quantity: 101 })])).statusCode).toBe(400);
    expect((await post([event({ quantity: 0 })])).statusCode).toBe(400);
    expect(await meterRows()).toEqual([]);
  });

  it('discards a stale event without losing the rest of the batch', async () => {
    await enableFlag('all');
    const long_ago = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const res = await post([event({ occurredAt: long_ago }), event({ quantity: 2 })]);
    expect(res.json()).toMatchObject({
      accepted: 1,
      discarded: 1,
      rejected: [{ index: 0, reason: 'stale_occurred_at' }],
      quantity: 2,
    });
    expect((await meterRows())[0]!.quantity).toBe(2);
  });

  it('refuses an unauthenticated caller', async () => {
    await enableFlag('all');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/telemetry/provider-usage',
      remoteAddress: ip(),
      payload: { events: [event()] },
    });
    expect(res.statusCode).toBe(401);
    expect(await meterRows()).toEqual([]);
  });
});

describe('the number reaches the cost screen', () => {
  it('prices map loads at the verified Dynamic Maps rule, allowance shared', async () => {
    await enableFlag('all');
    // 12,000 loads across the two platforms in one month: 10,000 free from the
    // one Google SKU, 2,000 billable at $7.00/1,000 = $14.00. Per-platform
    // allowances would have made this $0.
    //
    // The endpoint caps one event at 100 loads on purpose, so the volume is
    // written through the endpoint and then raised in place — the arithmetic
    // under test is the estimator's allowance scope, not the ingest's.
    await post([event({ quantity: 100 })]);
    await db.execute(sql`
      update provider_usage_meter_daily set quantity = 7000
      where service_id = 'google.maps_sdk_ios'
    `);
    await post([
      event({ serviceId: 'google.maps_sdk_android', platform: 'android', quantity: 100 }),
    ]);
    await db.execute(sql`
      update provider_usage_meter_daily set quantity = 5000
      where service_id = 'google.maps_sdk_android'
    `);

    const estimator = new CostEstimatorService(db as never, { environment: ENV });
    await estimator.recompute({ from: TODAY, to: TODAY });

    const { rows } = await db.execute(sql`
      select coalesce(sum(amount_micros), 0)::bigint as micros
      from provider_cost_daily
      where environment = ${ENV} and billing_sku_id like 'maps.dynamic.%'
    `);
    expect(Number((rows[0] as { micros: number | string }).micros)).toBe(14_000_000);
  });

  it('reports the operation as instrumented, with a source, once telemetry is on', async () => {
    await enableFlag('all');
    await post([event({ quantity: 5 })]);

    const center = new CostCenterService(db as never, COST_REGISTRY, {
      environment: ENV,
      ledgerEnabled: true,
    });
    const service = (await center.service('google', 'google.maps_sdk_ios', 'mtd'))!;
    expect(service.instrumented).toBe(true);
    expect(service.freshness.status).toBe('FRESH');
    expect(service.usage).toEqual([
      expect.objectContaining({
        usageMetricId: 'map_loads',
        quantity: 5,
        sources: [MOBILE_USAGE_SOURCE],
      }),
    ]);

    // …and Android, which nobody has reported for, is UNKNOWN rather than a
    // zero: instrumented is about setup, freshness is about whether anyone
    // has actually reported.
    const android = (await center.service('google', 'google.maps_sdk_android', 'mtd'))!;
    expect(android.instrumented).toBe(true);
    expect(android.freshness.status).toBe('UNKNOWN');
    expect(android.costStatus).toBe('UNKNOWN');
  });

  it('drops the not_instrumented gap once the loads are being counted', async () => {
    await enableFlag('all');
    await post([event()]);
    const report = await new ProviderUsageReportService(db as never, {
      environment: ENV,
      ledgerEnabled: true,
    }).report(TODAY);
    const keys = report.gaps.map((g) => g.key);
    expect(keys).not.toContain('google.maps_sdk_ios');
    expect(keys).not.toContain('google.maps_sdk_android');
    // Routes is untouched: counted exactly, priced not at all.
    expect(report.gaps.find((g) => g.key === 'google.routeMatrix')?.kind).toBe('price_unknown');
  });
});
