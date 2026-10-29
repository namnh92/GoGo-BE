import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import { cmsAccessHeaders } from './support/cms-access';

/**
 * GoGo-BE#727 (OPS-BE-002) — `GET /v1/cms/ops/config-readiness` end to end:
 * the gate (AC-4), the projection read from SECRETS_READINESS_FILE (AC-1), the
 * absent projection (AC-2), and that no value of any variable reaches the
 * response (AC-3).
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
  const email = `config-readiness-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: role, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    headers: cmsAccessHeaders(email),
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

const SHA = 'c'.repeat(40);
const DEPLOY_ID = `${SHA}-901-2`;
// Shares no fragment with any name the response carries (paths, env_vars), so a
// match below can only be a leak.
const JWT_SECRET = 'Zq7v4lU3-'.padEnd(48, 'q');
const dir = mkdtempSync(path.join(tmpdir(), 'gogo-727-int-'));
const projectionFile = path.join(dir, 'secrets-readiness.deploy.json');

const projection = {
  schema_version: 1,
  env: 'dev',
  generated_at: '2026-10-29T13:58:31Z',
  manifest_sha: '9d59f0d22015a936972469f6244ecdca1baacd82',
  deploy_id: DEPLOY_ID,
  release_sha: SHA,
  run_id: '901',
  run_attempt: '2',
  rows: [
    {
      path: '/gogo/dev/backend/auth/jwt-secret',
      env_var: 'AUTH_JWT_SECRET',
      lifecycle: 'required',
      presence: 'present',
      findings: [],
      verdict: 'OK',
      capabilities: [],
    },
    {
      path: '/gogo/dev/backend/openrouter/assistant-api-key',
      env_var: 'OPENROUTER_ASSISTANT_API_KEY',
      lifecycle: 'planned',
      presence: 'present',
      findings: [],
      verdict: 'OK',
      capabilities: ['ai_assistant'],
    },
    {
      path: '/gogo/dev/backend/tunnel/token',
      env_var: 'TUNNEL_TOKEN',
      lifecycle: 'optional',
      presence: 'present',
      findings: [],
      verdict: 'OK',
      capabilities: ['ai_assistant'],
    },
  ],
  capabilities: [
    { name: 'ai_assistant', status: 'planned', verdict: 'OK', ready: true, missing: [] },
  ],
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_config_readiness_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.AUTH_JWT_SECRET = JWT_SECRET;
  process.env.APP_DEPLOY_ID = DEPLOY_ID;
  process.env.SECRETS_READINESS_FILE = projectionFile;
  delete process.env.OPENROUTER_ASSISTANT_API_KEY;
  writeFileSync(projectionFile, JSON.stringify(projection));

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
  rmSync(dir, { recursive: true, force: true });
  delete process.env.APP_DEPLOY_ID;
  delete process.env.SECRETS_READINESS_FILE;
});

const URL = '/v1/cms/ops/config-readiness';

describe('GoGo-BE#727 AC-4 — who may read it', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await get(URL)).statusCode).toBe(401);
  });

  it.each(['editor', 'moderator'])('refuses %s with the error envelope', async (role) => {
    const res = await get(URL, role);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ROLE_DENIED' });
  });

  it.each(['ops_admin', 'super_admin'])('allows %s', async (role) => {
    expect((await get(URL, role)).statusCode).toBe(200);
  });
});

describe('GoGo-BE#727 AC-1 — process and the deploy snapshot', () => {
  it('reports the schema keys, the snapshot and the capability join', async () => {
    const res = await get(URL, 'ops_admin');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const proc = Object.fromEntries(body.process.map((p: { name: string }) => [p.name, p]));
    expect(proc.AUTH_JWT_SECRET).toEqual({
      name: 'AUTH_JWT_SECRET',
      present: true,
      optional: true,
      conditional: true,
    });
    expect(proc.DATABASE_URL.present).toBe(true);
    expect(proc.OPENROUTER_ASSISTANT_API_KEY.present).toBe(false);
    expect(body.reason).toBeNull();
    expect(body.infra).toMatchObject({
      label: 'deploy_snapshot',
      deploy_id: DEPLOY_ID,
      deploy_match: true,
    });
    expect(body.capabilities).toEqual([
      {
        name: 'ai_assistant',
        status: 'planned',
        ssm_verdict: 'OK',
        ssm_ready: true,
        ssm_missing: [],
        ssm_present: { present: 2, total: 2 },
        // Stored in SSM, absent from this process — the case the page exists for.
        process_ready: false,
        process_missing: ['OPENROUTER_ASSISTANT_API_KEY'],
        excluded_from_process: ['TUNNEL_TOKEN'],
      },
    ]);
  });
});

describe('GoGo-BE#727 AC-3 — never a value', () => {
  it('the response holds no value, prefix or length of a variable', async () => {
    const text = (await get(URL, 'ops_admin')).body;
    for (const value of [
      JWT_SECRET,
      process.env.DATABASE_URL ?? 'unset',
      process.env.REDIS_URL ?? 'unset',
    ]) {
      expect(text).not.toContain(value);
      expect(text).not.toContain(value.slice(0, 10));
    }
    expect(text).not.toContain(String(JWT_SECRET.length));
  });
});

describe('GoGo-BE#727 AC-2 — no snapshot', () => {
  it('a missing projection is 200 with infra null and the reason; process is complete', async () => {
    const before = (await get(URL, 'ops_admin')).json().process.length;
    rmSync(projectionFile, { force: true });
    const res = await get(URL, 'ops_admin');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ infra: null, reason: 'missing', capabilities: [] });
    expect(res.json().process).toHaveLength(before);
  });

  it('a projection of another schema version is unknown_schema', async () => {
    writeFileSync(projectionFile, JSON.stringify({ ...projection, schema_version: 2 }));
    expect((await get(URL, 'ops_admin')).json().reason).toBe('unknown_schema');
  });
});
