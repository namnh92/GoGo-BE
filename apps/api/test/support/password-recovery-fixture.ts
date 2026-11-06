import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { schema } from '@gogo/database';
import { expect, vi } from 'vitest';
import {
  RecoveryCrypto,
  type RecoveryResponse,
} from '../../../../libs/modules/identity/application/password-recovery.service';
import {
  RecoveryMailSender,
  type RecoveryMailSink,
} from '../../../../libs/modules/identity/infrastructure/recovery-mail';
import { REVOCATION_STORE } from '../../../../libs/modules/identity/application/session-revocation.service';
import { RATE_LIMIT_REDIS } from '../../../../libs/modules/identity/presentation/rate-limit-redis';
import type { LogDestination } from '@gogo/observability';

export const OLD_PASSWORD = 'Original-Recovery-8!';
export const NEW_PASSWORD = 'Replacement-Recovery-9!';
export const RECOVERY_KEY = 'recovery-integration-shared-key-'.padEnd(48, 'x');
export const JWT_KEY = 'recovery-integration-jwt-key-'.padEnd(48, 'y');
export const REQUEST = '/v1/auth/password-recovery/request';
export const COMPLETE = '/v1/auth/password-recovery/complete';
export type Grant = { userId: string; accessToken: string; refreshToken: string };
export type Context = { ip?: string; key?: string; headers?: Record<string, string> };
export const crypto = new RecoveryCrypto(RECOVERY_KEY);
export const auth = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
let ipNumber = 0;
export function freshIp() {
  const n = ++ipNumber;
  return `10.199.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}
export function api(app: NestFastifyApplication): FastifyInstance {
  return app.getHttpAdapter().getInstance() as FastifyInstance;
}
export async function post(
  app: NestFastifyApplication,
  url: string,
  payload: object,
  context: Context = {},
): Promise<LightMyRequestResponse> {
  return api(app).inject({
    method: 'POST',
    url,
    payload,
    remoteAddress: context.ip ?? freshIp(),
    headers: { ...context.headers, ...(context.key ? { 'idempotency-key': context.key } : {}) },
  });
}
export async function me(
  app: NestFastifyApplication,
  token: string,
): Promise<LightMyRequestResponse> {
  return api(app).inject({
    method: 'GET',
    url: '/v1/me',
    headers: auth(token),
    remoteAddress: freshIp(),
  });
}
export function revocationRedis(app: NestFastifyApplication): IORedis {
  // Inspect the actual wired client for outage injection/teardown, never replace
  // the store. Test-mode apps deliberately have no Redis revocation client.
  return (app.get(REVOCATION_STORE) as { inner: { primary: { redis: IORedis } } }).inner.primary
    .redis;
}

export async function recoveryFixture(
  options: {
    before0079?: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<void>;
  } = {},
) {
  const pg = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('recovery')
    .start();
  const redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
  redis.on('error', () => undefined);
  await redis.ping();
  const pool = new Pool({
    connectionString: pg.getConnectionUri(),
    max: 8,
    statement_timeout: 12_000,
  });
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  const migrationsFolder = path.resolve(__dirname, '../../../../migrations');
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { tag: string; when: number; idx: number; version: string; breakpoints: boolean }[];
    version: string;
    dialect: string;
  };
  const entry = journal.entries.find((e) => e.tag.startsWith('0079_'))!;
  if (options.before0079) {
    // The real migrator consumes the real journal through 0078, then the full
    // journal. Temporary files stay inside the checkout and are always removed.
    const folder = await mkdtemp(path.join(process.cwd(), '.recovery-migrations-'));
    try {
      await mkdir(path.join(folder, 'meta'));
      const entries = journal.entries.filter((e) => e.idx < entry.idx);
      await writeFile(
        path.join(folder, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const e of entries)
        await cp(path.join(migrationsFolder, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
      await migrate(db, { migrationsFolder: folder });
      await options.before0079(db);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  await migrate(db, { migrationsFolder });
  const migrationHash = createHash('sha256')
    .update(await readFile(path.join(migrationsFolder, `${entry.tag}.sql`)))
    .digest('hex');
  const apps: { app: NestFastifyApplication; name: string; redisClients: IORedis[] }[] = [];

  async function startApp(
    options: { disabled?: boolean; telemetry?: LogDestination; statementTimeout?: number } = {},
  ) {
    const name = `recovery-${randomUUID()}`;
    const url = new URL(pg.getConnectionUri());
    url.searchParams.set('application_name', name);
    // A table-lock test below produces an actual PostgreSQL statement timeout.
    url.searchParams.set('options', `-c statement_timeout=${options.statementTimeout ?? 10000}`);
    for (const [key, value] of Object.entries({
      DATABASE_URL: url.toString(),
      REDIS_URL: redisUrl,
      NODE_ENV: options.telemetry ? 'test' : 'development',
      APP_ENV: 'dev',
      AUTH_JWT_SECRET: JWT_KEY,
      AUTH_RECOVERY_KEY: RECOVERY_KEY,
      AUTH_RECOVERY_MAIL_ADAPTER: options.disabled ? 'disabled' : 'sink',
      LOG_LEVEL: options.telemetry ? 'info' : 'error',
      DB_POOL_MAX: '3',
      TRUST_PROXY: 'false',
      SENTRY_DSN: '',
      CMS_PASSWORD_LOGIN_ENABLED: 'true',
      CMS_SUPER_ADMIN_SSO_ONLY: 'false',
    }))
      vi.stubEnv(key, value);
    const { createApp } = await import('../../src/main.js');
    const app = await createApp(options.telemetry ? { logDestination: options.telemetry } : {});
    await app.init();
    await api(app).ready();
    const redisClients: IORedis[] = [];
    if (!options.telemetry) {
      const rateRedis = app.get<IORedis>(RATE_LIMIT_REDIS);
      expect(rateRedis.status).toBe('ready');
      redisClients.push(rateRedis, revocationRedis(app));
    }
    apps.push({ app, name, redisClients });
    return app;
  }

  const a = await startApp();
  const b = await startApp();

  async function register(app = a, email = `recovery-${randomUUID()}@example.test`) {
    const response = await post(app, '/v1/auth/register', {
      email,
      password: OLD_PASSWORD,
      displayName: 'Recovery fixture',
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      ...response.json<Grant>(),
      email,
      cookies: response.headers['set-cookie'] as string[],
    };
  }
  async function request(email: string, app = a, context: Context = {}) {
    const response = await post(app, REQUEST, { email }, context);
    expect(response.statusCode, response.body).toBe(202);
    const body = response.json<RecoveryResponse>();
    const proof = (app.get(RecoveryMailSender) as RecoveryMailSink).sent.findLast(
      (m) => m.email === email,
    );
    return { body, proof };
  }
  async function prepare(app = a) {
    const user = await register(app);
    const { body, proof } = await request(user.email, app);
    expect(proof).toBeDefined();
    return {
      ...user,
      body,
      input: {
        email: user.email,
        challengeId: body.challengeId,
        code: proof!.code,
        password: NEW_PASSWORD,
      },
    };
  }
  async function guest(app = a) {
    const host = await register(app);
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `REC-${randomUUID()}`,
        type: 'group',
        status: 'collecting',
        decisionMode: 'vote',
        hostUserId: host.userId,
        participantCount: 4,
      })
      .returning();
    const response = await post(app, '/v1/sessions/guest', {
      roomCode: room!.code,
      displayName: 'Recovery guest',
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Grant & { guestSessionId: string; guestToken: string }>();
  }
  async function clearLimits() {
    const keys = await redis.keys('rl:recovery|*');
    if (keys.length) await redis.del(...keys);
  }
  async function allowResend(email: string) {
    await db
      .update(schema.passwordRecoveryChallenges)
      .set({ resendAvailableAt: new Date(0) })
      .where(eq(schema.passwordRecoveryChallenges.emailDigest, crypto.digest('email', email)));
    await redis.del(`rl:recovery|request|email-minute|${crypto.digest('email', email)}`);
  }
  async function snapshot(userId: string, email: string) {
    const user = await pool.query('select * from users where id=$1', [userId]);
    const sessions = await pool.query('select * from auth_sessions where user_id=$1 order by id', [
      userId,
    ]);
    const challenge = await pool.query(
      'select * from password_recovery_challenges where email_digest=$1',
      [crypto.digest('email', email)],
    );
    const attempts = await pool.query(
      'select * from login_attempts where identifier_hash=$1 order by id',
      [createHash('sha256').update(email).digest('hex')],
    );
    const exports = await pool.query(
      'select * from privacy_export_artifacts where subject_user_id=$1 order by id',
      [userId],
    );
    const audits = await pool.query(
      "select * from audit_logs where (actor_id=$1 and action='password.recovered') or (action='privacy_export.revoked' and resource_id in (select id::text from privacy_export_artifacts where subject_user_id=$1)) order by id",
      [userId],
    );
    return {
      user: user.rows,
      sessions: sessions.rows,
      challenge: challenge.rows,
      attempts: attempts.rows,
      exports: exports.rows,
      audits: audits.rows,
    };
  }
  async function seedExport(userId: string) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const [artifact] = await db
      .insert(schema.privacyExportArtifacts)
      .values({
        subjectUserId: userId,
        initiatorType: 'user',
        initiatorId: userId,
        subjectEpoch: user!.exportEpoch,
        state: 'ready',
        objectKey: `test/${randomUUID()}`,
        wrappedKey: Buffer.from('wrapped-test-key'),
        wrapNonce: Buffer.from('nonce'),
        wrapTag: Buffer.from('tag'),
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    return artifact!;
  }

  async function waitBlocked(app: NestFastifyApplication, blockers: number[]) {
    const name = apps.find((e) => e.app === app)!.name;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ pid: number; blockers: number[] }>(
        "select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
        [name],
      );
      const blocked = result.rows.find((r) => r.blockers.some((pid) => blockers.includes(pid)));
      if (blocked) return blocked.pid;
      // Yield between observations, never sleep to guess that a race happened.
      await setImmediate();
    }
    throw new Error('Bounded PostgreSQL contention barrier was not reached');
  }
  async function race<T, U>(userId: string, first: () => Promise<T>, second: () => Promise<U>) {
    const coordinator = await pool.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await coordinator.query('begin');
      await coordinator.query('select id from users where id=$1 for update', [userId]);
      const result = await coordinator.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = result.rows[0]!.pid;
      const one = first();
      pending.push(one);
      const firstPid = await waitBlocked(a, [pid!]);
      const two = second();
      pending.push(two);
      await waitBlocked(b, [pid!, firstPid]);
      await coordinator.query('commit');
      return await Promise.all([one, two] as const);
    } finally {
      await coordinator.query('rollback');
      coordinator.release();
      await Promise.allSettled(pending);
    }
  }
  async function failWrite(
    table: 'audit_logs' | 'password_recovery_replays' | 'password_recovery_challenges',
    predicate: string,
    diagnostic = 'scoped recovery write failure',
  ) {
    // Predicates contain only fixture-generated UUIDs or HMAC hex strings.
    await pool.query(`create function recovery_test_fail() returns trigger language plpgsql as $$ begin
      if ${predicate} then raise exception '%', '${diagnostic.replaceAll("'", "''")}'; end if; return NEW; end $$`);
    await pool.query(
      `create trigger recovery_test_fail before insert or update on ${table} for each row execute function recovery_test_fail()`,
    );
    return async () => {
      await pool.query(`drop trigger recovery_test_fail on ${table}`);
      await pool.query('drop function recovery_test_fail()');
    };
  }
  async function stopApp(app: NestFastifyApplication) {
    const index = apps.findIndex((entry) => entry.app === app);
    if (index < 0) return;
    const [entry] = apps.splice(index, 1);
    for (const client of entry!.redisClients) client.disconnect();
    await app.close();
  }
  async function close() {
    for (const { app } of [...apps].reverse()) await stopApp(app);
    redis.disconnect();
    await pool.end();
    await redisContainer.stop();
    await pg.stop();
    vi.unstubAllEnvs();
  }
  return {
    a,
    b,
    db,
    pool,
    redis,
    startApp,
    stopApp,
    register,
    request,
    prepare,
    guest,
    clearLimits,
    allowResend,
    snapshot,
    seedExport,
    waitBlocked,
    race,
    failWrite,
    close,
    entry,
    migrationHash,
  };
}
export type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;
