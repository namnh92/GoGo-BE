import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * PI-SRE-001 (#120) — the alert test.
 *
 * `docs/infrastructure.md` §3b lists the alerts and the metrics they fire on.
 * Nothing checked that those metrics are still emitted under those names with
 * those labels, so a rename would silently switch every alert off and the
 * first sign would be an incident nobody was paged for.
 *
 * These drive real endpoints and then read the scrape output, because a metric
 * asserted at its call site can still be missing from what a scraper sees.
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const METRICS_TOKEN = 'scrape-token-for-tests';
const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.66.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

async function scrape(token = METRICS_TOKEN) {
  return api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_metrics_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.METRICS_TOKEN = METRICS_TOKEN;

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  delete process.env.METRICS_TOKEN;
});

describe('scrape endpoint', () => {
  it('serves the Prometheus text format to a scraper with the token', async () => {
    const res = await scrape();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // A cached scrape would flatten every rate() computed from it.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a wrong token, and never answers unauthenticated', async () => {
    expect((await scrape('wrong-token-entirely')).statusCode).toBe(401);
    const bare = await api().inject({ method: 'GET', url: '/v1/metrics' });
    expect(bare.statusCode).toBe(401);
  });

  it('does not leak series names in the failure response', async () => {
    const res = await scrape('wrong-token-entirely');
    // The names describe which providers are called and which admin actions
    // happen; a 401 body that included them would defeat the token.
    expect(res.body).not.toContain('place_import');
    expect(res.body).not.toContain('cms_');
  });
});

describe('#414 runtime telemetry reaches the scrape (COST-BE-036, #422)', () => {
  it('counts a Postgres statement made by the API process as neon.postgres.query', async () => {
    // `/v1/health/ready` runs `select 1` through the pool DatabaseModule builds. The
    // pool takes its sink from RUNTIME_METRICS, which ProvidersModule must
    // *export*: provided but not exported, the optional injection resolves to
    // `undefined`, the pool is unmetered, and the series never exists — which
    // is exactly how DEV shipped #419 silent on the API side (#422). Booting
    // the whole app is what makes this test see the wiring, not the class.
    // `/v1/health` is liveness and touches nothing; `/ready` is the probe
    // that runs `select 1` (and skips Redis under NODE_ENV=test).
    const ready = await api().inject({ method: 'GET', url: '/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    const body = (await scrape()).body;
    expect(body).toMatch(
      /^provider_requests_total\{operation="neon\.postgres\.query",provider="neon",service="neon\.postgres",status="ok"\} [1-9]/m,
    );
    expect(body).toMatch(
      /^provider_request_duration_seconds_count\{operation="neon\.postgres\.query"/m,
    );
  });
});

describe('the metrics the alerts in infrastructure.md §3b fire on', () => {
  it('emits cms_emergency_takedown_total with its resource type', async () => {
    const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
    const [admin] = await db
      .insert(schema.adminUsers)
      .values({
        email: 'metrics-admin@gogo.local',
        passwordHash,
        displayName: 'ops',
        role: 'ops_admin',
      })
      .returning();
    const login = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      payload: { email: 'metrics-admin@gogo.local', password: 'admin-password-123' },
    });
    const token = login.json().accessToken as string;

    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Metrics Takedown Cafe',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();

    await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place!.id}/suspend`,
      remoteAddress: ip(),
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Emergency takedown used to check the alert metric' },
    });

    const body = (await scrape()).body;
    // The break-glass alert pages on *any* occurrence, so the counter existing
    // under this exact name is the alert.
    expect(body).toContain('cms_emergency_takedown_total');
    expect(body).toContain('resource_type="place"');
    expect(body).toContain('# TYPE cms_emergency_takedown_total counter');
    void admin;
  });

  it('renders every alerted metric as a series a scraper can match on', async () => {
    const body = (await scrape()).body;
    // Not "was this emitted" — "is it in the scrape output", which is what an
    // alert rule actually reads.
    for (const line of body.split('\n').filter((l) => l.startsWith('# TYPE'))) {
      // `gauge` joined the set in ADM-010 (#463): a counter cannot say whether
      // a dataset is published or how many places are waiting for a reviewer.
      expect(line).toMatch(/^# TYPE [a-z_]+ (counter|gauge|histogram)$/);
    }
    expect(body.endsWith('\n')).toBe(true);
  });
});
