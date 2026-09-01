import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * BE-CMS-P2 (#315) — the permission gate, the input surface, and what happens
 * when the monitoring backend is not there.
 *
 * This deployment has no `GRAFANA_*` configured, which is exactly the state
 * every environment is in before its account exists — so the "backend
 * unavailable" path is not simulated here, it is simply the truth, and these
 * assert that it degrades instead of erroring.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.71.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

const tokens: Record<string, string> = {};

async function createAdmin(role: 'editor' | 'moderator' | 'ops_admin' | 'super_admin') {
  const email = `ops-metrics-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: role, role })
    .returning();
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_ops_metrics_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  // Deliberately unset: this is the pre-account state of every environment.
  delete process.env.GRAFANA_PROM_URL;
  delete process.env.GRAFANA_PROM_USER;
  delete process.env.GRAFANA_READ_TOKEN;

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

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

const ROUTES = [
  '/v1/cms/ops/summary?window=24h',
  '/v1/cms/ops/providers?window=24h',
  '/v1/cms/ops/providers/places?window=24h',
];

describe('#315 — who may read operational data', () => {
  it.each(ROUTES)('refuses an unauthenticated caller on %s', async (url) => {
    expect((await get(url)).statusCode).toBe(401);
  });

  it.each(ROUTES)('refuses an editor on %s', async (url) => {
    const res = await get(url, 'editor');
    // Rank 1 fails the exact-role check and fails the rank read (1 < 2).
    // Provider spend and infrastructure health are not editorial data.
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ROLE_DENIED');
  });

  it.each(ROUTES)('refuses a moderator on %s', async (url) => {
    expect((await get(url, 'moderator')).statusCode).toBe(403);
  });

  it.each(ROUTES)('allows ops_admin on %s', async (url) => {
    expect((await get(url, 'ops_admin')).statusCode).toBe(200);
  });

  it.each(ROUTES)('allows super_admin on %s', async (url) => {
    expect((await get(url, 'super_admin')).statusCode).toBe(200);
  });

  it('gates the new routes exactly as the three ops routes beside them', async () => {
    for (const url of ['/v1/cms/ops/health', '/v1/cms/ops/queues', '/v1/cms/ops/costs']) {
      expect((await get(url, 'editor')).statusCode).toBe(403);
      expect((await get(url, 'ops_admin')).statusCode).toBe(200);
    }
  });
});

describe('#315 — the input surface is an enum, not a query language', () => {
  it('defaults to 24h when no window is given', async () => {
    const res = await get('/v1/cms/ops/summary', 'ops_admin');
    expect(res.statusCode).toBe(200);
    expect(res.json().window).toBe('24h');
  });

  it.each(['1h', '24h', '7d', '30d'])('accepts %s', async (window) => {
    expect((await get(`/v1/cms/ops/summary?window=${window}`, 'ops_admin')).statusCode).toBe(200);
  });

  it.each(['6h', '1d', '', '90d', '1h ', 'PT1H'])('rejects %s', async (window) => {
    const res = await get(`/v1/cms/ops/summary?window=${encodeURIComponent(window)}`, 'ops_admin');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a PromQL fragment where a window belongs', async () => {
    for (const attempt of [
      'sum(up)',
      '24h]) or vector(1) #',
      '1h"} or places_provider_cost_units{',
      '24h[5m:1m]',
    ]) {
      const res = await get(
        `/v1/cms/ops/summary?window=${encodeURIComponent(attempt)}`,
        'ops_admin',
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects an unknown provider', async () => {
    const res = await get('/v1/cms/ops/providers/vietmap?window=24h', 'ops_admin');
    expect(res.statusCode).toBe(400);
  });

  it('ignores an extra query parameter rather than passing it anywhere', async () => {
    const res = await get(
      '/v1/cms/ops/summary?window=1h&query=' + encodeURIComponent('sum(up)'),
      'ops_admin',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('sum(up)');
  });
});

describe('#315 — no monitoring backend is not an error', () => {
  it('answers 200 with an unavailable backend rather than a 5xx', async () => {
    const res = await get('/v1/cms/ops/summary?window=24h', 'ops_admin');
    // A 5xx here renders in the console as "the CMS is broken", which is the
    // wrong sentence for "monitoring is unavailable and everything else is
    // fine".
    expect(res.statusCode).toBe(200);
    expect(res.json().backend.status).toBe('unavailable');
  });

  it('reports absent numbers as null, never as zero', async () => {
    const body = get('/v1/cms/ops/summary?window=24h', 'ops_admin').then((r) => r.json());
    expect((await body).totals).toBeNull();

    const providers = (await get('/v1/cms/ops/providers?window=24h', 'ops_admin')).json();
    for (const p of providers.providers) {
      // No traffic and no measurement are different facts. Rendering the
      // second as the first is the defect this asserts against.
      expect(p.instrumented).toBe(false);
      expect(p.successRate).toBeNull();
      expect(p.billableUnits).toBeNull();
    }
  });

  it('states retention and truncation even with nothing to report', async () => {
    const res = (await get('/v1/cms/ops/summary?window=30d', 'ops_admin')).json();
    expect(res.window).toBe('30d');
    expect(res.effectiveWindow).toBe('14d');
    expect(res.truncated).toBe(true);
    expect(res.retentionDays).toBe(14);

    const week = (await get('/v1/cms/ops/summary?window=7d', 'ops_admin')).json();
    expect(week.truncated).toBe(false);
    expect(week.effectiveWindow).toBe('7d');

    const day = (await get('/v1/cms/ops/summary?window=24h', 'ops_admin')).json();
    // The word the operator pressed, not a synonym for it.
    expect(day.effectiveWindow).toBe('24h');
  });
});

describe('#315 — nothing about the store reaches the caller', () => {
  it('returns no credential, no endpoint and no PromQL', async () => {
    for (const url of ROUTES) {
      const body = JSON.stringify((await get(url, 'ops_admin')).json());
      // The store's identity is as much ours to keep as its token.
      expect(body).not.toContain('grafana.net');
      expect(body).not.toContain('glc_');
      expect(body).not.toContain('Basic ');
      // Series names describe internal structure; a product-level DTO does not
      // need them and must not teach a browser to expect them.
      expect(body).not.toContain('places_provider_requests_total');
      expect(body).not.toContain('histogram_quantile');
      expect(body).not.toContain('increase(');
      expect(body).not.toContain('env="');
    }
  });

  it('never names the units money', async () => {
    const body = JSON.stringify((await get(ROUTES[0]!, 'ops_admin')).json());
    for (const forbidden of ['actualSpend', 'billedAmount', 'invoiceCost']) {
      expect(body).not.toContain(forbidden);
    }
    const summary = (await get(ROUTES[0]!, 'ops_admin')).json();
    // #335 priced the units. The amount is an estimate and every qualifier
    // needed to read it as one ships with it — the store is unreachable in
    // this test, so there is nothing measured and the amount is absent rather
    // than zero.
    expect(summary.costModel.kind).toBe('estimated');
    expect(summary.costModel.estimatedCost).toBeNull();
    expect(summary.costModel.currency).toBe('USD');
    expect(summary.costModel.basis).toBe('ESTIMATED');
    expect(summary.costModel.pricingVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('#315 — the API holds the read credential and only the read one', () => {
  it('does not declare the collector write token at all', () => {
    // Not "does not use": the env schema is the whole surface through which
    // configuration enters this process, and `GRAFANA_WRITE_TOKEN` is not on
    // it. The API literally cannot read the credential that can write to the
    // store, which is a stronger guarantee than a code review.
    const env = readFileSync(path.resolve(__dirname, '../src/config/env.ts'), 'utf8');
    expect(env).toContain('GRAFANA_READ_TOKEN');
    expect(env).not.toContain('GRAFANA_WRITE_TOKEN');
  });

  it('binds no query port when the read credential is absent', async () => {
    // A fake here would answer a dashboard with invented traffic. The one
    // thing this screen must never do is show a number nobody measured.
    expect((await get(ROUTES[0]!, 'ops_admin')).json().backend.status).toBe('unavailable');
  });
});
