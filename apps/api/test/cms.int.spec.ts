import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import argon2 from 'argon2';
import { and, desc, DrizzleQueryError, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IdentityRepository, PasswordService } from '@gogo/modules';
import { schema, syncSuperAdmin, type Db } from '@gogo/database';
import { PUBLIC_STORAGE_PROVIDER, STORAGE_PROVIDER, type FakeStorage } from '@gogo/providers';
import {
  ADMIN_LOCKOUT_THRESHOLD,
  AdminAuthService,
  APP_CONFIG,
  audiencePredicate,
  CloudflareAccessService,
  DB,
  respectsPushPreference,
  SessionRevocationService,
} from '@gogo/modules';
import { cmsAccessHeaders, cmsAssertion } from './support/cms-access';

/**
 * CMS-001..010 acceptance: RBAC enforced server-side, place workflow +
 * search sync (SRS §15.5), moderation with reasons, four-eyes ranking
 * console, import dry-run, KPIs, append-only audit.
 */

/**
 * The structured log, as operators read it: LOG_LEVEL=warn, so what lands
 * here is only what the API chose to say at warn or above (#680, review F-02).
 */
const warnLines: Record<string, unknown>[] = [];
const logSink = new Writable({
  write(chunk, _encoding, callback) {
    warnLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

function api() {
  return app.getHttpAdapter().getInstance();
}
let ipc = 0;
const ip = () => `10.40.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const ADMIN_PASSWORD = 'admin-password-123';

async function adminLogin(email: string, password: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    headers: cmsAccessHeaders(email),
    payload: { email, password },
  });
  expect(res.statusCode).toBe(201);
  return res.json().accessToken as string;
}

async function createAdmin(email: string, role: 'editor' | 'moderator' | 'ops_admin') {
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: email.split('@')[0]!, role })
    .returning();
  return { id: row!.id, token: await adminLogin(email, ADMIN_PASSWORD) };
}

const SUPER_ADMIN_EMAIL = 'super-admin@gogo.local';

/**
 * ADR-0018 — an environment has exactly one `super_admin`, and the database
 * refuses a second row in that role (`admin_users_single_super_admin`). So
 * every test needing one shares this account rather than creating its own.
 *
 * A fresh session per call, deliberately: several tests revoke sessions, and a
 * cached token would make the next test's failure a puzzle about ordering
 * rather than about what it was testing.
 *
 * `superAdminPassword` is a variable because the rotation test changes it. That
 * test puts it back, and this is where the rest of the file finds out.
 */
let superAdminId: string | null = null;
let superAdminPassword = ADMIN_PASSWORD;

async function superAdmin(): Promise<{ id: string; token: string }> {
  if (superAdminId === null) {
    const passwordHash = await argon2.hash(superAdminPassword, { type: argon2.argon2id });
    const [row] = await db
      .insert(schema.adminUsers)
      .values({
        email: SUPER_ADMIN_EMAIL,
        passwordHash,
        displayName: 'Super Admin',
        role: 'super_admin',
      })
      .returning();
    superAdminId = row!.id;
  }
  return { id: superAdminId, token: await adminLogin(SUPER_ADMIN_EMAIL, superAdminPassword) };
}

/**
 * #560 — attach now asks the bucket whether the bytes arrived. This stands in
 * for the client's PUT through the presigned URL, into the bucket the key's
 * prefix names (ADR-0005).
 */
function markUploaded(key: string): string {
  const token = /^(places|banners|campaigns)\//.test(key)
    ? PUBLIC_STORAGE_PROVIDER
    : STORAGE_PROVIDER;
  app.get<FakeStorage>(token).seed(key, new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
  return key;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cms_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.LOG_LEVEL = 'warn';
  // GoGo-BE#256 — export execution issues a secure artifact, which needs a key.
  process.env.EXPORT_WRAPPING_KEY_V1 = randomBytes(32).toString('base64');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp({ logDestination: logSink });
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('CMS auth + RBAC (CMS-001, FR-CMS-001, SRS §15.7)', () => {
  it('consumer tokens cannot reach CMS routes even hand-crafted', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'user@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'U' },
    });
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(reg.json().accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ADMIN_ONLY');
  });

  it('role matrix: editor blocked from ops endpoints; super_admin passes everywhere', async () => {
    const editor = await createAdmin('editor1@gogo.local', 'editor');
    const boss = await superAdmin();

    const editorOps = await api().inject({
      method: 'GET',
      url: '/v1/cms/ops/kpis',
      headers: auth(editor.token),
    });
    expect(editorOps.statusCode).toBe(403);
    expect(editorOps.json().code).toBe('ROLE_DENIED');

    const superOps = await api().inject({
      method: 'GET',
      url: '/v1/cms/ops/kpis',
      headers: auth(boss.token),
    });
    expect(superOps.statusCode).toBe(200);
  });

  it('suspended admin loses access immediately despite a valid token', async () => {
    const victim = await createAdmin('suspend-me@gogo.local', 'editor');
    await db
      .update(schema.adminUsers)
      .set({ status: 'suspended' })
      .where(eq(schema.adminUsers.id, victim.id));
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(victim.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('CMS account lifecycle (BE-CMS-G9 #248)', () => {
  const REASON = { reason: 'offboarding, ticket OPS-118' };

  /*
   * Awaited inside the helper, not returned as the chainable. `inject()` is
   * overloaded — hand back the un-awaited value and it types as
   * `void & Promise<Response> & Chain`, which has neither `statusCode` nor
   * `json` on it.
   */
  const post = async (token: string, url: string, payload: Record<string, unknown> = REASON) =>
    await api().inject({ method: 'POST', url, remoteAddress: ip(), headers: auth(token), payload });

  it('edits role and display name, and records both sides of the change', async () => {
    const boss = await superAdmin();
    const subject = await createAdmin('g9-subject@gogo.id.vn', 'editor');

    const res = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/auth/admins/${subject.id}`,
      headers: auth(boss.token),
      payload: { role: 'moderator', displayName: 'Đã đổi', ...REASON },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'moderator', displayName: 'Đã đổi' });

    const [entry] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, subject.id))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(1);
    // "role changed to moderator" does not tell a reviewer whether that was a
    // promotion or a demotion.
    expect(entry?.diff).toMatchObject({
      reason: REASON.reason,
      before: { role: 'editor' },
      after: { role: 'moderator' },
    });
  });

  /*
   * The one-person path from any role to any other removes the only check the
   * model has. A super_admin is already the top, so this is about separation
   * of duties, not privilege escalation.
   */
  it('refuses to let an admin change their own role', async () => {
    const boss = await superAdmin();
    const res = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/auth/admins/${boss.id}`,
      headers: auth(boss.token),
      payload: { role: 'editor', ...REASON },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SELF_ROLE_CHANGE');
  });

  it('allows an admin to change their own display name', async () => {
    const boss = await superAdmin();
    const res = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/auth/admins/${boss.id}`,
      headers: auth(boss.token),
      payload: { displayName: 'Tên mới', ...REASON },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to suspend your own account', async () => {
    const boss = await superAdmin();
    const res = await post(boss.token, `/v1/cms/auth/admins/${boss.id}/suspend`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SELF_SUSPEND');
  });

  /*
   * The guard already refuses a suspended account on the next request. The
   * revoke is a second, different thing: it closes the refresh chain, so the
   * account cannot walk itself forward on a token it already holds.
   */
  it('suspending revokes every session, not just the status', async () => {
    const boss = await superAdmin();
    const victim = await createAdmin('g9-victim@gogo.id.vn', 'editor');

    expect((await post(boss.token, `/v1/cms/auth/admins/${victim.id}/suspend`)).statusCode).toBe(
      201,
    );

    const blocked = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(victim.token),
    });
    /*
     * 401, not the 403 a merely-suspended account gets. The revoke put the
     * session on the denylist, so the token is dead rather than forbidden —
     * which is the stronger of the two outcomes and the reason for revoking at
     * all instead of leaning on the guard.
     */
    expect(blocked.statusCode).toBe(401);

    const sessions = await db
      .select()
      .from(schema.adminSessions)
      .where(eq(schema.adminSessions.adminId, victim.id));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(sessions.every((s) => s.revokeReason === 'admin_suspended')).toBe(true);

    const back = await post(boss.token, `/v1/cms/auth/admins/${victim.id}/reactivate`);
    expect(back.statusCode).toBe(201);
    expect(back.json().status).toBe('active');
  });

  /*
   * ADR-0018 — an environment has exactly one super_admin. It is bootstrapped
   * from credentials held in SSM and every other CMS account is created and
   * managed by it. Three layers refuse a second — the request schema, the
   * service and the database — and each is tested for what only it can catch.
   * #447 narrowed the request enum once GoGo-CMS#142 stopped offering the
   * value, so over HTTP the refusal is now a 400 on `role`.
   */
  it('refuses to create a second super_admin over HTTP', async () => {
    const boss = await superAdmin();
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/admins',
      headers: auth(boss.token),
      payload: {
        email: 'g9-second-super@gogo.id.vn',
        password: 'a-much-longer-password-1',
        displayName: 'Second',
        role: 'super_admin',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].field).toBe('role');

    const [existing] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, 'g9-second-super@gogo.id.vn'));
    expect(existing).toBeUndefined();
  });

  it('refuses to promote an existing account over HTTP', async () => {
    const boss = await superAdmin();
    const subject = await createAdmin('g9-promote@gogo.id.vn', 'ops_admin');
    const res = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/auth/admins/${subject.id}`,
      headers: auth(boss.token),
      payload: { role: 'super_admin', ...REASON },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors[0].field).toBe('role');

    const [after] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, subject.id));
    expect(after!.role).toBe('ops_admin');
  });

  /*
   * Demotion and suspension of the super_admin cannot be reached over HTTP at
   * all: the caller would have to be a *second* super_admin, which is the thing
   * that cannot exist. So the service is exercised directly — and the create and
   * promote cases go through it too, because a rule that only the controller
   * applies is a rule that disappears the day another caller (a script, a future
   * controller) reaches the service.
   */
  it('refuses the role in the service, which is where the refusal lives', async () => {
    const auth_ = app.get(AdminAuthService);
    const boss = await superAdmin();
    const subject = await createAdmin('g9-svc-promote@gogo.id.vn', 'editor');

    await expect(
      auth_.createAdmin({
        email: 'g9-svc-second@gogo.id.vn',
        password: 'a-much-longer-password-1',
        displayName: 'Second',
        role: 'super_admin',
        createdBy: boss.id,
      }),
    ).rejects.toMatchObject({ code: 'SUPER_ADMIN_SINGLETON', httpStatus: 409 });

    await expect(
      auth_.updateAdmin({
        id: subject.id,
        role: 'super_admin',
        reason: REASON.reason,
        actorId: boss.id,
      }),
    ).rejects.toMatchObject({ code: 'SUPER_ADMIN_SINGLETON', httpStatus: 409 });
  });

  it('refuses to demote or suspend the one super_admin', async () => {
    const auth_ = app.get(AdminAuthService);
    const boss = await superAdmin();
    // Any actor id: the refusal is about the subject, and an actor who could
    // make this call would have to be a second super_admin.
    const actor = await createAdmin('g9-demoter@gogo.id.vn', 'ops_admin');

    await expect(
      auth_.updateAdmin({
        id: boss.id,
        role: 'editor',
        reason: REASON.reason,
        actorId: actor.id,
      }),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN', httpStatus: 409 });

    await expect(
      auth_.setAdminStatus({
        id: boss.id,
        status: 'suspended',
        reason: REASON.reason,
        actorId: actor.id,
      }),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN', httpStatus: 409 });

    const [after] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, boss.id));
    expect(after).toMatchObject({ role: 'super_admin', status: 'active' });
  });

  /*
   * The layer that holds when the service is bypassed. The seed wrote to this
   * table, the bootstrap command writes to it, and a psql session always can —
   * so the invariant is a constraint, not a convention.
   */
  it('refuses a second super_admin row in the database itself', async () => {
    await superAdmin();
    const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });

    // Drizzle wraps the driver error, so the message is "Failed query: …" and
    // both the SQLSTATE and the constraint name sit on the cause. Asserted
    // through it rather than around it: "some insert failed" would pass on a
    // typo'd column, and the constraint name is the thing under test.
    let caught: unknown;
    try {
      await db.insert(schema.adminUsers).values({
        email: 'g9-db-second@gogo.id.vn',
        passwordHash,
        displayName: 'Second',
        role: 'super_admin',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { cause?: { code?: string; constraint?: string } }).cause).toMatchObject({
      code: '23505',
      constraint: 'admin_users_single_super_admin',
    });

    const [existing] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, 'g9-db-second@gogo.id.vn'));
    expect(existing).toBeUndefined();
  });

  /*
   * The bootstrap credential in SSM is what the first login is typed from and
   * nothing after that: the database holds the Argon2id hash, so rotation is
   * this flow — authenticated, audited, and revoking the sessions it
   * invalidates — and not an edit to a parameter.
   */
  it('lets the super_admin rotate its own bootstrap password', async () => {
    const boss = await superAdmin();
    const stale = (await superAdmin()).token; // a second live session
    const rotated = 'rotated-super-password-1';

    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/change-password',
      remoteAddress: ip(),
      headers: auth(boss.token),
      payload: { currentPassword: superAdminPassword, newPassword: rotated },
    });
    expect(res.statusCode).toBe(201);
    superAdminPassword = rotated;

    // The session that did the rotating survives; every other one is dead.
    expect(
      (await api().inject({ method: 'GET', url: '/v1/cms/places', headers: auth(boss.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await api().inject({ method: 'GET', url: '/v1/cms/places', headers: auth(stale) }))
        .statusCode,
    ).toBe(401);

    const [entry] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, boss.id),
          eq(schema.auditLogs.action, 'admin.password_changed'),
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(1);
    expect(entry).toBeDefined();

    // The old password is gone, and the new one is what signs in.
    const old = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders(SUPER_ADMIN_EMAIL),
      payload: { email: SUPER_ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(old.statusCode).toBe(401);

    // Put it back, so the shared fixture is what the rest of the file expects —
    // and rotating twice is worth one assertion of its own.
    const back = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/change-password',
      remoteAddress: ip(),
      headers: auth((await superAdmin()).token),
      payload: { currentPassword: rotated, newPassword: ADMIN_PASSWORD },
    });
    expect(back.statusCode).toBe(201);
    superAdminPassword = ADMIN_PASSWORD;
  });

  /*
   * A temporary password is a credential two people know. Until it is replaced
   * the account may do exactly one thing — enforced by the server, not by the
   * console skipping a screen (`core.md` #5).
   */
  it('a temporary password locks the console until it is replaced', async () => {
    const boss = await superAdmin();
    const target = await createAdmin('g9-reset@gogo.id.vn', 'ops_admin');

    const reset = await post(boss.token, `/v1/cms/auth/admins/${target.id}/reset-password`);
    expect(reset.statusCode).toBe(201);
    const temporary = reset.json().temporaryPassword as string;
    expect(temporary).toBeTruthy();
    expect(reset.json().mustChangePassword).toBe(true);

    // The reset revoked the session it had; the old token is dead.
    const dead = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(target.token),
    });
    expect(dead.statusCode).toBe(401);

    const login = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders('g9-reset@gogo.id.vn'),
      payload: { email: 'g9-reset@gogo.id.vn', password: temporary },
    });
    expect(login.statusCode).toBe(201);
    expect(login.json().mustChangePassword).toBe(true);
    const token = login.json().accessToken as string;

    const walled = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(token),
    });
    expect(walled.statusCode).toBe(403);
    expect(walled.json().code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/change-password',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { currentPassword: temporary, newPassword: 'a-much-longer-password-1' },
    });
    expect(changed.statusCode).toBe(201);

    const free = await api().inject({
      method: 'GET',
      url: '/v1/cms/places',
      headers: auth(token),
    });
    expect(free.statusCode).toBe(200);
  });

  /*
   * Without the current password a leaked session id would be enough to take
   * the account over permanently.
   */
  it('refuses a change that cannot present the current password', async () => {
    const admin = await createAdmin('g9-wrongpw@gogo.id.vn', 'editor');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/change-password',
      remoteAddress: ip(),
      headers: auth(admin.token),
      payload: { currentPassword: 'not-the-password', newPassword: 'a-much-longer-password-1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('never returns a password hash or the reset reason as a credential', async () => {
    const boss = await superAdmin();
    const list = await api().inject({
      method: 'GET',
      url: '/v1/cms/auth/admins?limit=100',
      headers: auth(boss.token),
    });
    expect(list.statusCode).toBe(200);
    const body = JSON.stringify(list.json());
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$argon2');
    expect(body).not.toContain('mfaTotpSecret');
    // #687 D-4 — TOTP is gone, and so is the status that described it.
    expect(list.json().items[0]).not.toHaveProperty('mfaEnrolled');
    expect(list.json().items[0]).toHaveProperty('mustChangePassword');
  });

  it('is closed to every role below super_admin', async () => {
    const ops = await createAdmin('g9-ops@gogo.id.vn', 'ops_admin');
    const victim = await createAdmin('g9-ops-victim@gogo.id.vn', 'editor');
    for (const url of [
      `/v1/cms/auth/admins/${victim.id}/suspend`,
      `/v1/cms/auth/admins/${victim.id}/reset-password`,
    ]) {
      const res = await post(ops.token, url);
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('CMS single sign-on exchange (#62, ADR-0010)', () => {
  const exchange = (headers: Record<string, string> = {}) =>
    api().inject({ method: 'POST', url: '/v1/cms/auth/access-exchange', headers });

  /*
   * Reachable without a session on purpose — it is how a session begins. What
   * it must never be is reachable without an assertion.
   */
  it('refuses a call that did not come through Access', async () => {
    const res = await exchange();
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ACCESS_ASSERTION_MISSING');
  });

  /*
   * `.claude/rules/core.md` #16 — a control that exists but is not configured
   * says so. A 404 here would read as "this build does not have SSO" and send
   * somebody looking for the wrong thing; the test environment has no Access
   * application, which is exactly the state being described.
   */
  it('answers 503 where SSO is not configured, not 404 and not a login failure', async () => {
    // Every integration spec has a test Access application (support/cms-access.ts); this
    // one case takes it away.
    const config = app.get<{ CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string }>(APP_CONFIG);
    const saved = { team: config.CF_ACCESS_TEAM_DOMAIN, aud: config.CF_ACCESS_AUD };
    config.CF_ACCESS_TEAM_DOMAIN = '';
    config.CF_ACCESS_AUD = '';
    const res = await exchange({ 'cf-access-jwt-assertion': 'a.b.c' }).finally(() => {
      config.CF_ACCESS_TEAM_DOMAIN = saved.team;
      config.CF_ACCESS_AUD = saved.aud;
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('ACCESS_SSO_NOT_CONFIGURED');
    // Not retryable: retrying a missing configuration produces load, not a fix.
    expect(res.json().retryable).toBe(false);
  });
});

/**
 * #679 / ADR-0032 — DEV is Access-only: the password door closes, and the
 * sessions it already opened stop refreshing. One app serves the whole file,
 * so each test flips the live config object and puts it back; the boot-time
 * rule that refuses a door-less configuration is `env.spec.ts`'s to prove.
 */
describe('CMS password door closed (#679, ADR-0032)', () => {
  type DoorConfig = {
    CMS_PASSWORD_LOGIN_ENABLED: boolean;
    CMS_SUPER_ADMIN_SSO_ONLY: boolean;
  };

  /**
   * An assertion from the test Access application every integration spec has
   * (support/cms-access.ts), used by `access-exchange`.
   */
  const assertionFor = cmsAssertion;

  /**
   * Runs `fn` with Access configured and the password door as given; the third
   * argument is #687's super-admin-only switch.
   */
  async function withDoors<T>(
    passwordOpen: boolean,
    fn: () => Promise<T>,
    superAdminSsoOnly = false,
  ): Promise<T> {
    const config = app.get<DoorConfig>(APP_CONFIG);
    const saved = {
      CMS_PASSWORD_LOGIN_ENABLED: config.CMS_PASSWORD_LOGIN_ENABLED,
      CMS_SUPER_ADMIN_SSO_ONLY: config.CMS_SUPER_ADMIN_SSO_ONLY,
    };
    config.CMS_PASSWORD_LOGIN_ENABLED = passwordOpen;
    config.CMS_SUPER_ADMIN_SSO_ONLY = superAdminSsoOnly;
    try {
      return await fn();
    } finally {
      Object.assign(config, saved);
    }
  }

  /**
   * Sends a test Access assertion by default. Since #687 rev 6 the password
   * door ignores it; `null` sends none (what a browser on the public page does).
   */
  const login = (email: string, password: string, assertion: string | null = assertionFor(email)) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      payload: { email, password },
      ...(assertion ? { headers: { 'cf-access-jwt-assertion': assertion } } : {}),
    });
  const refresh = (refreshToken: string) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/auth/refresh',
      remoteAddress: ip(),
      payload: { refreshToken },
    });
  const exchange = (email: string, headers: Record<string, string> = {}) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/auth/access-exchange',
      remoteAddress: ip(),
      headers: { 'cf-access-jwt-assertion': assertionFor(email), ...headers },
    });

  /** Session ids of this account, so a test can tell its own family from the login `createAdmin` did. */
  const sessionIds = async (email: string) =>
    (
      await db
        .select({ id: schema.adminSessions.id })
        .from(schema.adminSessions)
        .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminSessions.adminId))
        .where(eq(schema.adminUsers.email, email))
    ).map((row) => row.id);

  const sessionsAfter = async (email: string, before: string[]) =>
    (
      await db
        .select({
          id: schema.adminSessions.id,
          revokedAt: schema.adminSessions.revokedAt,
          reason: schema.adminSessions.revokeReason,
          method: schema.adminSessions.authMethod,
        })
        .from(schema.adminSessions)
        .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminSessions.adminId))
        .where(eq(schema.adminUsers.email, email))
    ).filter((row) => !before.includes(row.id));

  /*
   * Migration 0071 adds the CHECK NOT VALID so no scan runs under the
   * exclusive lock (review F-01). NOT VALID still binds every write.
   */
  it('refuses an unknown door on write even though the check was added NOT VALID', async () => {
    const [constraint] = (
      await pool.query(
        `select convalidated from pg_constraint where conname = 'admin_sessions_auth_method_check'`,
      )
    ).rows as { convalidated: boolean }[];
    expect(constraint?.convalidated).toBe(false);

    const email = 'bad-door@gogo.local';
    await createAdmin(email, 'editor');
    await expect(
      pool.query(
        `update admin_sessions set auth_method = 'magic_link'
           where admin_id = (select id from admin_users where email = $1)`,
        [email],
      ),
    ).rejects.toThrow(/admin_sessions_auth_method_check/);
  });

  it('reports which doors are open, without a session and without caching', async () => {
    const before = await api().inject({ method: 'GET', url: '/v1/cms/auth/methods' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ password: true, accessSso: true, superAdminSsoOnly: false });
    expect(before.headers['cache-control']).toBe('no-store');

    await withDoors(false, async () => {
      const after = await api().inject({ method: 'GET', url: '/v1/cms/auth/methods' });
      expect(after.json()).toEqual({ password: false, accessSso: true, superAdminSsoOnly: false });
    });
  });

  it('refuses a correct and a wrong password identically, and records nothing', async () => {
    const email = 'door-closed@gogo.local';
    const { id } = await createAdmin(email, 'editor');
    const attemptsBefore = await db.select().from(schema.loginAttempts);
    const auditBefore = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.actorId, id));

    await withDoors(false, async () => {
      const right = await login(email, ADMIN_PASSWORD);
      const wrong = await login(email, 'not-the-password-at-all');
      for (const res of [right, wrong]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('PASSWORD_LOGIN_DISABLED');
        expect(res.json().retryable).toBe(false);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    });

    // Both refusals reached the structured stream at warn, from the service,
    // naming no address.
    const warned = warnLines.filter(
      (l) => l.context === 'AdminAuthService' && String(l.msg).includes('cms.login refused'),
    );
    expect(warned.length).toBeGreaterThanOrEqual(2);
    for (const line of warned) {
      expect(line.level).toBe('warn');
      expect(JSON.stringify(line)).not.toContain(email);
    }

    // No lockout row and no audit row: there was no credential check and no actor.
    expect(await db.select().from(schema.loginAttempts)).toHaveLength(attemptsBefore.length);
    expect(
      await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actorId, id)),
    ).toHaveLength(auditBefore.length);
  });

  /*
   * Refresh slides the expiry forward, so without this a session opened by
   * password before the flip would outlive the decision for as long as it
   * kept being used.
   */
  it('stops a password-born session from refreshing once the door closes, and revokes its family', async () => {
    const email = 'pre-flip@gogo.local';
    await createAdmin(email, 'editor');
    const before = await sessionIds(email);
    const opened = await login(email, ADMIN_PASSWORD);
    const first = opened.json().refreshToken as string;
    // Still open: rotation works and inherits the door.
    const rotated = await refresh(first);
    expect(rotated.statusCode).toBe(201);

    const warnedBefore = warnLines.length;
    await withDoors(false, async () => {
      const refused = await refresh(rotated.json().refreshToken as string);
      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe('SESSION_REVOKED');
    });
    expect(
      warnLines
        .slice(warnedBefore)
        .some(
          (l) =>
            l.level === 'warn' &&
            l.context === 'AdminAuthService' &&
            String(l.msg).includes('cms.refresh refused'),
        ),
    ).toBe(true);

    const family = await sessionsAfter(email, before);
    expect(family).toHaveLength(2);
    for (const row of family) {
      expect(row.method).toBe('password');
      expect(row.revokedAt).not.toBeNull();
    }
    expect(family.some((row) => row.reason === 'password_login_disabled')).toBe(true);
  });

  /*
   * A session from before the column existed (NULL) counts as password-born:
   * it refreshes while the door is open, and once the door closes the first
   * refresh revokes the whole family — every row, with the reason.
   */
  it('treats a session from before the column existed as password-born, both ways', async () => {
    const email = 'legacy-session@gogo.local';
    await createAdmin(email, 'editor');
    const before = await sessionIds(email);
    const opened = await login(email, ADMIN_PASSWORD);
    const legacy = async () => {
      const ids = (await sessionsAfter(email, before)).map((row) => row.id);
      await db
        .update(schema.adminSessions)
        .set({ authMethod: null })
        .where(inArray(schema.adminSessions.id, ids));
    };
    await legacy();

    // Door open: a legacy session rotates as it always did.
    const rotated = await refresh(opened.json().refreshToken as string);
    expect(rotated.statusCode).toBe(201);
    await legacy();

    await withDoors(false, async () => {
      const refused = await refresh(rotated.json().refreshToken as string);
      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe('SESSION_REVOKED');
    });

    const family = await sessionsAfter(email, before);
    expect(family).toHaveLength(2);
    for (const row of family) {
      expect(row.method).toBeNull();
      expect(row.revokedAt).not.toBeNull();
      expect(row.reason).toBe('password_login_disabled');
    }
  });

  it('keeps Access as a working door: exchange opens a session that refreshes and stays SSO', async () => {
    const email = 'sso-only@gogo.local';
    await createAdmin(email, 'editor');
    const before = await sessionIds(email);

    await withDoors(false, async () => {
      const opened = await exchange(email, { 'sec-fetch-site': 'same-origin' });
      expect(opened.statusCode).toBe(201);
      const rotated = await refresh(opened.json().refreshToken as string);
      expect(rotated.statusCode).toBe(201);
      const again = await refresh(rotated.json().refreshToken as string);
      expect(again.statusCode).toBe(201);
    });

    const methods = await sessionsAfter(email, before);
    expect(methods).toHaveLength(3);
    expect(methods.every((row) => row.method === 'access_sso')).toBe(true);
  });

  /*
   * #687 / ADR-0034 — only the super admin is Access-only; every other role
   * keeps the password door. DEV runs `{password: true, superAdminSsoOnly: true}`.
   */
  describe('super admin through Access only (#687, ADR-0034)', () => {
    const superOnly = <T>(fn: () => Promise<T>) => withDoors(true, fn, true);
    const identifierHash = (email: string) =>
      createHash('sha256').update(`admin:${email.trim().toLowerCase()}`).digest('hex');
    const attemptsFor = async (email: string) =>
      db
        .select()
        .from(schema.loginAttempts)
        .where(eq(schema.loginAttempts.identifierHash, identifierHash(email)));

    it('reports the fact on methods, beside an open password door', async () => {
      await superOnly(async () => {
        const res = await api().inject({ method: 'GET', url: '/v1/cms/auth/methods' });
        expect(res.json()).toEqual({ password: true, accessSso: true, superAdminSsoOnly: true });
      });
    });

    it('refuses the super admin with a correct and a wrong password identically, and records nothing', async () => {
      const boss = await superAdmin();
      const attemptsBefore = await attemptsFor(SUPER_ADMIN_EMAIL);
      const auditBefore = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.actorId, boss.id));
      const warnedBefore = warnLines.length;
      // Sol F-01 — the claim is that the password is never compared, so prove
      // the call never happens rather than inferring it from missing rows.
      // The instances AdminAuthService holds: the CMS module provides its own,
      // so `app.get(PasswordService)` would be a different object.
      const deps = app.get(AdminAuthService) as unknown as {
        passwords: PasswordService;
        identity: IdentityRepository;
      };
      const verify = vi.spyOn(deps.passwords, 'verifyOrBurn');
      const record = vi.spyOn(deps.identity, 'recordLoginAttempt');
      let calls = { verify: -1, record: -1 };

      await superOnly(async () => {
        const right = await login(SUPER_ADMIN_EMAIL, superAdminPassword);
        const wrong = await login(SUPER_ADMIN_EMAIL, 'not-the-password-at-all');
        for (const res of [right, wrong]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe('SUPER_ADMIN_SSO_ONLY');
          expect(res.json().retryable).toBe(false);
          expect(res.headers['set-cookie']).toBeUndefined();
        }
      }).finally(() => {
        // Counted before restoring: mockRestore clears the call history.
        calls = { verify: verify.mock.calls.length, record: record.mock.calls.length };
        verify.mockRestore();
        record.mockRestore();
      });
      expect(calls).toEqual({ verify: 0, record: 0 });

      const warned = warnLines
        .slice(warnedBefore)
        .filter(
          (l) => l.context === 'AdminAuthService' && String(l.msg).includes('SUPER_ADMIN_SSO_ONLY'),
        );
      expect(warned.length).toBeGreaterThanOrEqual(2);
      for (const line of warned) {
        expect(line.level).toBe('warn');
        expect(JSON.stringify(line)).not.toContain(SUPER_ADMIN_EMAIL);
      }
      // The password was never compared: no attempt row, so no lockout is fed,
      // and no audit row under the super admin's id.
      expect(await attemptsFor(SUPER_ADMIN_EMAIL)).toHaveLength(attemptsBefore.length);
      expect(
        await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actorId, boss.id)),
      ).toHaveLength(auditBefore.length);
    });

    it('leaves every other role, and unknown addresses, exactly as before', async () => {
      const roles = ['editor', 'moderator', 'ops_admin'] as const;
      for (const role of roles) await createAdmin(`${role}-keeps-password@gogo.local`, role);
      const email = 'editor-keeps-password@gogo.local';
      const attemptsBefore = await attemptsFor(email);

      await superOnly(async () => {
        for (const role of roles) {
          const ok = await login(`${role}-keeps-password@gogo.local`, ADMIN_PASSWORD);
          expect(ok.statusCode, role).toBe(201);
        }
        const wrong = await login(email, 'not-the-password-at-all');
        expect(wrong.statusCode).toBe(401);
        expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
        const unknown = await login('nobody-here@gogo.local', 'whatever-password-1');
        expect(unknown.statusCode).toBe(401);
        expect(unknown.json().code).toBe('INVALID_CREDENTIALS');
      });

      // The editor's two attempts were checked and recorded as always.
      expect(await attemptsFor(email)).toHaveLength(attemptsBefore.length + 2);
    });

    it('orders refusals: IP limit, closed general door, account lockout, then its own', async () => {
      await superAdmin();
      // Astra F-04 — the per-IP limit is a guard and runs before the service,
      // so an exhausted IP answers 429 even where the general door is closed.
      const fixedIp = ip();
      await withDoors(
        false,
        async () => {
          const statuses: number[] = [];
          for (let i = 0; i < 6; i += 1) {
            const res = await api().inject({
              method: 'POST',
              url: '/v1/cms/auth/login',
              remoteAddress: fixedIp,
              headers: cmsAccessHeaders(SUPER_ADMIN_EMAIL),
              payload: { email: SUPER_ADMIN_EMAIL, password: superAdminPassword },
            });
            statuses.push(res.statusCode);
          }
          expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
        },
        true,
      );

      // Both switches: the general door's answer wins, for every role.
      await withDoors(
        false,
        async () => {
          const res = await login(SUPER_ADMIN_EMAIL, superAdminPassword);
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe('PASSWORD_LOGIN_DISABLED');
        },
        true,
      );

      // An identifier locked by failures from before the flip answers 429.
      const seeded = await db
        .insert(schema.loginAttempts)
        .values(
          Array.from({ length: ADMIN_LOCKOUT_THRESHOLD }, () => ({
            identifierHash: identifierHash(SUPER_ADMIN_EMAIL),
            ipHash: 'seeded-for-precedence',
            succeeded: false,
          })),
        )
        .returning({ id: schema.loginAttempts.id });
      try {
        await superOnly(async () => {
          const res = await login(SUPER_ADMIN_EMAIL, superAdminPassword);
          expect(res.statusCode).toBe(429);
        });
      } finally {
        await db.delete(schema.loginAttempts).where(
          inArray(
            schema.loginAttempts.id,
            seeded.map((row) => row.id),
          ),
        );
      }
    });

    it('stops the super admin password-born sessions refreshing, legacy ones too, and revokes the family', async () => {
      await superAdmin();
      const before = await sessionIds(SUPER_ADMIN_EMAIL);
      const first = await login(SUPER_ADMIN_EMAIL, superAdminPassword);
      expect(first.statusCode).toBe(201);
      // Sol F-04 — rotate once before the flip, so the family has two rows and
      // revoking only the presented session would show.
      const opened = await refresh(first.json().refreshToken as string);
      expect(opened.statusCode).toBe(201);
      const legacyOpened = await login(SUPER_ADMIN_EMAIL, superAdminPassword);
      expect(legacyOpened.statusCode).toBe(201);
      // The second family predates the column.
      const [legacyRow] = await db
        .select({ id: schema.adminSessions.id })
        .from(schema.adminSessions)
        .where(
          eq(
            schema.adminSessions.refreshTokenHash,
            createHash('sha256')
              .update(legacyOpened.json().refreshToken as string)
              .digest('hex'),
          ),
        );
      expect(legacyRow).toBeDefined();
      await db
        .update(schema.adminSessions)
        .set({ authMethod: null })
        .where(eq(schema.adminSessions.id, legacyRow!.id));

      const warnedBefore = warnLines.length;
      await superOnly(async () => {
        for (const res of [opened, legacyOpened]) {
          const refused = await refresh(res.json().refreshToken as string);
          expect(refused.statusCode).toBe(401);
          expect(refused.json().code).toBe('SESSION_REVOKED');
        }
      });
      expect(
        warnLines
          .slice(warnedBefore)
          .some(
            (l) =>
              l.level === 'warn' &&
              l.context === 'AdminAuthService' &&
              String(l.msg).includes('cms.refresh refused: super_admin'),
          ),
      ).toBe(true);

      const families = await sessionsAfter(SUPER_ADMIN_EMAIL, before);
      expect(families).toHaveLength(3);
      for (const row of families) {
        expect(row.revokedAt).not.toBeNull();
        expect(row.reason).toBe('super_admin_sso_only');
      }
    });

    it('lets other roles password sessions and the super admin SSO session keep rotating', async () => {
      const email = 'editor-keeps-refreshing@gogo.local';
      await createAdmin(email, 'editor');
      const editorBefore = await sessionIds(email);
      await superAdmin();
      const bossBefore = await sessionIds(SUPER_ADMIN_EMAIL);

      await superOnly(async () => {
        // A staff password family (rev 6: refreshes with or without Access).
        const editorOpened = await login(email, ADMIN_PASSWORD);
        expect(editorOpened.statusCode).toBe(201);
        const editorRotated = await refresh(editorOpened.json().refreshToken as string);
        expect(editorRotated.statusCode).toBe(201);

        const sso = await exchange(SUPER_ADMIN_EMAIL, { 'sec-fetch-site': 'same-origin' });
        expect(sso.statusCode).toBe(201);
        const ssoRotated = await refresh(sso.json().refreshToken as string);
        expect(ssoRotated.statusCode).toBe(201);
      });

      const editorRows = await sessionsAfter(email, editorBefore);
      expect(editorRows.every((row) => row.method === 'password' && row.revokedAt === null)).toBe(
        true,
      );
      const bossRows = await sessionsAfter(SUPER_ADMIN_EMAIL, bossBefore);
      expect(bossRows).toHaveLength(2);
      expect(bossRows.every((row) => row.method === 'access_sso')).toBe(true);
    });

    it('is a no-op when off: the super admin signs in and refreshes by password as before', async () => {
      await superAdmin();
      await withDoors(true, async () => {
        const res = await login(SUPER_ADMIN_EMAIL, superAdminPassword);
        expect(res.statusCode).toBe(201);
        // Sol F-03 — the refresh rule is guarded by the switch, not by the role.
        const rotated = await refresh(res.json().refreshToken as string);
        expect(rotated.statusCode).toBe(201);
      });
    });
  });

  /*
   * #687 BE-b (shape rev 5 D-3) — the super admin's address comes from SSM, the
   * sync revokes in the database and the guard reads it there, and nothing
   * gives the super admin a password back while the switch is on.
   */
  describe('super admin follows SSM (#687 D-3)', () => {
    const superOnly = <T>(fn: () => Promise<T>) => withDoors(true, fn, true);
    const confirmSso = (token: string) =>
      api().inject({
        method: 'POST',
        url: '/v1/cms/auth/super-admin/confirm-sso',
        remoteAddress: ip(),
        headers: auth(token),
      });
    const confirmations = async (id: string) =>
      db
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'admin.sso_confirmed'),
            eq(schema.auditLogs.resourceId, id),
          ),
        );

    it('AC-9: the super admin address cannot be changed through the API (409)', async () => {
      const boss = await superAdmin();
      const res = await api().inject({
        method: 'PATCH',
        url: `/v1/cms/auth/admins/${boss.id}`,
        remoteAddress: ip(),
        headers: auth(boss.token),
        payload: { email: 'someone-else@gogo.local', reason: 'try to move the super admin' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SUPER_ADMIN_EMAIL_FROM_SSM');
      const [row] = await db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.id, boss.id));
      expect(row!.email).toBe(SUPER_ADMIN_EMAIL);
    });

    it('a staff address still changes through the API', async () => {
      const boss = await superAdmin();
      const staff = await createAdmin(`move-me-${Date.now()}@gogo.local`, 'editor');
      const res = await api().inject({
        method: 'PATCH',
        url: `/v1/cms/auth/admins/${staff.id}`,
        remoteAddress: ip(),
        headers: auth(boss.token),
        payload: { email: `moved-${Date.now()}@gogo.local`, reason: 'staff moves mailbox' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('confirm-sso refuses a password session (403 ACCESS_SESSION_REQUIRED) and writes nothing', async () => {
      const boss = await superAdmin();
      const before = (await confirmations(boss.id)).length;
      const res = await confirmSso(boss.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCESS_SESSION_REQUIRED');
      expect(await confirmations(boss.id)).toHaveLength(before);
    });

    it('confirm-sso refuses any other role', async () => {
      const staff = await createAdmin(`confirm-${Date.now()}@gogo.local`, 'ops_admin');
      const res = await confirmSso(staff.token);
      expect(res.statusCode).toBe(403);
    });

    it('confirm-sso from an Access session records the current address once', async () => {
      const boss = await superAdmin();
      await superOnly(async () => {
        const ex = await exchange(SUPER_ADMIN_EMAIL);
        expect(ex.statusCode).toBe(201);
        const token = ex.json().accessToken as string;
        const first = await confirmSso(token);
        const second = await confirmSso(token);
        expect(first.statusCode).toBe(201);
        expect(first.json()).toMatchObject({ confirmed: true, email: SUPER_ADMIN_EMAIL });
        expect(second.json().alreadyConfirmed).toBe(true);
        const rows = await confirmations(boss.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.diff).toMatchObject({ email: SUPER_ADMIN_EMAIL });
      });
    });

    it('F-01: a session revoked after the guard let it in cannot confirm', async () => {
      const boss = await superAdmin();
      const [revoked] = await db
        .insert(schema.adminSessions)
        .values({
          adminId: boss.id,
          refreshTokenHash: `revoked-${Date.now()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          authMethod: 'access_sso',
          revokedAt: new Date(),
          revokeReason: 'email_changed',
        })
        .returning();
      const before = (await confirmations(boss.id)).length;
      await expect(
        app
          .get(AdminAuthService)
          .confirmSuperAdminSso({ adminId: boss.id, sessionId: revoked!.id }),
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      expect(await confirmations(boss.id)).toHaveLength(before);
    });

    it('F-02: confirm-sso is reachable with a password change owed, and the next sync clears both', async () => {
      const boss = await superAdmin();
      await db
        .update(schema.adminUsers)
        .set({ mustChangePasswordAt: new Date() })
        .where(eq(schema.adminUsers.id, boss.id));
      try {
        await superOnly(async () => {
          const token = (await exchange(SUPER_ADMIN_EMAIL)).json().accessToken as string;
          const res = await confirmSso(token);
          expect(res.statusCode).toBe(201);
        });
        const synced = await syncSuperAdmin(db, { email: SUPER_ADMIN_EMAIL, ssoOnly: true });
        expect(synced.passwordErased).toBe(true);
        const [row] = await db
          .select()
          .from(schema.adminUsers)
          .where(eq(schema.adminUsers.id, boss.id));
        expect(row).toMatchObject({ passwordHash: null, mustChangePasswordAt: null });
      } finally {
        // Later tests sign the super admin in by password.
        await db
          .update(schema.adminUsers)
          .set({
            passwordHash: await argon2.hash(superAdminPassword, { type: argon2.argon2id }),
            mustChangePasswordAt: null,
          })
          .where(eq(schema.adminUsers.id, boss.id));
      }
    });

    it('F-05: the new API erases a hash the previous API put back after the sync', async () => {
      const boss = await superAdmin();
      const config = app.get<{ CMS_SUPER_ADMIN_EMAIL?: string | undefined }>(APP_CONFIG);
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      try {
        await superOnly(async () => {
          // A confirmation for the current address (idempotent if one exists).
          const token = (await exchange(SUPER_ADMIN_EMAIL)).json().accessToken as string;
          expect((await confirmSso(token)).statusCode).toBe(201);
          // The old process (switch off) served a reset after the sync ran.
          await db
            .update(schema.adminUsers)
            .set({ passwordHash: 'argon2id$restored-by-old-api', mustChangePasswordAt: new Date() })
            .where(eq(schema.adminUsers.id, boss.id));
          config.CMS_SUPER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;
          await app.get(AdminAuthService).onApplicationBootstrap();
        });
        const [row] = await db
          .select()
          .from(schema.adminUsers)
          .where(eq(schema.adminUsers.id, boss.id));
        expect(row).toMatchObject({ passwordHash: null, mustChangePasswordAt: null });
      } finally {
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
        await db
          .update(schema.adminUsers)
          .set({
            passwordHash: await argon2.hash(superAdminPassword, { type: argon2.argon2id }),
            mustChangePasswordAt: null,
          })
          .where(eq(schema.adminUsers.id, boss.id));
      }
    });

    it('F-05: at boot with the switch off, nothing is erased', async () => {
      const boss = await superAdmin();
      const config = app.get<{ CMS_SUPER_ADMIN_EMAIL?: string | undefined }>(APP_CONFIG);
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      config.CMS_SUPER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;
      try {
        await app.get(AdminAuthService).onApplicationBootstrap();
      } finally {
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
      }
      const [row] = await db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.id, boss.id));
      expect(row!.passwordHash).not.toBeNull();
    });

    /*
     * Review round 2 of #690 (Sol F-05 = Astra): the gate above used to log a
     * failure and let the API start. These pin the new contract — a database
     * error is retried, the two inconsistent states and an exhausted retry
     * reject the bootstrap hook (so Nest never listens), and `pending` starts.
     */
    const bootConfig = () => app.get<{ CMS_SUPER_ADMIN_EMAIL?: string | undefined }>(APP_CONFIG);
    const bootGate = () => app.get(AdminAuthService).onApplicationBootstrap();
    const superAdminRow = async (id: string) => {
      const [row] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, id));
      return row!;
    };
    const restoreSuperAdminPassword = async (id: string) => {
      await db
        .update(schema.adminUsers)
        .set({
          passwordHash: await argon2.hash(superAdminPassword, { type: argon2.argon2id }),
          mustChangePasswordAt: null,
        })
        .where(eq(schema.adminUsers.id, id));
    };
    /**
     * The confirmation the gate reads, written as the endpoint writes it. Not
     * through `confirm-sso`: that door is limited to 5/min per actor and the
     * tests above already spend that budget; the endpoint has its own tests.
     */
    const ensureSsoConfirmed = async (id: string) => {
      const existing = await db
        .select({ id: schema.auditLogs.id })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'admin.sso_confirmed'),
            eq(schema.auditLogs.resourceId, id),
            sql`lower(${schema.auditLogs.diff} ->> 'email') = ${SUPER_ADMIN_EMAIL}`,
          ),
        )
        .limit(1);
      if (existing.length > 0) return;
      await db.insert(schema.auditLogs).values({
        actorType: 'admin',
        actorId: id,
        action: 'admin.sso_confirmed',
        resourceType: 'admin_user',
        resourceId: id,
        diff: { email: SUPER_ADMIN_EMAIL, sessionId: randomUUID() },
      });
    };

    it('F-05 r2: a transient database failure at boot is retried and the erase still commits', async () => {
      const boss = await superAdmin();
      const config = bootConfig();
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      const live = app.get<Db>(DB);
      let flaky: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await superOnly(async () => {
          await ensureSsoConfirmed(boss.id);
          await db
            .update(schema.adminUsers)
            .set({ passwordHash: 'argon2id$restored-by-old-api', mustChangePasswordAt: new Date() })
            .where(eq(schema.adminUsers.id, boss.id));
          config.CMS_SUPER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;
          // The first transaction the gate opens dies under it; the next one is
          // real. The failure is what Drizzle really throws: its message and
          // stack repeat the bound parameters, the address among them (F-07).
          flaky = vi
            .spyOn(live, 'transaction')
            .mockImplementationOnce(() =>
              Promise.reject(
                new DrizzleQueryError(
                  'select "id" from "admin_users" where lower("email") = $1',
                  [SUPER_ADMIN_EMAIL],
                  Object.assign(new Error('terminating connection (simulated)'), { code: '57P01' }),
                ),
              ),
            );
          const started = Date.now();
          await bootGate();
          // One retry after the first backoff, not an immediate second try.
          expect(Date.now() - started).toBeGreaterThanOrEqual(450);
        });
        expect(flaky).toHaveBeenCalledTimes(2);
        expect(await superAdminRow(boss.id)).toMatchObject({
          passwordHash: null,
          mustChangePasswordAt: null,
        });
        const gateLines = warnLines.filter(
          (l) => l.context === 'AdminAuthService' && String(l.msg).includes('erase gate'),
        );
        expect(gateLines.length).toBeGreaterThan(0);
        // F-07: the real logger line carries the class and the code, not the address.
        for (const line of gateLines) {
          expect(JSON.stringify(line)).not.toContain(SUPER_ADMIN_EMAIL);
          expect(JSON.stringify(line)).not.toContain('Failed query');
        }
        expect(
          gateLines.some((l) =>
            String(l.msg).includes(
              'attempt 1/6 failed (DrizzleQueryError <- Error 57P01); retrying in 500ms',
            ),
          ),
        ).toBe(true);
      } finally {
        flaky?.mockRestore();
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
        await restoreSuperAdminPassword(boss.id);
      }
    });

    it('F-05 r2: with the switch on and no super_admin row, the API refuses to start', async () => {
      const boss = await superAdmin();
      const config = bootConfig();
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      // The sync never ran for this revision: nothing holds the role.
      await db
        .update(schema.adminUsers)
        .set({ role: 'ops_admin' })
        .where(eq(schema.adminUsers.id, boss.id));
      try {
        config.CMS_SUPER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;
        await superOnly(() =>
          expect(bootGate()).rejects.toMatchObject({
            name: 'SuperAdminBootGateError',
            code: 'NO_SUPER_ADMIN',
          }),
        );
        expect(
          warnLines.some(
            (l) =>
              l.context === 'AdminAuthService' &&
              String(l.msg).includes('no super_admin row') &&
              String(l.msg).includes('refusing to start'),
          ),
        ).toBe(true);
      } finally {
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
        await db
          .update(schema.adminUsers)
          .set({ role: 'super_admin' })
          .where(eq(schema.adminUsers.id, boss.id));
      }
    });

    it('F-05 r2: with the switch on and the row at another address, the API refuses to start and touches nothing', async () => {
      const boss = await superAdmin();
      const config = bootConfig();
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      const before = await superAdminRow(boss.id);
      try {
        // SSM moved, but the sync that moves the row did not run.
        config.CMS_SUPER_ADMIN_EMAIL = `moved-${Date.now()}@gogo.local`;
        await superOnly(() =>
          expect(bootGate()).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' }),
        );
        expect(await superAdminRow(boss.id)).toMatchObject({
          email: SUPER_ADMIN_EMAIL,
          passwordHash: before.passwordHash,
        });
      } finally {
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
      }
    });

    it('F-05 r2: a confirmation for a previous address does not count at boot — pending starts, hash untouched', async () => {
      const boss = await superAdmin();
      const config = bootConfig();
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      const fresh = `fresh-${Date.now()}@gogo.local`;
      // The sync moved the row to the new SSM address; nobody has confirmed SSO there.
      await db
        .update(schema.adminUsers)
        .set({ email: fresh })
        .where(eq(schema.adminUsers.id, boss.id));
      try {
        config.CMS_SUPER_ADMIN_EMAIL = fresh;
        await superOnly(() => expect(bootGate()).resolves.toBeUndefined());
        expect((await superAdminRow(boss.id)).passwordHash).not.toBeNull();
      } finally {
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
        await db
          .update(schema.adminUsers)
          .set({ email: SUPER_ADMIN_EMAIL })
          .where(eq(schema.adminUsers.id, boss.id));
      }
    });

    it('F-06: the boot-time erase audit carries the deploy revision from GOGO_REVISION', async () => {
      const boss = await superAdmin();
      const config = bootConfig();
      const savedEmail = config.CMS_SUPER_ADMIN_EMAIL;
      const savedRevision = process.env.GOGO_REVISION;
      const revision = `f06${'a'.repeat(37)}`;
      process.env.GOGO_REVISION = revision;
      try {
        await superOnly(async () => {
          await ensureSsoConfirmed(boss.id);
          await db
            .update(schema.adminUsers)
            .set({ passwordHash: 'argon2id$restored-by-old-api', mustChangePasswordAt: null })
            .where(eq(schema.adminUsers.id, boss.id));
          config.CMS_SUPER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;
          await bootGate();
        });
        const stamped = await db
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, 'admin.password_erased'),
              eq(schema.auditLogs.resourceId, boss.id),
              sql`${schema.auditLogs.diff} ->> 'revision' = ${revision}`,
            ),
          );
        expect(stamped).toHaveLength(1);
        expect(stamped[0]).toMatchObject({ actorType: 'system', actorId: null });
      } finally {
        if (savedRevision === undefined) delete process.env.GOGO_REVISION;
        else process.env.GOGO_REVISION = savedRevision;
        config.CMS_SUPER_ADMIN_EMAIL = savedEmail;
        await restoreSuperAdminPassword(boss.id);
      }
    });

    it('with the switch on, reset and change password answer 403 for the super admin', async () => {
      const boss = await superAdmin();
      await superOnly(async () => {
        const token = (await exchange(SUPER_ADMIN_EMAIL)).json().accessToken as string;
        const reset = await api().inject({
          method: 'POST',
          url: `/v1/cms/auth/admins/${boss.id}/reset-password`,
          remoteAddress: ip(),
          headers: auth(token),
          payload: { reason: 'give the super admin a password back' },
        });
        const change = await api().inject({
          method: 'POST',
          url: '/v1/cms/auth/change-password',
          remoteAddress: ip(),
          headers: auth(token),
          payload: { currentPassword: superAdminPassword, newPassword: 'a-brand-new-password-1' },
        });
        expect([reset.statusCode, change.statusCode]).toEqual([403, 403]);
        expect([reset.json().code, change.json().code]).toEqual([
          'SUPER_ADMIN_SSO_ONLY',
          'SUPER_ADMIN_SSO_ONLY',
        ]);
      });
    });

    it('AC-3: a token issued before the sync moved the address is refused on its next request', async () => {
      await superAdmin();
      const token = await adminLogin(SUPER_ADMIN_EMAIL, superAdminPassword);
      const ok = await api().inject({
        method: 'GET',
        url: '/v1/cms/auth/admins',
        headers: auth(token),
      });
      expect(ok.statusCode).toBe(200);

      const moved = await syncSuperAdmin(db, { email: 'moved-boss@gogo.local', ssoOnly: false });
      expect(moved.action).toBe('email_changed');
      try {
        // Before expiry, without any Redis write: the guard reads the database.
        const after = await api().inject({
          method: 'GET',
          url: '/v1/cms/auth/admins',
          headers: auth(token),
        });
        expect(after.statusCode).toBe(401);
        expect(after.json().code).toBe('SESSION_REVOKED');
      } finally {
        await syncSuperAdmin(db, { email: SUPER_ADMIN_EMAIL, ssoOnly: false });
      }
    });
  });

  /*
   * #681 — where the password door is closed the address is the single
   * sign-on binding, so changing it is an audited act that revokes sessions.
   */
  describe('changing a staff account email (#681)', () => {
    const patch = (token: string, id: string, payload: Record<string, unknown>) =>
      api().inject({
        method: 'PATCH',
        url: `/v1/cms/auth/admins/${id}`,
        headers: auth(token),
        payload,
      });
    const live = async (adminId: string) =>
      db
        .select({ id: schema.adminSessions.id })
        .from(schema.adminSessions)
        .where(
          and(
            eq(schema.adminSessions.adminId, adminId),
            sql`${schema.adminSessions.revokedAt} is null`,
          ),
        );

    it('re-binds the identity, audits before and after, and revokes the account’s sessions', async () => {
      const boss = await superAdmin();
      const target = await createAdmin('rebind-old@gogo.local', 'editor');
      expect(await live(target.id)).not.toHaveLength(0);

      const res = await patch(boss.token, target.id, {
        email: 'Rebind-New@GoGo.local',
        reason: 'address moved to the SSO mailbox',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe('rebind-new@gogo.local');
      expect(await live(target.id)).toHaveLength(0);

      const [audit] = await db
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, 'admin.email_changed'),
            eq(schema.auditLogs.resourceId, target.id),
          ),
        );
      expect(audit?.actorId).toBe(boss.id);
      expect(audit?.diff).toEqual({
        reason: 'address moved to the SSO mailbox',
        before: { email: 'rebind-old@gogo.local' },
        after: { email: 'rebind-new@gogo.local' },
      });

      await withDoors(false, async () => {
        expect((await exchange('rebind-new@gogo.local')).statusCode).toBe(201);
        const old = await exchange('rebind-old@gogo.local');
        expect(old.statusCode).toBe(403);
        expect(old.json().code).toBe('ADMIN_ONLY');
      });
    });

    // #687 D-3 (F-09, O-2) replaced #681's self-service move for the super
    // admin: its address comes from SSM and the deploy-time sync applies it.
    it('refuses to move the super admin address, leaving its sessions alone', async () => {
      const boss = await superAdmin();
      const sessionsBefore = await live(boss.id);
      expect(sessionsBefore.length).toBeGreaterThan(0);
      const res = await patch(boss.token, boss.id, {
        email: 'owner-sso@gogo.local',
        reason: 'bootstrap address to the SSO mailbox',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SUPER_ADMIN_EMAIL_FROM_SSM');
      expect(await live(boss.id)).toHaveLength(sessionsBefore.length);
      const [row] = await db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.id, boss.id));
      expect(row!.email).toBe(SUPER_ADMIN_EMAIL);
    });

    it('refuses an address another account uses, in any case', async () => {
      const boss = await superAdmin();
      await createAdmin('taken-a@gogo.local', 'editor');
      const other = await createAdmin('taken-b@gogo.local', 'editor');
      const res = await patch(boss.token, other.id, {
        email: 'TAKEN-A@gogo.local',
        reason: 'collides with another account',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ADMIN_EMAIL_TAKEN');
    });

    it('refuses an email change bundled with a role change', async () => {
      const boss = await superAdmin();
      const other = await createAdmin('bundle@gogo.local', 'editor');
      const res = await patch(boss.token, other.id, {
        email: 'bundle-new@gogo.local',
        role: 'moderator',
        reason: 'two decisions in one request',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('EMAIL_WITH_ROLE');
    });

    it('is super_admin only', async () => {
      const ops = await createAdmin('ops-rebind@gogo.local', 'ops_admin');
      const other = await createAdmin('victim-rebind@gogo.local', 'editor');
      const res = await patch(ops.token, other.id, {
        email: 'attacker@gogo.local',
        reason: 'not allowed to do this',
      });
      expect(res.statusCode).toBe(403);
    });

    /*
     * Review F-08. An exchange that read the old address just before the
     * change must not come out holding a session. The change is held open on
     * a second connection, exactly where the service holds it: row locked,
     * address updated, sessions revoked, not yet committed.
     */
    it('does not let an exchange racing the change keep a session under the old address', async () => {
      const target = await createAdmin('race-exchange@gogo.local', 'editor');
      await withDoors(false, async () => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('select id from admin_users where id = $1 for update', [target.id]);
          await client.query(
            `update admin_users set email = 'race-exchange-new@gogo.local' where id = $1`,
            [target.id],
          );
          await client.query(
            `update admin_sessions set revoked_at = now(), revoke_reason = 'email_changed'
               where admin_id = $1 and revoked_at is null`,
            [target.id],
          );
          const pending = exchange('race-exchange@gogo.local');
          await new Promise((resolve) => setTimeout(resolve, 300));
          await client.query('commit');
          const res = await pending;
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe('ADMIN_ONLY');
        } finally {
          client.release();
        }
      });
      expect(await live(target.id)).toHaveLength(0);
    });

    // Round 1 F-01 (SA): password login re-checks the address under the
    // same lock, so a login that read the old address cannot outlive the change.
    it('does not let a password login racing the change keep a session under the old address', async () => {
      const email = 'race-login@gogo.local';
      const target = await createAdmin(email, 'editor');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select id from admin_users where id = $1 for update', [target.id]);
        await client.query(
          `update admin_users set email = 'race-login-new@gogo.local' where id = $1`,
          [target.id],
        );
        await client.query(
          `update admin_sessions set revoked_at = now(), revoke_reason = 'email_changed'
             where admin_id = $1 and revoked_at is null`,
          [target.id],
        );
        const pending = login(email, ADMIN_PASSWORD);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query('commit');
        const res = await pending;
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('INVALID_CREDENTIALS');
      } finally {
        client.release();
      }
      expect(await live(target.id)).toHaveLength(0);
    });

    // Round 1 F-01 (DEV) / F-02 (SA): simultaneous exchanges for one account
    // must all succeed — a share lock upgraded by the last-login write would
    // deadlock one of them into a 500.
    it('serves simultaneous exchanges for one account without a deadlock', async () => {
      const email = 'parallel-sso@gogo.local';
      await createAdmin(email, 'editor');
      await withDoors(false, async () => {
        const results = await Promise.all(Array.from({ length: 5 }, () => exchange(email)));
        expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
      });
    });

    // Round 1 F-02 (DEV): one refresh token presented twice at once rotates
    // once; the second is reuse and revokes the family — and that revoke
    // persists.
    it('rotates a refresh token presented twice at once only once, and revokes the family', async () => {
      const email = 'parallel-refresh@gogo.local';
      await createAdmin(email, 'editor');
      const before = await sessionIds(email);
      const opened = await login(email, ADMIN_PASSWORD);
      const token = opened.json().refreshToken as string;

      const results = await Promise.all([refresh(token), refresh(token)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 401]);

      const family = await sessionsAfter(email, before);
      expect(family).toHaveLength(2);
      for (const row of family) expect(row.revokedAt).not.toBeNull();
      expect(family.some((row) => row.reason === 'refresh_token_reuse')).toBe(true);
    });

    // Round 1 F-03: two claims on one address that both pass the pre-check —
    // the loser gets the documented 409, not a 500.
    it('answers a concurrent claim on the same address with 409', async () => {
      const boss = await superAdmin();
      const first = await createAdmin('claim-a@gogo.local', 'editor');
      const second = await createAdmin('claim-b@gogo.local', 'editor');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`update admin_users set email = 'claimed@gogo.local' where id = $1`, [
          first.id,
        ]);
        const pending = patch(boss.token, second.id, {
          email: 'claimed@gogo.local',
          reason: 'races another claim',
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query('commit');
        const res = await pending;
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('ADMIN_EMAIL_TAKEN');
      } finally {
        client.release();
      }
    });

    // Round 2 F-05 (Sol) / F-04 (Astra): two *different* superseded tokens of
    // one family replayed together. With a shared admin lock each request held
    // its own session row and both tried to revoke the family — a deadlock
    // and a 500. Now every refresh of the account serialises on the admin row.
    it('refuses two different stale tokens replayed together without a deadlock, and revokes the family', async () => {
      const email = 'stale-pair@gogo.local';
      await createAdmin(email, 'editor');
      const before = await sessionIds(email);
      const t0 = (await login(email, ADMIN_PASSWORD)).json().refreshToken as string;
      const r1 = await refresh(t0);
      expect(r1.statusCode).toBe(201);
      const t1 = r1.json().refreshToken as string;
      const r2 = await refresh(t1);
      expect(r2.statusCode).toBe(201);

      const results = await Promise.all([refresh(t0), refresh(t1)]);
      expect(results.map((r) => r.statusCode)).toEqual([401, 401]);
      expect(results.map((r) => r.json().code)).toEqual(['SESSION_REVOKED', 'SESSION_REVOKED']);

      const family = await sessionsAfter(email, before);
      expect(family).toHaveLength(3);
      for (const row of family) expect(row.revokedAt).not.toBeNull();
    });

    /*
     * Round 2 F-04 (Sol): the denylist is Redis, and it must be written after
     * the transaction commits, never while it holds locks. The spy looks at the
     * rows through a *second* connection at the moment of the call: committed
     * rows are visible there, rows inside an open transaction are not.
     */
    it('writes the denylist only after the revoking transaction has committed', async () => {
      const revocations = app.get(SessionRevocationService);
      const original = revocations.revokeMany.bind(revocations);
      const seen: { ids: string[]; committed: boolean }[] = [];
      const spy = vi.spyOn(revocations, 'revokeMany').mockImplementation(async (ids) => {
        if (ids.length > 0) {
          const { rows } = await pool.query(
            `select count(*)::int as n from admin_sessions where id = any($1::uuid[]) and revoked_at is not null`,
            [ids],
          );
          seen.push({ ids, committed: (rows[0] as { n: number }).n === ids.length });
        }
        return original(ids);
      });
      try {
        // Refresh reuse: the family revoke happens inside the refresh transaction.
        const email = 'denylist-after-commit@gogo.local';
        const target = await createAdmin(email, 'editor');
        const t0 = (await login(email, ADMIN_PASSWORD)).json().refreshToken as string;
        expect((await refresh(t0)).statusCode).toBe(201);
        expect((await refresh(t0)).statusCode).toBe(401);

        // Email change: the account's sessions are revoked inside its transaction.
        const boss = await superAdmin();
        const res = await patch(boss.token, target.id, {
          email: 'denylist-moved@gogo.local',
          reason: 'denylist ordering check',
        });
        expect(res.statusCode).toBe(200);

        expect(seen.length).toBeGreaterThanOrEqual(2);
        for (const call of seen) expect(call.committed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not let a refresh racing the change rotate into a revoked family', async () => {
      const email = 'race-refresh@gogo.local';
      const target = await createAdmin(email, 'editor');
      const opened = await login(email, ADMIN_PASSWORD);

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select id from admin_users where id = $1 for update', [target.id]);
        await client.query(
          `update admin_sessions set revoked_at = now(), revoke_reason = 'email_changed'
             where admin_id = $1 and revoked_at is null`,
          [target.id],
        );
        const pending = refresh(opened.json().refreshToken as string);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query('commit');
        const res = await pending;
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('SESSION_REVOKED');
      } finally {
        client.release();
      }
      expect(await live(target.id)).toHaveLength(0);
    });
  });

  /*
   * The refusal comes before any verification: a malformed assertion still
   * gets CROSS_SITE_REQUEST, and the verifier is never reached. A repeated
   * header arrives joined ("same-origin, cross-site") and is refused too.
   */
  /**
   * #687 shape rev 6 (owner 2026-10-08) — the password door needs no Access
   * assertion and password families refresh; the super admin stays SSO-only.
   * (Replaces the alpha.72 D-4 tests.)
   */
  describe('CMS password door without Access (#687 shape rev 6)', () => {
    const sessionRow = async (id: string) =>
      (
        await db.select().from(schema.adminSessions).where(eq(schema.adminSessions.id, id)).limit(1)
      )[0]!;
    const attempts = async (email: string) =>
      (
        await db
          .select()
          .from(schema.loginAttempts)
          .where(
            eq(
              schema.loginAttempts.identifierHash,
              createHash('sha256').update(`admin:${email}`).digest('hex'),
            ),
          )
      ).length;

    it('rev 6: a staff password login needs no Access assertion, and its family refreshes', async () => {
      const email = 'bed-bare@gogo.local';
      await createAdmin(email, 'editor');
      const before = await sessionIds(email);
      const attemptsBefore = await attempts(email);
      await withDoors(true, async () => {
        const res = await login(email, ADMIN_PASSWORD, null);
        expect(res.statusCode).toBe(201);
        const [opened] = await sessionsAfter(email, before);
        expect(opened).toMatchObject({ method: 'password' });
        const rotated = await refresh(res.json().refreshToken);
        expect(rotated.statusCode).toBe(201);
        expect((await refresh(rotated.json().refreshToken)).statusCode).toBe(201);
      });
      // The attempt was recorded as a real credential check (lockout still applies).
      expect(await attempts(email)).toBe(attemptsBefore + 1);
    });

    it('rev 6: an assertion header on the password door is ignored, foreign or forged', async () => {
      const email = 'bed-header@gogo.local';
      await createAdmin(email, 'editor');
      await withDoors(true, async () => {
        for (const assertion of [assertionFor('someone-else@gogo.local'), 'not.a.jwt']) {
          expect((await login(email, ADMIN_PASSWORD, assertion)).statusCode).toBe(201);
        }
        const wrong = await login(email, 'wrong-password-123', null);
        expect(wrong.statusCode).toBe(401);
        expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
      });
    });

    it('rev 6: works with Access unconfigured too (password door is independent of Access)', async () => {
      const email = 'bed-noaccess@gogo.local';
      await createAdmin(email, 'editor');
      const config = app.get<{ CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string }>(APP_CONFIG);
      const saved = { team: config.CF_ACCESS_TEAM_DOMAIN, aud: config.CF_ACCESS_AUD };
      config.CF_ACCESS_TEAM_DOMAIN = '';
      config.CF_ACCESS_AUD = '';
      try {
        expect((await login(email, ADMIN_PASSWORD, null)).statusCode).toBe(201);
      } finally {
        config.CF_ACCESS_TEAM_DOMAIN = saved.team;
        config.CF_ACCESS_AUD = saved.aud;
      }
    });

    it('rev 6: a password family from before (access_bound = false) keeps refreshing', async () => {
      const email = 'bed-legacy@gogo.local';
      await createAdmin(email, 'editor');
      const before = await sessionIds(email);
      const opened = await login(email, ADMIN_PASSWORD, null);
      const [row] = await sessionsAfter(email, before);
      expect((await sessionRow(row!.id)).accessBound).toBe(false);
      await withDoors(true, async () => {
        expect((await refresh(opened.json().refreshToken)).statusCode).toBe(201);
      });
    });

    it('rev 6: the super admin is still refused on the password door when SSO-only', async () => {
      await superAdmin();
      await withDoors(
        true,
        async () => {
          const res = await login(SUPER_ADMIN_EMAIL, ADMIN_PASSWORD, null);
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe('SUPER_ADMIN_SSO_ONLY');
        },
        true,
      );
    });

    it('binds an exchange family by construction', async () => {
      const email = 'bec-sso@gogo.local';
      await createAdmin(email, 'editor');
      const before = await sessionIds(email);
      await withDoors(true, async () => {
        expect((await exchange(email)).statusCode).toBe(201);
      });
      const [row] = await sessionsAfter(email, before);
      expect((await sessionRow(row!.id)).accessBound).toBe(true);
    });

    it('BE-c2: the TOTP columns are gone from admin_users (migration 0075)', async () => {
      const { rows } = await pool.query(
        `select column_name from information_schema.columns
           where table_name = 'admin_users' and column_name like 'mfa_%'`,
      );
      expect(rows).toEqual([]);
    });

    it('has no TOTP routes and no mfaEnrolled field any more', async () => {
      const admin = await createAdmin('bec-totp@gogo.local', 'editor');
      for (const url of ['/v1/cms/auth/totp/setup', '/v1/cms/auth/totp/confirm']) {
        const res = await api().inject({
          method: 'POST',
          url,
          remoteAddress: ip(),
          headers: auth(admin.token),
          payload: { password: ADMIN_PASSWORD, code: '123456' },
        });
        expect(res.statusCode).toBe(404);
      }
      const boss = await superAdmin();
      const list = await api().inject({
        method: 'GET',
        url: '/v1/cms/auth/admins?limit=100',
        remoteAddress: ip(),
        headers: auth(boss.token),
      });
      expect(list.statusCode).toBe(200);
      for (const item of list.json().items) expect(item).not.toHaveProperty('mfaEnrolled');
    });
  });

  it('refuses an exchange a browser labels cross-origin, before verifying anything', async () => {
    const email = 'cross-site@gogo.local';
    await createAdmin(email, 'editor');
    const verify = vi.spyOn(app.get(CloudflareAccessService), 'verify');

    try {
      await withDoors(false, async () => {
        for (const site of ['cross-site', 'same-site', 'none']) {
          const res = await api().inject({
            method: 'POST',
            url: '/v1/cms/auth/access-exchange',
            remoteAddress: ip(),
            headers: { 'cf-access-jwt-assertion': 'not.a.jwt', 'sec-fetch-site': site },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe('CROSS_SITE_REQUEST');
        }
        const repeated = await api().inject({
          method: 'POST',
          url: '/v1/cms/auth/access-exchange',
          remoteAddress: ip(),
          headers: {
            'cf-access-jwt-assertion': 'not.a.jwt',
            'sec-fetch-site': ['same-origin', 'cross-site'],
          },
        });
        expect(repeated.statusCode).toBe(403);
        expect(repeated.json().code).toBe('CROSS_SITE_REQUEST');
        expect(verify).not.toHaveBeenCalled();

        // A script presenting its own assertion sends no Sec-Fetch-Site.
        const headless = await exchange(email);
        expect(headless.statusCode).toBe(201);
        expect(verify).toHaveBeenCalledTimes(1);
      });
    } finally {
      verify.mockRestore();
    }
  });
});

type ServiceRow = { key: string; status: string; latencyMs?: number; detail?: string };

describe('CMS ops observability (BE-CMS-G8 #247)', () => {
  /*
   * Awaited inside the helper: `inject()` is overloaded, and the un-awaited
   * value types as `void & Promise<Response> & Chain`, which carries neither
   * `statusCode` nor `json`.
   */
  const get = async (token: string, url: string) =>
    await api().inject({ method: 'GET', url, headers: auth(token) });

  /*
   * The whole point of the endpoint. The test environment has no Redis, so
   * redis and worker genuinely cannot be measured — and the contract's answer
   * for that is `unknown`, not a green tick that would make this screen the
   * last place to learn about an outage.
   */
  it('reports unknown where nothing measured, not healthy', async () => {
    const ops = await createAdmin('g8-ops@gogo.id.vn', 'ops_admin');
    const res = await get(ops.token, '/v1/cms/ops/health');
    expect(res.statusCode).toBe(200);

    const services = res.json().services as ServiceRow[];
    // Named lookup rather than an index: a missing row should fail saying
    // which one, not as "possibly undefined" three assertions later.
    const row = (key: string): ServiceRow => {
      const found = services.find((s) => s.key === key);
      if (!found) throw new Error(`no health row for ${key}; got ${services.map((s) => s.key)}`);
      return found;
    };

    // Answering at all is the only claim this row makes, and it is true.
    expect(row('api').status).toBe('healthy');
    expect(row('db').status).toBe('healthy');
    expect(row('db').latencyMs).toBeTypeOf('number');
    expect(row('redis').status).toBe('unknown');
    expect(row('worker').status).toBe('unknown');
    // An unknown that does not say why sends someone hunting.
    expect(row('worker').detail).toBeTruthy();
  });

  /*
   * A provider nobody has called must be absent rather than green. Listing
   * every known provider and defaulting it to healthy is the exact failure
   * `unknown` exists to prevent.
   */
  it('does not invent a row for a provider with no traffic', async () => {
    const ops = await createAdmin('g8-providers@gogo.id.vn', 'ops_admin');
    const keys = (await get(ops.token, '/v1/cms/ops/health'))
      .json()
      .services.map((s: { key: string }) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['api', 'db', 'redis', 'worker']));
    expect(keys).not.toContain('push_provider');
  });

  /*
   * The outbox is a queue that lives in Postgres, so BullMQ cannot see it.
   * Leaving it out would hide the backlog that actually delays notifications.
   */
  it('includes the transactional outbox, which the broker cannot see', async () => {
    const ops = await createAdmin('g8-queues@gogo.id.vn', 'ops_admin');
    const res = await get(ops.token, '/v1/cms/ops/queues');
    expect(res.statusCode).toBe(200);

    const outbox = (
      res.json().queues as { name: string; source: string; failed24hTruncated: boolean }[]
    ).find((q) => q.name === 'outbox_events');
    expect(outbox).toMatchObject({ source: 'database', failed24hTruncated: false });
    expect(outbox).toHaveProperty('oldestPendingSeconds');
  });

  /*
   * Before #335 this returned `providers: []` with `sourcesConfigured: false`
   * — "we do not know" — because no durable source existed. There is one now
   * (`provider_usage_daily`), so a zero here is a *measured* zero: the
   * instrumented operations made no calls this month.
   *
   * The rule that empty list protected is unchanged, and moved rather than
   * disappeared: what nobody measured, and what nobody priced, are named in
   * `gaps` instead of being folded into an amount. Rendering either as `0 đ`
   * would be a different and false claim — the same class of bug as a price
   * with no unit (`core.md` #13).
   */
  it('separates a measured zero from what it cannot price or measure', async () => {
    const ops = await createAdmin('g8-costs@gogo.id.vn', 'ops_admin');
    const res = await get(ops.token, '/v1/cms/ops/costs');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourcesConfigured).toBe(true);
    expect(body.basis).toBe('ESTIMATED');
    expect(body.currency).toBe('USD');
    // No traffic and no charges: a real zero, from a source that survives a
    // deploy.
    expect(body.providers.find((p: { key: string }) => p.key === 'places')).toMatchObject({
      today: 0,
      monthToDate: 0,
      basis: 'estimated',
    });
    // The handset renders the map; this process never sees a map load.
    expect(body.providers.map((p: { key: string }) => p.key)).not.toContain('maps_sdk');
    const gaps: { key: string; kind: string }[] = body.gaps;
    expect(gaps.find((g) => g.key === 'google.maps_sdk_android')?.kind).toBe('not_instrumented');
    // Routes has a verified price since COST-BE-031 (#410); it is no longer a gap.
    expect(gaps.find((g) => g.key === 'google.routeMatrix')).toBeUndefined();
  });

  it('is closed to editors and moderators', async () => {
    const editor = await createAdmin('g8-editor@gogo.id.vn', 'editor');
    for (const url of ['/v1/cms/ops/health', '/v1/cms/ops/queues', '/v1/cms/ops/costs']) {
      expect((await get(editor.token, url)).statusCode).toBe(403);
    }
  });
});

describe('CMS app users, rooms and plans (BE-CMS-G7 #246)', () => {
  const REASON = { reason: 'abuse report OPS-204' };
  const get = async (token: string, url: string) =>
    await api().inject({ method: 'GET', url, headers: auth(token) });
  const post = async (token: string, url: string, payload: Record<string, unknown> = REASON) =>
    await api().inject({ method: 'POST', url, remoteAddress: ip(), headers: auth(token), payload });

  async function createUser(email: string) {
    const [row] = await db
      .insert(schema.users)
      .values({ email, displayName: email.split('@')[0]!, passwordHash: 'x' })
      .returning();
    return row!;
  }

  it('lists accounts with counters, and without location or device data', async () => {
    const ops = await createAdmin('g7-ops@gogo.id.vn', 'ops_admin');
    const user = await createUser('g7-listed@example.com');

    const res = await get(ops.token, `/v1/cms/users?q=g7-listed`);
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(1);

    const item = res.json().items[0];
    expect(item).toMatchObject({
      id: user.id,
      email: 'g7-listed@example.com',
      status: 'active',
      authMethod: 'password',
    });
    expect(item.counters).toEqual({
      roomsCreated: 0,
      roomsJoined: 0,
      reviews: 0,
      savedPlaces: 0,
    });
    // Never signed in — null rather than a timestamp standing in for one.
    expect(item.lastActiveAt).toBeNull();

    /*
     * The subtractive half of the contract. Support work needs to know who
     * someone is and what they did, not where they were; a field that is not
     * returned cannot leak from a console session or a screenshot.
     */
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('analyticsId');
    expect(raw).not.toContain('lat');
    expect(raw).not.toContain('deviceToken');
  });

  /*
   * `AuthGuard` trusts the access token until the session is revoked — it does
   * not re-read the user row. Flipping the status alone would leave a
   * suspended account working for up to the token lifetime.
   */
  it('suspending kills live sessions, not just the status', async () => {
    const ops = await createAdmin('g7-suspender@gogo.id.vn', 'ops_admin');
    const email = 'g7-victim@example.com';
    const register = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'user-password-123', displayName: 'Nạn nhân' },
    });
    expect(register.statusCode).toBe(201);
    const userToken = register.json().accessToken as string;
    const userId = (
      await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    )[0]!.id;

    expect(
      (await api().inject({ method: 'GET', url: '/v1/me', headers: auth(userToken) })).statusCode,
    ).toBe(200);

    const suspended = await post(ops.token, `/v1/cms/users/${userId}/suspend`);
    expect(suspended.statusCode).toBe(201);
    expect(suspended.json().status).toBe('suspended');

    const after = await api().inject({ method: 'GET', url: '/v1/me', headers: auth(userToken) });
    expect(after.statusCode).toBe(401);

    // And the reason is readable back from the audit log, not from a column.
    const detail = await get(ops.token, `/v1/cms/users/${userId}`);
    expect(detail.json().statusReason).toBe(REASON.reason);
    expect(detail.json().statusChangedAt).toBeTypeOf('string');
  });

  it('ban is a separate status from suspend, and both block a login', async () => {
    const ops = await createAdmin('g7-banner@gogo.id.vn', 'ops_admin');
    const email = 'g7-banned@example.com';
    await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'user-password-123', displayName: 'Bị cấm' },
    });
    const userId = (
      await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    )[0]!.id;

    expect((await post(ops.token, `/v1/cms/users/${userId}/ban`)).json().status).toBe('banned');

    const login = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip(),
      payload: { email, password: 'user-password-123' },
    });
    expect(login.statusCode).toBe(401);
  });

  /*
   * A deleted account is anonymized and its address freed for
   * re-registration. Reviving it would attach a stranger's history to whoever
   * now holds that address.
   */
  it('refuses to change the status of a deleted account', async () => {
    const boss = await superAdmin();
    const user = await createUser('g7-gone@example.com');
    expect((await post(boss.token, `/v1/cms/users/${user.id}/delete`)).statusCode).toBe(201);

    const revive = await post(boss.token, `/v1/cms/users/${user.id}/reactivate`);
    expect(revive.statusCode).toBe(409);
    expect(revive.json().code).toBe('USER_DELETED');
  });

  it('deletes through the consumer flow, so nothing is left behind twice', async () => {
    const boss = await superAdmin();
    const user = await createUser('g7-erase@example.com');

    expect((await post(boss.token, `/v1/cms/users/${user.id}/delete`)).statusCode).toBe(201);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row?.status).toBe('deleted');
    // The address is freed: the partial unique index only covers live rows.
    expect(row?.email).toBeNull();
    expect(row?.passwordHash).toBeNull();

    // Attributed to the staff member who ordered it, not to the account.
    const [entry] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, user.id),
          eq(schema.auditLogs.action, 'user.account_deleted'),
        ),
      )
      .limit(1);
    expect(entry?.actorType).toBe('admin');
    expect(entry?.actorId).toBe(boss.id);
  });

  it('erasure is idempotent rather than an error on a second call', async () => {
    const boss = await superAdmin();
    const user = await createUser('g7-twice-user@example.com');
    expect((await post(boss.token, `/v1/cms/users/${user.id}/delete`)).statusCode).toBe(201);
    expect((await post(boss.token, `/v1/cms/users/${user.id}/delete`)).json().deleted).toBe(true);
  });

  /*
   * The bytes are the same as the self-service export; the audit row is what
   * makes a staff member reading somebody's data an attributable event.
   */
  it("exports on the holder's behalf and records who read it", async () => {
    const ops = await createAdmin('g7-exporter@gogo.id.vn', 'ops_admin');
    const user = await createUser('g7-export@example.com');

    // GoGo-BE#256: the operator receives metadata only; the bytes are a secure
    // export the subject redeems. The read is still attributed to the staff
    // member when the worker builds it (privacy-export.int.spec.ts).
    const res = await post(ops.token, `/v1/cms/users/${user.id}/export`);
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain('g7-export@example.com');
    expect(res.json().export).toMatchObject({ status: 'pending', initiatedBy: 'support' });

    const [entry] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, res.json().export.id),
          eq(schema.auditLogs.action, 'privacy_export.requested'),
        ),
      )
      .limit(1);
    expect(entry?.actorType).toBe('admin');
    expect(entry?.actorId).toBe(ops.id);
  });

  /*
   * `rooms.code` is a bearer secret: whoever holds it can join. An operations
   * list is exactly the sort of place a value like that gets copied out of.
   */
  it('never returns a room invite code', async () => {
    const ops = await createAdmin('g7-rooms@gogo.id.vn', 'ops_admin');
    const host = await createUser('g7-host@example.com');
    await db.insert(schema.rooms).values({
      code: 'SECRETCODE1',
      type: 'couple',
      decisionMode: 'match',
      hostUserId: host.id,
    });

    const res = await get(ops.token, '/v1/cms/rooms?limit=100');
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('SECRETCODE1');
    const room = res.json().items.find((r: { hostUserId: string }) => r.hostUserId === host.id);
    expect(room).toMatchObject({ type: 'couple', memberCount: 0, planCount: 0 });
  });

  it('lists plans read-only', async () => {
    const ops = await createAdmin('g7-plans@gogo.id.vn', 'ops_admin');
    const res = await get(ops.token, '/v1/cms/plans');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('totalCount');
  });

  /*
   * Account data is the one collection here where the read is as sensitive as
   * the write, so it stays outside the guard's rank-read.
   */
  it('is closed to editors and moderators, and erasure to super_admin only', async () => {
    const editor = await createAdmin('g7-editor@gogo.id.vn', 'editor');
    expect((await get(editor.token, '/v1/cms/users')).statusCode).toBe(403);
    expect((await get(editor.token, '/v1/cms/rooms')).statusCode).toBe(403);

    const ops = await createAdmin('g7-notboss@gogo.id.vn', 'ops_admin');
    const user = await createUser('g7-protected@example.com');
    expect((await post(ops.token, `/v1/cms/users/${user.id}/delete`)).statusCode).toBe(403);
  });

  it('rejects a mutation with no reason', async () => {
    const ops = await createAdmin('g7-noreason@gogo.id.vn', 'ops_admin');
    const user = await createUser('g7-noreason-user@example.com');
    const res = await post(ops.token, `/v1/cms/users/${user.id}/suspend`, {});
    expect(res.statusCode).toBe(400);
  });
});

describe('CMS guest console (BE-CMS-G11 #254)', () => {
  const REASON = { reason: 'quấy rối trong phòng, ticket OPS-311' };
  const get = async (token: string, url: string) =>
    await api().inject({ method: 'GET', url, headers: auth(token) });
  const post = async (token: string, url: string, payload: Record<string, unknown> = REASON) =>
    await api().inject({ method: 'POST', url, remoteAddress: ip(), headers: auth(token), payload });

  async function roomWithGuest(tag: string) {
    const [host] = await db
      .insert(schema.users)
      .values({
        email: `g11-host-${tag}@example.com`,
        displayName: `Host ${tag}`,
        passwordHash: 'x',
      })
      .returning();
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `G11${tag.toUpperCase()}XYZ`,
        type: 'group',
        status: 'collecting',
        decisionMode: 'vote',
        hostUserId: host!.id,
        participantCount: 4,
      })
      .returning();
    const join = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: room!.code, displayName: `Khách ${tag}` },
    });
    expect(join.statusCode).toBe(201);
    return {
      room: room!,
      guestAccess: join.json().accessToken as string,
      guestToken: join.json().guestToken as string,
    };
  }

  it('lists the guests of one room, without the bearer credential', async () => {
    const ops = await createAdmin('g11-ops@gogo.id.vn', 'ops_admin');
    const { room } = await roomWithGuest('list');

    const res = await get(ops.token, `/v1/cms/rooms/${room.id}/guests`);
    expect(res.statusCode).toBe(200);
    expect(res.json().guests).toHaveLength(1);
    expect(res.json().guests[0]).toMatchObject({ displayName: 'Khách list', claimed: false });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain('token_hash');
  });

  /*
   * The load-bearing test: removal must kill a token already in someone's
   * hands, not just flip columns. And the membership row survives, because
   * votes and reports reference it.
   */
  it('remove revokes the live session and keeps the membership row', async () => {
    const ops = await createAdmin('g11-remover@gogo.id.vn', 'ops_admin');
    const { room, guestAccess, guestToken } = await roomWithGuest('rm');

    // The guest is genuinely inside before the removal.
    const before = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(guestAccess),
    });
    expect(before.statusCode).toBe(200);

    const listed = await get(ops.token, `/v1/cms/rooms/${room.id}/guests`);
    const memberId = listed.json().guests[0].memberId as string;

    const removed = await post(ops.token, `/v1/cms/rooms/${room.id}/guests/${memberId}/remove`);
    expect(removed.statusCode).toBe(201);

    // Access token already issued: dead via the denylist, not at expiry.
    const after = await api().inject({
      method: 'GET',
      url: `/v1/rooms/${room.id}`,
      headers: auth(guestAccess),
    });
    expect(after.statusCode).toBe(401);

    // The opaque guest token can no longer mint new access tokens either.
    const refresh = await api().inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      remoteAddress: ip(),
      payload: { guestToken },
    });
    expect(refresh.statusCode).toBe(401);

    // Row kept, marked removed — history stays referenceable.
    const [member] = await db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.id, memberId));
    expect(member).toBeTruthy();
    expect(member!.removedAt).not.toBeNull();

    const again = await post(ops.token, `/v1/cms/rooms/${room.id}/guests/${memberId}/remove`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_REMOVED');
  });

  /*
   * The decision says this out loud, so a test says it too: removal is not a
   * ban. A still-valid invite readmits the person with a fresh session. If
   * this test starts failing, the product semantics changed — update the
   * console copy and the contract description before "fixing" it.
   */
  it('a removed guest can rejoin with the still-valid invite', async () => {
    const ops = await createAdmin('g11-rejoin@gogo.id.vn', 'ops_admin');
    const { room } = await roomWithGuest('rj');
    const listed = await get(ops.token, `/v1/cms/rooms/${room.id}/guests`);
    const memberId = listed.json().guests[0].memberId as string;
    await post(ops.token, `/v1/cms/rooms/${room.id}/guests/${memberId}/remove`);

    const rejoin = await api().inject({
      method: 'POST',
      url: '/v1/sessions/guest',
      remoteAddress: ip(),
      payload: { roomCode: room.code, displayName: 'Khách rj quay lại' },
    });
    expect(rejoin.statusCode).toBe(201);

    const guests = (await get(ops.token, `/v1/cms/rooms/${room.id}/guests`)).json().guests;
    expect(guests).toHaveLength(2); // the removed row and the new one
  });

  it('refuses to remove a registered member through the guest path', async () => {
    const ops = await createAdmin('g11-notguest@gogo.id.vn', 'ops_admin');
    const { room } = await roomWithGuest('ng');
    // The host is a registered member of nothing yet — add them as a member row.
    const [host] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, room.id));
    const [memberRow] = await db
      .insert(schema.roomMembers)
      .values({ roomId: room.id, userId: host!.hostUserId, role: 'host', displayName: 'Chủ phòng' })
      .returning();

    const res = await post(ops.token, `/v1/cms/rooms/${room.id}/guests/${memberRow!.id}/remove`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_A_GUEST');
  });

  it('is closed to editors', async () => {
    const editor = await createAdmin('g11-editor@gogo.id.vn', 'editor');
    const { room } = await roomWithGuest('ed');
    expect((await get(editor.token, `/v1/cms/rooms/${room.id}/guests`)).statusCode).toBe(403);
  });
});

describe('privacy-request ledger (BE-CMS-G12 #255, ADR-0011)', () => {
  const get = async (token: string, url: string) =>
    await api().inject({ method: 'GET', url, headers: auth(token) });
  const post = async (token: string, url: string, payload: Record<string, unknown> = {}) =>
    await api().inject({ method: 'POST', url, remoteAddress: ip(), headers: auth(token), payload });

  async function registeredUser(email: string) {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email, password: 'user-password-123', displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    return { id: row!.id, token: res.json().accessToken as string };
  }

  /*
   * §2.1 — self-service writes to the ledger, born-completed. A report that
   * omits self-service undercounts most real requests; no PENDING is faked
   * for something that never pended.
   */
  it('self-service export and delete land in the ledger already completed', async () => {
    const ops = await createAdmin('g12-self@gogo.id.vn', 'ops_admin');
    const user = await registeredUser('g12-self-user@example.com');

    expect(
      (await api().inject({ method: 'GET', url: '/v1/me/export', headers: auth(user.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await api().inject({ method: 'DELETE', url: '/v1/me', headers: auth(user.token) }))
        .statusCode,
    ).toBe(200);

    const res = await get(ops.token, `/v1/cms/privacy-requests?userId=${user.id}`);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as {
      type: string;
      source: string;
      status: string;
      outcome: string;
      sla: string;
      retentionAt?: string;
      deliveryMethod?: string;
    }[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({
        source: 'self_service',
        status: 'closed',
        outcome: 'completed',
        sla: 'COMPLETED',
      });
      // Stamped at closure, so the retention job's predicate is a comparison.
      expect(item.retentionAt).toBeTypeOf('string');
    }
    expect(items.find((i) => i.type === 'export')?.deliveryMethod).toBe('in_app');
  });

  it('records a support request with a structured subject and SLA dates', async () => {
    const ops = await createAdmin('g12-support@gogo.id.vn', 'ops_admin');
    const res = await post(ops.token, '/v1/cms/privacy-requests', {
      type: 'delete',
      subjectType: 'email',
      contactEmail: 'someone@example.com',
      ticketReference: 'SUP-4411',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      type: 'delete',
      source: 'support',
      status: 'open',
      subject: { subjectType: 'email', identityStatus: 'unverified' },
      sla: 'ON_TRACK',
    });
    expect(new Date(res.json().ackDueAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(res.json().fulfillmentDueAt).getTime()).toBeGreaterThan(
      new Date(res.json().ackDueAt).getTime(),
    );
  });

  /*
   * §2.3 — a subject is structured or it is nothing. One free-text field
   * becomes a PII dumping ground the first time a conversation is pasted in.
   */
  it('refuses a subject without its identifier, and an over-long operator note', async () => {
    const ops = await createAdmin('g12-shape@gogo.id.vn', 'ops_admin');
    expect(
      (await post(ops.token, '/v1/cms/privacy-requests', { type: 'export', subjectType: 'email' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(ops.token, '/v1/cms/privacy-requests', {
          type: 'export',
          subjectType: 'external',
          externalReference: 'ZD-1',
          operatorNote: 'x'.repeat(257),
        })
      ).statusCode,
    ).toBe(400);
  });

  /*
   * §2.2 — the load-bearing test. Same user is not same request: a direct
   * user delete must not close the ledger row, and executing one request
   * must not close the other.
   */
  it('execute closes exactly the linked request; a direct delete closes none', async () => {
    const boss = await superAdmin();
    const user = await registeredUser('g12-linked@example.com');

    const exportReq = (
      await post(boss.token, '/v1/cms/privacy-requests', {
        type: 'export',
        subjectType: 'user',
        userId: user.id,
      })
    ).json();
    const deleteReq = (
      await post(boss.token, '/v1/cms/privacy-requests', {
        type: 'delete',
        subjectType: 'user',
        userId: user.id,
      })
    ).json();

    // The console can see there is something open before acting directly.
    const detail = await get(boss.token, `/v1/cms/users/${user.id}`);
    expect(detail.json().openPrivacyRequestCount).toBe(2);

    // Execute the export: issues a secure artifact for THIS request only
    // (GoGo-BE#256). It stays in_progress until the artifact is available, and
    // the payload never comes back to the operator.
    const executed = await post(boss.token, `/v1/cms/privacy-requests/${exportReq.id}/execute`);
    expect(executed.statusCode).toBe(202);
    expect(executed.json().request).toMatchObject({ status: 'in_progress' });
    expect(executed.json()).not.toHaveProperty('data');
    expect(executed.body).not.toContain('g12-linked@example.com');

    const stillOpen = await get(boss.token, `/v1/cms/privacy-requests/${deleteReq.id}`);
    expect(stillOpen.json().status).toBe('open');

    // A direct delete outside the workflow: erases the account, touches no
    // ledger row. The operator has to go back and close the request properly.
    expect(
      (
        await post(boss.token, `/v1/cms/users/${user.id}/delete`, {
          reason: 'moderation, unrelated',
        })
      ).statusCode,
    ).toBe(201);
    const afterDirect = await get(boss.token, `/v1/cms/privacy-requests/${deleteReq.id}`);
    expect(afterDirect.json().status).toBe('open');
  });

  it('executing a delete request needs super_admin; a correction cannot be executed', async () => {
    const ops = await createAdmin('g12-ops2@gogo.id.vn', 'ops_admin');
    const user = await registeredUser('g12-role@example.com');
    const deleteReq = (
      await post(ops.token, '/v1/cms/privacy-requests', {
        type: 'delete',
        subjectType: 'user',
        userId: user.id,
      })
    ).json();
    const denied = await post(ops.token, `/v1/cms/privacy-requests/${deleteReq.id}/execute`);
    expect(denied.statusCode).toBe(403);

    const correction = (
      await post(ops.token, '/v1/cms/privacy-requests', {
        type: 'correction',
        subjectType: 'user',
        userId: user.id,
      })
    ).json();
    const notExecutable = await post(
      ops.token,
      `/v1/cms/privacy-requests/${correction.id}/execute`,
    );
    expect(notExecutable.statusCode).toBe(409);
    expect(notExecutable.json().code).toBe('NOT_EXECUTABLE');
  });

  it('closes an unmatched request as no_account_found and counts it', async () => {
    const ops = await createAdmin('g12-noacct@gogo.id.vn', 'ops_admin');
    const req = (
      await post(ops.token, '/v1/cms/privacy-requests', {
        type: 'delete',
        subjectType: 'email',
        contactEmail: 'ghost@example.com',
      })
    ).json();
    const closed = await post(ops.token, `/v1/cms/privacy-requests/${req.id}/close`, {
      outcome: 'no_account_found',
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json()).toMatchObject({ status: 'closed', outcome: 'no_account_found' });

    const [metrics] = await db
      .select()
      .from(schema.privacyMetricsMonthly)
      .where(eq(schema.privacyMetricsMonthly.month, new Date().toISOString().slice(0, 7)));
    expect(metrics!.noAccountFound).toBeGreaterThanOrEqual(1);
    expect(metrics!.deleteReceived).toBeGreaterThanOrEqual(1);
  });

  /*
   * §4/§5 — the retention job hard-deletes past retention_at, skips a held
   * row, and reports an overdue review without releasing or deleting.
   */
  it('retention job purges eligible rows, skips held ones, flags overdue reviews', async () => {
    const boss = await superAdmin();
    const mk = async () =>
      (
        await post(boss.token, '/v1/cms/privacy-requests', {
          type: 'export',
          subjectType: 'external',
          externalReference: `ZD-${Math.random()}`,
        })
      ).json().id as string;
    const purgeMe = await mk();
    const holdMe = await mk();
    for (const id of [purgeMe, holdMe]) {
      await post(boss.token, `/v1/cms/privacy-requests/${id}/close`, { outcome: 'rejected' });
    }
    // Both are past retention; one is held with a review date already lapsed.
    await db
      .update(schema.privacyRequests)
      .set({ retentionAt: sql`now() - interval '1 day'` })
      .where(sql`${schema.privacyRequests.id} in (${purgeMe}::uuid, ${holdMe}::uuid)`);
    const held = await post(boss.token, `/v1/cms/privacy-requests/${holdMe}/retention-hold`, {
      reason: 'litigation hold',
      legalBasis: 'Điều 9 Luật 91/2025/QH15',
      reviewAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(held.statusCode).toBe(201);
    await db
      .update(schema.privacyRequests)
      .set({ reviewAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.privacyRequests.id, holdMe));

    const { PrivacyJobs } = await import('@gogo/modules');
    const report = await new PrivacyJobs(db as never).run(false);
    expect(report.privacyRequestsPurged).toBeGreaterThanOrEqual(1);
    expect(report.privacyHoldReviewsOverdue).toBeGreaterThanOrEqual(1);

    expect((await get(boss.token, `/v1/cms/privacy-requests/${purgeMe}`)).statusCode).toBe(404);
    const survivor = await get(boss.token, `/v1/cms/privacy-requests/${holdMe}`);
    expect(survivor.statusCode).toBe(200);
    expect(survivor.json().retentionHold.reviewOverdue).toBe(true);
  });

  it('a hold needs a future review date, and release keeps the retention date', async () => {
    const boss = await superAdmin();
    const id = (
      await post(boss.token, '/v1/cms/privacy-requests', {
        type: 'export',
        subjectType: 'external',
        externalReference: 'ZD-hold',
      })
    ).json().id as string;
    await post(boss.token, `/v1/cms/privacy-requests/${id}/close`, { outcome: 'rejected' });
    const before = (await get(boss.token, `/v1/cms/privacy-requests/${id}`)).json().retentionAt;

    const past = await post(boss.token, `/v1/cms/privacy-requests/${id}/retention-hold`, {
      reason: 'x',
      legalBasis: 'y',
      reviewAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.statusCode).toBe(400);

    await post(boss.token, `/v1/cms/privacy-requests/${id}/retention-hold`, {
      reason: 'audit',
      legalBasis: 'basis',
      reviewAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const released = await post(
      boss.token,
      `/v1/cms/privacy-requests/${id}/retention-hold/release`,
      {
        reason: 'basis no longer applies',
      },
    );
    expect(released.statusCode).toBe(201);
    expect(released.json().retentionHold).toBeUndefined();
    // Never shortened: quietly shortening retention is destroying evidence.
    expect(released.json().retentionAt).toBe(before);
  });

  it('is closed to editors and moderators', async () => {
    const editor = await createAdmin('g12-editor@gogo.id.vn', 'editor');
    expect((await get(editor.token, '/v1/cms/privacy-requests')).statusCode).toBe(403);
  });
});

describe('place workflow + search sync (CMS-002, SRS §15.5)', () => {
  it('draft → review → published appears in search; suspended disappears', async () => {
    const editor = await createAdmin('editor2@gogo.local', 'editor');
    // ADM-009 (#462): publishing a place now requires a reviewer-verified
    // administrative mapping that is still valid against the active dataset.
    // A minimal published dataset and a verified mapping are the preconditions
    // for approval, so this flow test carries them.
    const { datasetVersion } = await seedAdministrativeMapping();
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'CMS Flow Quán',
        nameNormalized: 'x',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
        rating: '4.50',
        ratingCount: 100,
        confidence: '0.9',
        freshnessCheckedAt: new Date(),
        provinceCode: '79',
        communeCode: '26734',
        administrativeMappingStatus: 'VERIFIED',
        administrativeMappingSource: 'editor',
        administrativeDatasetVersion: datasetVersion,
      })
      .returning();

    const skip = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}/status`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { status: 'published' },
    });
    expect(skip.statusCode).toBe(409); // draft cannot jump straight to published

    for (const status of ['review', 'published']) {
      const res = await api().inject({
        method: 'PATCH',
        url: `/v1/cms/places/${place!.id}/status`,
        remoteAddress: ip(),
        headers: auth(editor.token),
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
    }

    const found = await api().inject({ method: 'GET', url: '/v1/places/search?q=CMS%20Flow' });
    expect(found.json().results.map((r: { name: string }) => r.name)).toContain('CMS Flow Quán');

    await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}/status`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { status: 'suspended' },
    });
    const gone = await api().inject({ method: 'GET', url: '/v1/places/search?q=CMS%20Flow' });
    expect(gone.json().results.map((r: { name: string }) => r.name)).not.toContain('CMS Flow Quán');

    // Audit trail records who changed what (SRS §15.8).
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.resourceId, place!.id),
          eq(schema.auditLogs.action, 'place.status_changed'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits[0]!.actorId).toBe(editor.id);
  });

  it('hours/prices/freshness tooling works (CMS-003)', async () => {
    const editor = await createAdmin('editor3@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Hours Place',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    const hours = await api().inject({
      method: 'PUT',
      url: `/v1/cms/places/${place!.id}/hours`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        hours: [{ dayOfWeek: 1, openMinute: 480, closeMinute: 1320, isOvernight: false }],
      },
    });
    expect(hours.statusCode).toBe(200);
    const price = await api().inject({
      method: 'POST',
      url: `/v1/cms/places/${place!.id}/prices`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { priceMin: 50_000, priceMax: 120_000, unit: 'per_person' },
    });
    expect(price.statusCode).toBe(201);
    const stale = await api().inject({
      method: 'GET',
      url: '/v1/cms/places/stale?days=30',
      headers: auth(editor.token),
    });
    expect(stale.statusCode).toBe(200);
  });
});

describe('ranking console (CMS-008, FR-CMS-007)', () => {
  it('bounds validation, four-eyes approval, activate + rollback', async () => {
    const ops1 = await createAdmin('ops1@gogo.local', 'ops_admin');
    const ops2 = await createAdmin('ops2@gogo.local', 'ops_admin');

    const outOfBounds = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs',
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: { key: 'suggestion.scoring', weights: { preference: 0.9 } },
    });
    expect(outOfBounds.statusCode).toBe(400);
    expect(outOfBounds.json().code).toBe('WEIGHT_OUT_OF_BOUNDS');

    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs',
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: { key: 'suggestion.scoring', weights: { preference: 0.4, quality: 0.2 } },
    });
    expect(created.statusCode).toBe(201);
    const configId = created.json().id;

    const selfApprove = await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/approve`,
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: {},
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().code).toBe('SELF_APPROVAL');

    const approve = await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/approve`,
      remoteAddress: ip(),
      headers: auth(ops2.token),
      payload: {},
    });
    expect(approve.statusCode).toBe(201);

    const activate = await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/activate`,
      remoteAddress: ip(),
      headers: auth(ops2.token),
      payload: {},
    });
    expect(activate.statusCode).toBe(201);
    const [active] = await db
      .select()
      .from(schema.rankingConfigs)
      .where(eq(schema.rankingConfigs.status, 'active'));
    expect(active!.id).toBe(configId);

    const rollback = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs/suggestion.scoring/rollback',
      remoteAddress: ip(),
      headers: auth(ops1.token),
      payload: {},
    });
    expect(rollback.json().rolledBack).toBe(true);
  });
});

describe('moderation queue (CMS-007, FR-CMS-005)', () => {
  it('pending review decided with mandatory reason + audit', async () => {
    const moderator = await createAdmin('mod1@gogo.local', 'moderator');
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: { email: 'reviewer@gogo.id.vn', password: 'sufficiently-long-pw', displayName: 'R' },
    });
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Review Target',
        nameNormalized: 'x',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
      payload: { placeId: place!.id, rating: 4, text: 'ổn' },
    });

    const queue = await api().inject({
      method: 'GET',
      url: '/v1/cms/moderation',
      headers: auth(moderator.token),
    });
    expect(queue.json().reviews.map((r: { id: string }) => r.id)).toContain(review.json().id);

    const noReason = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${review.json().id}`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'published', reason: '' },
    });
    expect(noReason.statusCode).toBe(400); // reason is mandatory

    const decided = await api().inject({
      method: 'POST',
      url: `/v1/cms/moderation/reviews/${review.json().id}`,
      remoteAddress: ip(),
      headers: auth(moderator.token),
      payload: { decision: 'published', reason: 'nội dung phù hợp' },
    });
    expect(decided.statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, review.json().id));
    expect(row!.status).toBe('published');
    expect(row!.moderationReason).toBe('nội dung phù hợp');
  });
});

/**
 * BE-CMS-G1 (#219) — the queue reads the console binds to: server-side
 * filters, keyset paging and a total that is the size of the backlog rather
 * than the size of the page.
 */
describe('moderation queues: filter, count, cursor paging (BE-CMS-G1 #219)', () => {
  let moderatorToken: string;
  let editorToken: string;
  let placeId: string;
  let otherPlaceId: string;
  let authorId: string;
  let reviewIds: string[] = [];
  let reportedReviewId: string;

  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 10, 12, 0, 0) + minutes * 60_000);

  beforeAll(async () => {
    moderatorToken = (await createAdmin('modq@gogo.local', 'moderator')).token;
    editorToken = (await createAdmin('modq-editor@gogo.local', 'editor')).token;

    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Quán Cà Phê Hàng Đợi',
        nameNormalized: 'quan ca phe hang doi',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    placeId = place!.id;
    const [other] = await db
      .insert(schema.places)
      .values({
        name: 'Elsewhere',
        nameNormalized: 'elsewhere',
        status: 'published',
        geom: { x: 106.71, y: 10.78 },
      })
      .returning();
    otherPlaceId = other!.id;

    const [author] = await db
      .insert(schema.users)
      .values({ email: 'queue-author@gogo.id.vn', displayName: 'Người Đánh Giá' })
      .returning();
    authorId = author!.id;

    // Five pending reviews one minute apart, so the keyset order is known.
    const rows = await db
      .insert(schema.reviews)
      .values(
        [1, 2, 3, 4, 5].map((n) => ({
          userId: authorId,
          placeId,
          rating: ((n % 5) + 1) as number,
          text: `đánh giá ${n}`,
          createdAt: at(n),
          updatedAt: at(n),
        })),
      )
      .returning();
    reviewIds = rows.map((r) => r.id);

    // One of them is reported, and one already published — neither should show
    // up in the default pending queue by accident.
    reportedReviewId = reviewIds[0]!;
    await db.insert(schema.reports).values({
      reporterUserId: authorId,
      targetType: 'review',
      targetId: reportedReviewId,
      reasonCode: 'spam',
      note: 'trùng lặp',
      createdAt: at(10),
    });
  });

  const q = (url: string, token = moderatorToken) =>
    api().inject({ method: 'GET', url, headers: auth(token) });

  /*
   * The whole reason this endpoint exists. The queue list defaults to
   * `pending`; a link shared to a review someone already decided must still
   * open, or the console has to claim it is "not in the current filter" about
   * a row that plainly exists.
   */
  it('reads one review by id, whatever its status', async () => {
    const listed = await q(`/v1/cms/moderation/reviews?placeId=${placeId}`);
    const target = listed.json().items[0];
    expect(target).toBeTruthy();

    const byId = await q(`/v1/cms/moderation/reviews/${target.id}`);
    expect(byId.statusCode).toBe(200);
    // Same projection as the list, field for field — one definition, so a
    // field cannot appear on one and quietly go missing from the other.
    expect(byId.json()).toEqual(target);

    await db
      .update(schema.reviews)
      .set({ status: 'rejected', moderationReason: 'spam' })
      .where(eq(schema.reviews.id, target.id));

    const decided = await q(`/v1/cms/moderation/reviews/${target.id}`);
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'rejected', moderationReason: 'spam' });

    // The pending queue no longer lists it; the link still resolves.
    const stillListed = await q(`/v1/cms/moderation/reviews?placeId=${placeId}`);
    expect(stillListed.json().items.map((r: { id: string }) => r.id)).not.toContain(target.id);

    await db
      .update(schema.reviews)
      .set({ status: 'pending', moderationReason: null })
      .where(eq(schema.reviews.id, target.id));
  });

  it('404s an id that does not exist', async () => {
    const res = await q('/v1/cms/moderation/reviews/00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('REVIEW_NOT_FOUND');
  });

  it('counts the backlog, not the page', async () => {
    const res = await q('/v1/cms/moderation/counts');
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const [{ n }] = (
      await db.execute(sql`select count(*)::int as n from reviews where status = 'pending'`)
    ).rows as [{ n: number }];
    expect(body.reviews).toBe(n);
    expect(body.reviews).toBeGreaterThanOrEqual(5);
    expect(body.total).toBe(body.reviews + body.reports + body.checkins + body.communityPlaces);
  });

  it('filters reviews server-side by place, author and rating', async () => {
    const byPlace = await q(`/v1/cms/moderation/reviews?placeId=${placeId}`);
    expect(byPlace.statusCode).toBe(200);
    expect(byPlace.json().items).toHaveLength(5);
    expect(byPlace.json().totalCount).toBe(5);

    const elsewhere = await q(`/v1/cms/moderation/reviews?placeId=${otherPlaceId}`);
    expect(elsewhere.json().items).toEqual([]);
    expect(elsewhere.json().totalCount).toBe(0);
    expect(elsewhere.json().nextCursor).toBeNull();

    const byRating = await q(`/v1/cms/moderation/reviews?placeId=${placeId}&rating=1`);
    expect(byRating.json().items.every((r: { rating: number }) => r.rating === 1)).toBe(true);

    const byAuthor = await q(`/v1/cms/moderation/reviews?userId=${authorId}&placeId=${placeId}`);
    expect(byAuthor.json().totalCount).toBe(5);
  });

  it('reports the author by display name and never by email', async () => {
    const res = await q(`/v1/cms/moderation/reviews?placeId=${placeId}`);
    const item = res.json().items[0];
    expect(item.authorDisplayName).toBe('Người Đánh Giá');
    expect(item.authorUserId).toBe(authorId);
    expect(JSON.stringify(res.json())).not.toContain('queue-author@gogo.id.vn');
  });

  it('`reported` filters on undecided reports, both ways', async () => {
    const reported = await q(`/v1/cms/moderation/reviews?placeId=${placeId}&reported=true`);
    expect(reported.json().items.map((r: { id: string }) => r.id)).toEqual([reportedReviewId]);
    expect(reported.json().items[0].openReportCount).toBe(1);

    const clean = await q(`/v1/cms/moderation/reviews?placeId=${placeId}&reported=false`);
    expect(clean.json().totalCount).toBe(4);
    expect(clean.json().items.map((r: { id: string }) => r.id)).not.toContain(reportedReviewId);
  });

  it('date range is half-open, so consecutive filters tile', async () => {
    const first = at(1).toISOString();
    const third = at(3).toISOString();
    const res = await q(
      `/v1/cms/moderation/reviews?placeId=${placeId}&dateFrom=${first}&dateTo=${third}`,
    );
    // Rows at minute 1 and 2; minute 3 belongs to the next window.
    expect(res.json().totalCount).toBe(2);
  });

  it('pages by keyset, newest first, without repeating or skipping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url =
        `/v1/cms/moderation/reviews?placeId=${placeId}&limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await q(url);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The total is the filtered set on every page, not what is left.
      expect(body.totalCount).toBe(5);
      seen.push(...body.items.map((r: { id: string }) => r.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // Newest first: the reviews were written a minute apart, ascending.
    expect(seen).toEqual([...reviewIds].reverse());
  });

  it('a row written mid-traversal cannot push a row onto a second page', async () => {
    const firstPage = await q(`/v1/cms/moderation/reviews?placeId=${placeId}&limit=2`);
    const cursor = firstPage.json().nextCursor as string;

    // Newer than everything already returned — an offset pager would now show
    // one of page 1's rows again on page 2.
    await db.insert(schema.reviews).values({
      userId: authorId,
      placeId,
      rating: 3,
      text: 'chen ngang',
      createdAt: at(99),
      updatedAt: at(99),
    });

    const secondPage = await q(
      `/v1/cms/moderation/reviews?placeId=${placeId}&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    const firstIds = firstPage.json().items.map((r: { id: string }) => r.id);
    const secondIds = secondPage.json().items.map((r: { id: string }) => r.id);
    expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
  });

  it('rejects a malformed cursor and an out-of-range filter', async () => {
    const badCursor = await q(`/v1/cms/moderation/reviews?cursor=not-a-cursor`);
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json().code).toBe('INVALID_CURSOR');

    expect((await q('/v1/cms/moderation/reviews?rating=9')).statusCode).toBe(400);
    expect((await q('/v1/cms/moderation/reviews?status=nonsense')).statusCode).toBe(400);
    expect((await q('/v1/cms/moderation/reviews?limit=500')).statusCode).toBe(400);
    expect((await q('/v1/cms/moderation/reviews?dateFrom=yesterday')).statusCode).toBe(400);
  });

  it('reports queue filters by target and reason, and hides the guest session id', async () => {
    const res = await q(
      `/v1/cms/moderation/reports?targetType=review&targetId=${reportedReviewId}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCount).toBe(1);
    const item = res.json().items[0];
    expect(item.reasonCode).toBe('spam');
    expect(item.reporterKind).toBe('user');
    expect(item).not.toHaveProperty('reporterGuestSessionId');

    const byReason = await q('/v1/cms/moderation/reports?reasonCode=does-not-exist');
    expect(byReason.json().totalCount).toBe(0);
  });

  it('community-place queue searches accent-insensitively', async () => {
    await db.insert(schema.places).values({
      name: 'Quán Ốc Cộng Đồng',
      nameNormalized: 'quan oc cong dong',
      status: 'community_submitted',
      areaKey: 'q1',
      geom: { x: 106.7, y: 10.77 },
    });
    const res = await q('/v1/cms/moderation/community-places?q=cong dong');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((p: { name: string }) => p.name)).toContain('Quán Ốc Cộng Đồng');

    const byArea = await q('/v1/cms/moderation/community-places?areaKey=q1');
    expect(byArea.json().totalCount).toBeGreaterThanOrEqual(1);
  });

  it('check-in queue filters on the verified bill and joins its place', async () => {
    const [host] = await db
      .insert(schema.users)
      .values({ email: 'queue-host@gogo.id.vn', displayName: 'Host' })
      .returning();
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: 'QUEUE01',
        type: 'couple',
        decisionMode: 'match',
        hostUserId: host!.id,
      })
      .returning();
    const [member] = await db
      .insert(schema.roomMembers)
      .values({ roomId: room!.id, userId: host!.id, role: 'host', displayName: 'Host' })
      .returning();
    const [plan] = await db
      .insert(schema.plans)
      .values({
        roomId: room!.id,
        version: 1,
        constraintVersion: 1,
        totals: {
          costMin: 0,
          costMax: 0,
          currency: 'VND',
          durationMinutes: 60,
          travelDistanceM: 0,
          overBudget: false,
          uncertain: false,
        },
      })
      .returning();
    const [stop] = await db
      .insert(schema.planStops)
      .values({ planId: plan!.id, placeId, position: 0, durationMinutes: 60 })
      .returning();
    await db.insert(schema.stopCheckins).values({
      planStopId: stop!.id,
      memberId: member!.id,
      rating: 5,
      note: 'ngon',
      billTotal: 250_000,
      billPhotoKey: 'u/user/bill.jpg',
      createdAt: at(20),
      updatedAt: at(20),
    });

    const withBill = await q(`/v1/cms/moderation/checkins?placeId=${placeId}&hasBill=true`);
    expect(withBill.statusCode).toBe(200);
    expect(withBill.json().totalCount).toBe(1);
    const item = withBill.json().items[0];
    expect(item.hasBill).toBe(true);
    expect(item.placeName).toBe('Quán Cà Phê Hàng Đợi');
    expect(item.photoCount).toBe(0);

    const withoutBill = await q(`/v1/cms/moderation/checkins?placeId=${placeId}&hasBill=false`);
    expect(withoutBill.json().totalCount).toBe(0);
  });

  it('an editor may read the queues; a consumer token may not', async () => {
    expect((await q('/v1/cms/moderation/counts', editorToken)).statusCode).toBe(200);
    expect((await q('/v1/cms/moderation/reviews?limit=1', editorToken)).statusCode).toBe(200);

    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'queue-outsider@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'O',
      },
    });
    const denied = await api().inject({
      method: 'GET',
      url: '/v1/cms/moderation/reviews',
      headers: auth(reg.json().accessToken),
    });
    expect(denied.statusCode).toBe(403);
  });
});

/**
 * BE-CMS-G2 (#220) — the read beside `POST /cms/auth/admins`. Without it the
 * console could create a staff account and never show it again.
 */
describe('CMS account list (BE-CMS-G2 #220)', () => {
  let superToken: string;
  let opsToken: string;
  let editorToken: string;
  const prefix = 'acctlist';

  beforeAll(async () => {
    superToken = (await superAdmin()).token;
    opsToken = (await createAdmin(`${prefix}-ops@gogo.local`, 'ops_admin')).token;
    editorToken = (await createAdmin(`${prefix}-editor@gogo.local`, 'editor')).token;

    const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
    await db.insert(schema.adminUsers).values([
      {
        email: `${prefix}-a@gogo.local`,
        passwordHash,
        displayName: 'Nguyễn A',
        role: 'moderator',
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      },
      {
        email: `${prefix}-b@gogo.local`,
        passwordHash,
        displayName: 'Trần B',
        role: 'moderator',
        status: 'suspended',
        createdAt: new Date(Date.UTC(2026, 0, 2)),
      },
      {
        email: `${prefix}-c@gogo.local`,
        // SSO account: no password at all, and it must still list.
        ssoSubject: 'okta|c',
        displayName: 'Lê C',
        role: 'editor',
        createdAt: new Date(Date.UTC(2026, 0, 3)),
      },
    ]);
  });

  const list = (qs: string, token = superToken) =>
    api().inject({ method: 'GET', url: `/v1/cms/auth/admins${qs}`, headers: auth(token) });

  it('lists accounts with what account administration needs, and nothing else', async () => {
    const res = await list(`?q=${prefix}-`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Five accounts carry this prefix. The `super_admin` reading them is the
    // environment's one shared account (ADR-0018) and is not one of them.
    expect(body.totalCount).toBe(5);

    const c = body.items.find((a: { email: string }) => a.email === `${prefix}-c@gogo.local`);
    expect(c).toMatchObject({ displayName: 'Lê C', role: 'editor', status: 'active' });
    expect(c.createdAt).toBeTypeOf('string');
    // Never signed in: absent rather than a null pretending to be a timestamp.
    expect(c.lastLoginAt).toBeUndefined();

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('ssoSubject');
    expect(raw).not.toContain('okta|c');
    /*
     * #687 D-4 removed `mfaEnrolled` with TOTP, and BE-c2 dropped the secret
     * columns. None of their names may come back in a response.
     */
    expect(raw).not.toContain('mfaTotpSecret');
    expect(raw).not.toContain('mfa_totp_secret');
    expect(raw).not.toContain('mfaTotpPending');
    expect(raw).not.toContain('mfa_totp_pending');
    expect(c).not.toHaveProperty('mfaEnrolled');
  });

  it('reports a locked account as locked, so the console can show it', async () => {
    const res = await list(`?q=${prefix}-&status=suspended`);
    expect(res.json().items.map((a: { email: string }) => a.email)).toEqual([
      `${prefix}-b@gogo.local`,
    ]);
    expect(res.json().items[0].status).toBe('suspended');
  });

  it('filters by role and by a substring of email or display name', async () => {
    const moderators = await list(`?q=${prefix}-&role=moderator`);
    expect(moderators.json().totalCount).toBe(2);

    const byName = await list('?q=Trần');
    expect(byName.json().items.map((a: { displayName: string }) => a.displayName)).toEqual([
      'Trần B',
    ]);

    const byEmail = await list(`?q=${prefix}-C@GOGO`);
    expect(byEmail.json().totalCount).toBe(1);
  });

  it('records the last login, which is what tells a stale account from a new one', async () => {
    const res = await list(`?q=${SUPER_ADMIN_EMAIL}`);
    expect(res.json().items[0].lastLoginAt).toBeTypeOf('string');
  });

  it('pages by cursor, newest first, without repeating an account', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const res = await list(
        `?q=${prefix}-&limit=2` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().totalCount).toBe(5);
      seen.push(...res.json().items.map((a: { id: string }) => a.id));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed cursor and a role that is not in the model', async () => {
    expect((await list('?cursor=nope')).statusCode).toBe(400);
    expect((await list('?role=owner')).statusCode).toBe(400);
    expect((await list('?status=disabled')).statusCode).toBe(400);
    expect((await list('?limit=1000')).statusCode).toBe(400);
  });

  it('is super_admin only — rank-read does not open it to ops_admin', async () => {
    expect((await list('', opsToken)).statusCode).toBe(403);
    expect((await list('', editorToken)).statusCode).toBe(403);

    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'acctlist-outsider@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'O',
      },
    });
    const denied = await api().inject({
      method: 'GET',
      url: '/v1/cms/auth/admins',
      headers: auth(reg.json().accessToken),
    });
    expect(denied.statusCode).toBe(403);
  });
});

/**
 * BE-CMS-G5 (#227) — the console's upload door. `/v1/uploads` binds its key to
 * the calling consumer, so an admin had no way to produce one and a banner,
 * where the image is mandatory, had nothing to bind to.
 */
describe('CMS media upload (BE-CMS-G5 #227)', () => {
  let editor: { id: string; token: string };
  let moderator: { id: string; token: string };

  beforeAll(async () => {
    editor = await createAdmin('upload227@gogo.local', 'editor');
    moderator = await createAdmin('upload227-mod@gogo.local', 'moderator');
  });

  const upload = (payload: unknown, token = editor.token) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/uploads',
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });

  it('authorizes a presigned PUT bound to the admin, with a server-made key', async () => {
    const res = await upload({
      purpose: 'banner_image',
      contentType: 'image/jpeg',
      contentLength: 250_000,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.uploadUrl).toMatch(/^https?:\/\//);
    expect(body.contentType).toBe('image/jpeg');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // ADR-0005: a banner is catalogue media, so the key carries the public
    // prefix that decides which bucket it lands in. Actor plus a UUID plus the
    // extension of the declared type — nothing the client sent reaches the
    // key, so it cannot be steered at another object.
    expect(body.key).toMatch(new RegExp(`^banners/${editor.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(body.key).not.toContain('..');

    const [row] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.id, body.id));
    expect(row!.actorType).toBe('admin');
    expect(row!.actorId).toBe(editor.id);
    expect(row!.purpose).toBe('banner_image');
    expect(row!.status).toBe('pending');
  });

  /*
   * ADR-0005 — the prefix is what decides the bucket, so it is the contract.
   *
   * Catalogue uploads were presigned against the *private* bucket while the
   * read URL was composed against the public host, so every place photo,
   * banner and campaign image resolved and returned 404. The prefix is what
   * routes the PUT, and it is also what `publicCatalogueUrl` reads to decide
   * whether a stored key is on the public host at all.
   */
  it('gives each catalogue purpose the public prefix that routes its bucket', async () => {
    for (const [purpose, prefix] of [
      ['place_image', 'places'],
      ['banner_image', 'banners'],
      ['campaign_image', 'campaigns'],
    ] as const) {
      const res = await upload({ purpose, contentType: 'image/png', contentLength: 1000 });
      expect(res.statusCode, purpose).toBe(201);
      expect(res.json().key as string, purpose).toMatch(new RegExp(`^${prefix}/`));
      // Where media hosting is configured, the read URL is that public host
      // plus this key — the pair that used to disagree. Where it is not, the
      // honest answer is null rather than a URL that would 404.
      const readUrl = res.json().readUrl as string | null;
      if (readUrl !== null) expect(readUrl, purpose).toContain(res.json().key);
    }
  });

  it('never hands back a storage credential, only a URL that expires', async () => {
    const body = (
      await upload({ purpose: 'banner_image', contentType: 'image/png', contentLength: 1000 })
    ).json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secretAccessKey');
    expect(raw).not.toContain('accessKeyId');
    expect(raw).not.toContain('R2_');
    // Time-boxed rather than a bucket handle. The signature itself is the R2
    // adapter's job and is covered in `r2-storage.adapter.spec.ts`; this suite
    // runs against the fake storage adapter, which produces no SigV4 query.
    const ttlSeconds = (new Date(body.expiresAt).getTime() - Date.now()) / 1000;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(ttlSeconds).toBeLessThanOrEqual(900);
  });

  it('refuses a content type outside the allowlist', async () => {
    for (const contentType of ['image/svg+xml', 'application/pdf', 'text/html', 'image/gif']) {
      const res = await upload({ purpose: 'banner_image', contentType, contentLength: 1000 });
      expect(res.statusCode, contentType).toBe(400);
      expect(res.json().code).toBe('UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('refuses an oversized file before a URL exists', async () => {
    const res = await upload({
      purpose: 'banner_image',
      contentType: 'image/jpeg',
      contentLength: 50 * 1024 * 1024,
    });
    expect(res.statusCode).toBe(400);
    const before = await db.$count(schema.mediaUploads);
    expect(before).toBeGreaterThan(0); // rows exist, but not one for this call
  });

  it('refuses a purpose that belongs to the consumer app', async () => {
    for (const purpose of ['checkin_photo', 'bill_photo', 'place_photo', 'anything']) {
      const res = await upload({ purpose, contentType: 'image/jpeg', contentLength: 1000 });
      expect(res.statusCode, purpose).toBe(400);
    }
  });

  it('records who uploaded what, since the bytes never cross the API', async () => {
    const body = (
      await upload({ purpose: 'campaign_image', contentType: 'image/webp', contentLength: 4321 })
    ).json();

    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?action=cms_upload.authorized&resourceId=${body.id}`,
      headers: auth(editor.token),
    });
    expect(audit.statusCode).toBe(200);
    const entry = audit.json().items[0];
    expect(entry.actorId).toBe(editor.id);
    expect(entry.diff).toMatchObject({
      purpose: 'campaign_image',
      contentType: 'image/webp',
      contentLength: 4321,
      storageKey: body.key,
    });
  });

  it('is an editorial write: a moderator cannot authorize one, nor can a consumer', async () => {
    const asModerator = await upload(
      { purpose: 'banner_image', contentType: 'image/jpeg', contentLength: 1000 },
      moderator.token,
    );
    expect(asModerator.statusCode).toBe(403);

    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'upload227-outsider@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'O',
      },
    });
    const asConsumer = await upload(
      { purpose: 'banner_image', contentType: 'image/jpeg', contentLength: 1000 },
      reg.json().accessToken,
    );
    expect(asConsumer.statusCode).toBe(403);
  });

  it('a consumer cannot claim an admin key, and an admin key is not a check-in photo', async () => {
    const body = (
      await upload({ purpose: 'banner_image', contentType: 'image/jpeg', contentLength: 1000 })
    ).json();
    // The key is bound to the admin row that produced it; the consumer attach
    // path matches on actor and purpose, so neither half of that lines up.
    const [row] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, body.key));
    expect(row!.actorType).toBe('admin');
    expect(row!.attachedToId).toBeNull();
  });
});

/**
 * BE-CMS-G4a (#222) — recommendations as targeted collections (ADR-0009).
 */
describe('recommendations (BE-CMS-G4a #222)', () => {
  let editor: { id: string; token: string };
  let moderator: { id: string; token: string };
  let placeA: string;
  let placeB: string;
  let placeC: string;
  let categoryId: string;
  let moodId: string;
  let dietaryId: string;

  const suffix = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    editor = await createAdmin('rec222@gogo.local', 'editor');
    moderator = await createAdmin('rec222-mod@gogo.local', 'moderator');

    const places = await db
      .insert(schema.places)
      .values(
        ['Rec Place A', 'Rec Place B', 'Rec Place C'].map((name) => ({
          name,
          nameNormalized: name.toLowerCase(),
          status: 'published' as const,
          geom: { x: 106.7, y: 10.77 },
        })),
      )
      .returning();
    [placeA, placeB, placeC] = places.map((p) => p.id) as [string, string, string];

    const taxonomies = await db
      .insert(schema.taxonomies)
      .values([
        { kind: 'category', key: `rec_cat_${suffix()}` },
        { kind: 'mood', key: `rec_mood_${suffix()}` },
        { kind: 'dietary', key: `rec_diet_${suffix()}` },
      ])
      .returning();
    [categoryId, moodId, dietaryId] = taxonomies.map((t) => t.id) as [string, string, string];
  });

  const post = (payload: unknown, token = editor.token) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/recommendations',
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const patch = (path: string, payload: unknown, token = editor.token) =>
    api().inject({
      method: 'PATCH',
      url: `/v1/cms/recommendations/${path}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const get = (path = '', token = editor.token) =>
    api().inject({ method: 'GET', url: `/v1/cms/recommendations${path}`, headers: auth(token) });

  const valid = (extra: Record<string, unknown> = {}) => ({
    slug: `rec-${suffix()}`,
    internalName: 'Tết 2027 — đợt 1',
    title: 'Hẹn hò cuối tuần',
    subtitle: 'Gần bạn',
    audience: 'couple',
    areaKey: 'q1',
    priority: 10,
    placeIds: [placeA, placeB],
    taxonomyIds: [categoryId, moodId],
    ...extra,
  });

  it('creates one and reads back the places in the order they were sent', async () => {
    const created = await post(valid({ placeIds: [placeC, placeA, placeB] }));
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.status).toBe('draft');
    expect(body.audience).toBe('couple');
    expect(body.priority).toBe(10);
    expect(body.places.map((p: { placeId: string }) => p.placeId)).toEqual([
      placeC,
      placeA,
      placeB,
    ]);
    expect(body.places.map((p: { position: number }) => p.position)).toEqual([0, 1, 2]);

    // And the order survives a re-read, not just the response of the write.
    const read = await get(`/${body.id}`);
    expect(read.json().places.map((p: { placeId: string }) => p.placeId)).toEqual([
      placeC,
      placeA,
      placeB,
    ]);
  });

  it('carries taxonomy as stable keys, not display labels', async () => {
    const body = (await post(valid())).json();
    const kinds = body.taxonomies.map((t: { kind: string }) => t.kind).sort();
    expect(kinds).toEqual(['category', 'mood']);
    for (const taxonomy of body.taxonomies) {
      expect(taxonomy.key).toMatch(/^rec_(cat|mood)_/);
      expect(taxonomy).not.toHaveProperty('label');
    }
  });

  it('refuses a place or taxonomy that does not resolve', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const noPlace = await post(valid({ placeIds: [ghost] }));
    expect(noPlace.statusCode).toBe(400);
    expect(noPlace.json().code).toBe('PLACE_NOT_FOUND');

    const noTaxonomy = await post(valid({ taxonomyIds: [ghost] }));
    expect(noTaxonomy.statusCode).toBe(400);
    expect(noTaxonomy.json().code).toBe('TAXONOMY_NOT_FOUND');

    // A dietary key is a fact about a place, not something content targets.
    const wrongKind = await post(valid({ taxonomyIds: [dietaryId] }));
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().code).toBe('TAXONOMY_KIND_INVALID');

    const duplicate = await post(valid({ placeIds: [placeA, placeA] }));
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().code).toBe('DUPLICATE_PLACE');
  });

  it('refuses a window that ends before it starts, and a key already used', async () => {
    const backwards = await post(
      valid({ startsAt: '2027-02-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' }),
    );
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().code).toBe('INVALID_SCHEDULE');

    const slug = `rec-dup-${suffix()}`;
    expect((await post(valid({ slug }))).statusCode).toBe(201);
    const again = await post(valid({ slug }));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('SLUG_TAKEN');
  });

  it('moves along declared transitions and refuses the rest', async () => {
    const id = (await post(valid())).json().id;

    const scheduleWithoutStart = await patch(`${id}/status`, { status: 'scheduled' });
    expect(scheduleWithoutStart.statusCode).toBe(400);
    expect(scheduleWithoutStart.json().code).toBe('SCHEDULE_REQUIRED');

    await patch(id, { startsAt: '2027-01-01T00:00:00Z' });
    expect((await patch(`${id}/status`, { status: 'scheduled' })).statusCode).toBe(200);
    expect((await patch(`${id}/status`, { status: 'published' })).statusCode).toBe(200);

    // Archived is terminal: retired content comes back as a new row.
    expect((await patch(`${id}/status`, { status: 'archived' })).statusCode).toBe(200);
    const revive = await patch(`${id}/status`, { status: 'published' });
    expect(revive.statusCode).toBe(409);
    expect(revive.json().code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('will not publish an empty recommendation', async () => {
    const id = (await post(valid({ placeIds: [] }))).json().id;
    const res = await patch(`${id}/status`, { status: 'published' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('EMPTY_RECOMMENDATION');
  });

  it('replaces the ordered list wholesale and audits the change', async () => {
    const id = (await post(valid())).json().id;
    const res = await api().inject({
      method: 'PUT',
      url: `/v1/cms/recommendations/${id}/places`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { placeIds: [placeB, placeC] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().places.map((p: { placeId: string }) => p.placeId)).toEqual([placeB, placeC]);
    expect(res.json().placeCount).toBe(2);

    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=recommendation&resourceId=${id}&action=recommendation.places_set`,
      headers: auth(editor.token),
    });
    expect(audit.json().items[0].diff).toMatchObject({ count: 2 });
  });

  it('filters and pages, and the total counts the filtered set', async () => {
    const areaKey = `zone-${suffix()}`;
    for (let i = 0; i < 3; i += 1) {
      await post(valid({ areaKey, audience: 'group' }));
    }

    const filtered = await get(`?areaKey=${areaKey}&audience=group`);
    expect(filtered.json().totalCount).toBe(3);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const res = await get(
        `?areaKey=${areaKey}&limit=2` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      );
      expect(res.json().totalCount).toBe(3);
      seen.push(...res.json().items.map((r: { id: string }) => r.id));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(3);

    const byAudience = await get(`?areaKey=${areaKey}&audience=couple`);
    expect(byAudience.json().totalCount).toBe(0);
  });

  it('stays out of the collections screen, and collections stay out of this one', async () => {
    const recommendation = (await post(valid())).json();

    const collections = await api().inject({
      method: 'GET',
      url: '/v1/cms/collections',
      headers: auth(editor.token),
    });
    expect(collections.statusCode).toBe(200);
    expect(collections.json().map((c: { id: string }) => c.id)).not.toContain(recommendation.id);

    // A collection id is a 404 here: two resources in the contract, one table.
    const [collection] = await db
      .insert(schema.contentCollections)
      .values({
        slug: `plain-${suffix()}`,
        title: 'Bộ sưu tập thường',
        createdByAdminId: editor.id,
      })
      .returning();
    expect((await get(`/${collection!.id}`)).statusCode).toBe(404);

    // And the collections status route will not touch a recommendation.
    const cross = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/collections/${recommendation.id}/status`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { status: 'published' },
    });
    expect(cross.statusCode).toBe(404);
  });

  it('is an editorial write: a moderator cannot create one', async () => {
    expect((await post(valid(), moderator.token)).statusCode).toBe(403);
    // Reads climb by rank, so a moderator can still see what is scheduled.
    expect((await get('', moderator.token)).statusCode).toBe(200);
  });
});

/**
 * BE-CMS-G4b (#223) — plan templates: source material for future plans, never
 * live ones.
 */
describe('plan templates (BE-CMS-G4b #223)', () => {
  let editor: { id: string; token: string };
  let moderator: { id: string; token: string };
  let placeId: string;
  let categoryId: string;
  let moodId: string;
  let dietaryId: string;

  const suffix = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    editor = await createAdmin('tpl223@gogo.local', 'editor');
    moderator = await createAdmin('tpl223-mod@gogo.local', 'moderator');

    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Template Place',
        nameNormalized: 'template place',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    placeId = place!.id;

    const taxonomies = await db
      .insert(schema.taxonomies)
      .values([
        { kind: 'category', key: `tpl_cat_${suffix()}` },
        { kind: 'mood', key: `tpl_mood_${suffix()}` },
        { kind: 'dietary', key: `tpl_diet_${suffix()}` },
      ])
      .returning();
    [categoryId, moodId, dietaryId] = taxonomies.map((t) => t.id) as [string, string, string];
  });

  const post = (payload: unknown, token = editor.token) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/plan-templates',
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const patch = (path: string, payload: unknown, token = editor.token) =>
    api().inject({
      method: 'PATCH',
      url: `/v1/cms/plan-templates/${path}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const get = (path = '', token = editor.token) =>
    api().inject({ method: 'GET', url: `/v1/cms/plan-templates${path}`, headers: auth(token) });

  const stop = (extra: Record<string, unknown> = {}) => ({
    categoryTaxonomyId: categoryId,
    expectedDurationMinutes: 90,
    budget: { min: 150_000, max: 300_000, currency: 'VND', scope: 'per_person' },
    ...extra,
  });
  const valid = (extra: Record<string, unknown> = {}) => ({
    slug: `tpl-${suffix()}`,
    internalName: 'Hẹn hò tối — mẫu 1',
    title: 'Tối lãng mạn',
    audience: 'couple',
    areaKey: 'q1',
    expectedDurationMinutes: 240,
    budget: { min: 500_000, max: 900_000, currency: 'VND', scope: 'per_group' },
    taxonomyIds: [moodId],
    stops: [stop({ preferredPlaceId: placeId }), stop({ isOptional: true })],
    ...extra,
  });

  it('keeps every amount in minor units with its currency and its scope', async () => {
    const created = await post(valid());
    expect(created.statusCode).toBe(201);
    const body = created.json();

    expect(body.budget).toEqual({
      min: 500_000,
      max: 900_000,
      currency: 'VND',
      scope: 'per_group',
    });
    // Integers, not floats: 500000 is 500.000 ₫ and never 500000.0.
    expect(Number.isInteger(body.budget.min)).toBe(true);
    expect(Number.isInteger(body.budget.max)).toBe(true);
    // The template is per_group; its stops are per_person. Two different
    // numbers, and each says which it is.
    expect(body.stops[0].budget.scope).toBe('per_person');

    const read = await get(`/${body.id}`);
    expect(read.json().budget).toEqual(body.budget);
    expect(read.json().stops[0].budget).toEqual(body.stops[0].budget);
  });

  it('refuses an amount that cannot say what it is per, or an inverted range', async () => {
    const noScope = await post(valid({ budget: { min: 1000, max: 2000, currency: 'VND' } }));
    expect(noScope.statusCode).toBe(400);

    const noCurrency = await post(valid({ budget: { min: 1000, max: 2000, scope: 'per_person' } }));
    expect(noCurrency.statusCode).toBe(400);

    const badCurrency = await post(
      valid({ budget: { min: 1000, max: 2000, currency: 'dong', scope: 'per_person' } }),
    );
    expect(badCurrency.statusCode).toBe(400);

    const float = await post(
      valid({ budget: { min: 1000.5, max: 2000, currency: 'VND', scope: 'per_person' } }),
    );
    expect(float.statusCode).toBe(400);

    const inverted = await post(
      valid({
        stops: [
          stop({ budget: { min: 900_000, max: 100_000, currency: 'VND', scope: 'per_person' } }),
        ],
      }),
    );
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().code).toBe('INVALID_BUDGET');
  });

  it('keeps stops in order, with `optional` carried on the stop itself', async () => {
    const body = (await post(valid())).json();
    expect(body.stops.map((s: { position: number }) => s.position)).toEqual([0, 1]);
    expect(body.stops[0].isOptional).toBe(false);
    expect(body.stops[1].isOptional).toBe(true);
    expect(body.stops[0].preferredPlaceId).toBe(placeId);
    expect(body.stops[0].preferredPlaceName).toBe('Template Place');
    // A stop without a preferred place is a shape the template supports, not
    // an error: matching fills it in later.
    expect(body.stops[1].preferredPlaceId).toBeUndefined();

    const reordered = await api().inject({
      method: 'PUT',
      url: `/v1/cms/plan-templates/${body.id}/stops`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { stops: [stop({ note: 'thứ hai' }), stop({ preferredPlaceId: placeId })] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().stops.map((s: { note?: string }) => s.note)).toEqual([
      'thứ hai',
      undefined,
    ]);
    expect(reordered.json().stops.map((s: { position: number }) => s.position)).toEqual([0, 1]);
  });

  it('validates referenced places and taxonomy kinds', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const noPlace = await post(valid({ stops: [stop({ preferredPlaceId: ghost })] }));
    expect(noPlace.statusCode).toBe(400);
    expect(noPlace.json().code).toBe('PLACE_NOT_FOUND');

    // A stop is categorised, so a mood key is the wrong kind there …
    const wrongStopKind = await post(valid({ stops: [stop({ categoryTaxonomyId: moodId })] }));
    expect(wrongStopKind.statusCode).toBe(400);
    expect(wrongStopKind.json().code).toBe('TAXONOMY_KIND_INVALID');

    // … and a dietary key is not a mood.
    const wrongTemplateKind = await post(valid({ taxonomyIds: [dietaryId] }));
    expect(wrongTemplateKind.statusCode).toBe(400);
    expect(wrongTemplateKind.json().code).toBe('TAXONOMY_KIND_INVALID');
  });

  it('moves along declared transitions and will not publish an empty template', async () => {
    const empty = (await post(valid({ stops: [] }))).json();
    const publishEmpty = await patch(`${empty.id}/status`, { status: 'published' });
    expect(publishEmpty.statusCode).toBe(400);
    expect(publishEmpty.json().code).toBe('EMPTY_TEMPLATE');

    const id = (await post(valid())).json().id;
    expect((await patch(`${id}/status`, { status: 'published' })).statusCode).toBe(200);
    expect((await patch(`${id}/status`, { status: 'archived' })).statusCode).toBe(200);
    const revive = await patch(`${id}/status`, { status: 'published' });
    expect(revive.statusCode).toBe(409);
    expect(revive.json().code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('editing a template does not touch a plan that already exists', async () => {
    const id = (await post(valid())).json().id;

    const [host] = await db
      .insert(schema.users)
      .values({ email: `tpl-host-${suffix()}@gogo.id.vn`, displayName: 'Host' })
      .returning();
    const [room] = await db
      .insert(schema.rooms)
      .values({
        code: `TPL${suffix().toUpperCase()}`,
        type: 'couple',
        decisionMode: 'match',
        hostUserId: host!.id,
      })
      .returning();
    const [plan] = await db
      .insert(schema.plans)
      .values({
        roomId: room!.id,
        version: 1,
        constraintVersion: 1,
        totals: {
          costMin: 100,
          costMax: 200,
          currency: 'VND',
          durationMinutes: 90,
          travelDistanceM: 0,
          overBudget: false,
          uncertain: false,
        },
      })
      .returning();
    const [stopRow] = await db
      .insert(schema.planStops)
      .values({ planId: plan!.id, placeId, position: 0, durationMinutes: 90 })
      .returning();

    await patch(id, {
      title: 'Đổi tên',
      stops: [stop({ expectedDurationMinutes: 30 })],
    });

    const [planAfter] = await db.select().from(schema.plans).where(eq(schema.plans.id, plan!.id));
    const [stopAfter] = await db
      .select()
      .from(schema.planStops)
      .where(eq(schema.planStops.id, stopRow!.id));
    expect(planAfter!.updatedAt.getTime()).toBe(plan!.updatedAt.getTime());
    expect(stopAfter!.durationMinutes).toBe(90);
  });

  it('filters, pages and refuses a duplicate template key', async () => {
    const areaKey = `tplzone-${suffix()}`;
    for (let i = 0; i < 3; i += 1) await post(valid({ areaKey }));

    const filtered = await get(`?areaKey=${areaKey}&audience=couple`);
    expect(filtered.json().totalCount).toBe(3);

    const firstPage = await get(`?areaKey=${areaKey}&limit=2`);
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().totalCount).toBe(3);
    const second = await get(
      `?areaKey=${areaKey}&limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
    );
    expect(second.json().items).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();

    const slug = `tpl-dup-${suffix()}`;
    expect((await post(valid({ slug }))).statusCode).toBe(201);
    const again = await post(valid({ slug }));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('SLUG_TAKEN');
  });

  it('is an editorial write: a moderator cannot create one', async () => {
    expect((await post(valid(), moderator.token)).statusCode).toBe(403);
    expect((await get('', moderator.token)).statusCode).toBe(200);
  });
});

/**
 * BE-CMS-G4d (#225) — Trust & Safety rule definitions. Closed conditions, no
 * rule builder, no expression language.
 */
describe('trust & safety rules (BE-CMS-G4d #225)', () => {
  let ops: { id: string; token: string };
  let moderator: { id: string; token: string };
  const suffix = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    ops = await createAdmin('ts225@gogo.local', 'ops_admin');
    moderator = await createAdmin('ts225-mod@gogo.local', 'moderator');
  });

  const post = (payload: unknown, token = ops.token) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/safety-rules',
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const patch = (path: string, payload: unknown, token = ops.token) =>
    api().inject({
      method: 'PATCH',
      url: `/v1/cms/safety-rules/${path}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const get = (path = '', token = ops.token) =>
    api().inject({ method: 'GET', url: `/v1/cms/safety-rules${path}`, headers: auth(token) });

  const blockedWords = (extra: Record<string, unknown> = {}) => ({
    name: `Chặn từ khoá ${suffix()}`,
    ruleType: 'blocked_words',
    trigger: 'review_created',
    conditions: { terms: ['spam', 'lừa đảo'] },
    action: 'auto_hide',
    severity: 'medium',
    reasonCode: 'blocked_word_match',
    ...extra,
  });

  it('stores a rule with its conditions normalized and its defaults filled in', async () => {
    const res = await post(blockedWords());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('draft');
    expect(body.priority).toBe(100);
    expect(body.conditions).toEqual({
      terms: ['spam', 'lừa đảo'],
      matchMode: 'substring',
      caseSensitive: false,
    });
    expect(body.reasonCode).toBe('blocked_word_match');
    expect(body.createdBy.id).toBe(ops.id);
  });

  it('refuses conditions that do not fit the rule type, and anything expression-shaped', async () => {
    const wrongShape = await post(blockedWords({ conditions: { minReports: 3 } }));
    expect(wrongShape.statusCode).toBe(400);
    expect(wrongShape.json().code).toBe('INVALID_RULE_CONDITIONS');

    // The whole point of the closed schema: no DSL reaches the database.
    for (const conditions of [
      { terms: ['x'], expression: 'user.reports > 3' },
      { terms: ['x'], script: 'return true' },
      { terms: ['x'], query: 'select 1' },
    ]) {
      const res = await post(blockedWords({ conditions }));
      expect(res.statusCode, JSON.stringify(conditions)).toBe(400);
      expect(res.json().code).toBe('INVALID_RULE_CONDITIONS');
      expect(res.json().field_errors[0].field).toMatch(/^conditions/);
    }

    const emptyTerms = await post(blockedWords({ conditions: { terms: [] } }));
    expect(emptyTerms.statusCode).toBe(400);
  });

  it('refuses an action or trigger the rule type cannot support', async () => {
    const badAction = await post(blockedWords({ action: 'suspend_user', severity: 'critical' }));
    expect(badAction.statusCode).toBe(400);
    expect(badAction.json().code).toBe('ACTION_NOT_ALLOWED');

    const badTrigger = await post(blockedWords({ trigger: 'user_registered' }));
    expect(badTrigger.statusCode).toBe(400);
    expect(badTrigger.json().code).toBe('TRIGGER_NOT_ALLOWED');
  });

  it('will not let a low-severity rule suspend accounts on its own', async () => {
    const low = await post({
      name: `Lạm dụng ${suffix()}`,
      ruleType: 'user_abuse',
      trigger: 'report_created',
      conditions: { maxReportsAgainstUser: 5 },
      action: 'suspend_user',
      severity: 'low',
      reasonCode: 'user_abuse_threshold',
    });
    expect(low.statusCode).toBe(400);
    expect(low.json().code).toBe('SEVERITY_TOO_LOW');

    const high = await post({
      name: `Lạm dụng ${suffix()}`,
      ruleType: 'user_abuse',
      trigger: 'report_created',
      conditions: { maxReportsAgainstUser: 5, upheldOnly: true },
      action: 'suspend_user',
      severity: 'high',
      reasonCode: 'user_abuse_threshold',
    });
    expect(high.statusCode).toBe(201);
    expect(high.json().action).toBe('suspend_user');
  });

  it('requires a machine-readable reason code for whatever it does to someone', async () => {
    expect((await post(blockedWords({ reasonCode: 'Không hợp lệ' }))).statusCode).toBe(400);
    expect((await post(blockedWords({ reasonCode: 'AB' }))).statusCode).toBe(400);
    expect((await post(blockedWords({ reasonCode: 'ok_code_1' }))).statusCode).toBe(201);
  });

  it('revalidates the whole rule on edit, since one field can invalidate another', async () => {
    const id = (await post(blockedWords())).json().id;

    // blocked_words cannot suspend, whatever the severity.
    const escalate = await patch(id, { action: 'suspend_user', severity: 'critical' });
    expect(escalate.statusCode).toBe(400);
    expect(escalate.json().code).toBe('ACTION_NOT_ALLOWED');

    const ok = await patch(id, { action: 'flag_for_review', priority: 5 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().action).toBe('flag_for_review');
    expect(ok.json().priority).toBe(5);
  });

  it('audits creation, edit and activation with the reason code attached', async () => {
    const rule = (await post(blockedWords())).json();
    await patch(`${rule.id}/status`, { status: 'active' });
    await patch(`${rule.id}/status`, { status: 'disabled' });

    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=safety_rule&resourceId=${rule.id}&limit=10`,
      headers: auth(ops.token),
    });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json().items.map((e: { action: string }) => e.action);
    expect(actions).toContain('safety_rule.created');
    expect(actions).toContain('safety_rule.status_changed');

    const created = audit
      .json()
      .items.find((e: { action: string }) => e.action === 'safety_rule.created');
    expect(created.diff.reasonCode).toBe('blocked_word_match');
    expect(created.diff.conditions.terms).toContain('spam');

    const activation = audit
      .json()
      .items.filter((e: { action: string }) => e.action === 'safety_rule.status_changed');
    // Both directions are recorded: disabling a rule is as consequential as
    // enabling one.
    expect(activation.map((e: { diff: { after: string } }) => e.diff.after).sort()).toEqual([
      'active',
      'disabled',
    ]);
  });

  it('filters and pages the list', async () => {
    const reasonCode = `probe_${suffix()}`;
    for (let i = 0; i < 3; i += 1) await post(blockedWords({ reasonCode }));

    const byReason = await get(`?q=${reasonCode}`);
    expect(byReason.json().totalCount).toBe(3);

    const firstPage = await get(`?q=${reasonCode}&limit=2`);
    expect(firstPage.json().items).toHaveLength(2);
    const secondPage = await get(
      `?q=${reasonCode}&limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
    );
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().nextCursor).toBeNull();

    expect((await get('?ruleType=rate_limit&status=active')).json().totalCount).toBe(0);
  });

  it('refuses a duplicate rule name', async () => {
    const name = `Quy tắc ${suffix()}`;
    expect((await post(blockedWords({ name }))).statusCode).toBe(201);
    const again = await post(blockedWords({ name }));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('RULE_NAME_TAKEN');
  });

  it('is ops-only in both directions — reads do not climb (BE-IMP-008)', async () => {
    expect((await post(blockedWords(), moderator.token)).statusCode).toBe(403);
    expect((await get('', moderator.token)).statusCode).toBe(403);
  });
});

/**
 * BE-CMS-G4e (#226) — campaigns. The API composes; the worker sends.
 */
describe('notification campaigns (BE-CMS-G4e #226)', () => {
  let ops: { id: string; token: string };
  let editor: { id: string; token: string };
  let placeId: string;
  let recipients: string[] = [];
  const suffix = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    ops = await createAdmin('camp226@gogo.local', 'ops_admin');
    editor = await createAdmin('camp226-editor@gogo.local', 'editor');

    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Campaign Place',
        nameNormalized: 'campaign place',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    placeId = place!.id;

    // Two reachable accounts (a confirmed push subscription each) and one with
    // none at all. #515: reachability is a live `push_subscriptions` row, not a
    // device token — the table the audience used to read had no writer.
    //
    const users = await db
      .insert(schema.users)
      .values([
        { email: `camp-a-${suffix()}@gogo.id.vn`, displayName: 'A' },
        { email: `camp-b-${suffix()}@gogo.id.vn`, displayName: 'B' },
        { email: `camp-c-${suffix()}@gogo.id.vn`, displayName: 'C' },
      ])
      .returning();
    recipients = users.map((u) => u.id);
    await db.insert(schema.pushSubscriptions).values([
      { userId: recipients[0]!, platform: 'ios', subscriptionId: `sub-ios-${suffix()}` },
      { userId: recipients[1]!, platform: 'android', subscriptionId: `sub-android-${suffix()}` },
    ]);
  });

  const post = (path: string, payload: unknown = {}, token = ops.token) =>
    api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns${path}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const get = (path = '', token = ops.token) =>
    api().inject({ method: 'GET', url: `/v1/cms/campaigns${path}`, headers: auth(token) });

  const draft = (extra: Record<string, unknown> = {}) => ({
    name: `Chiến dịch ${suffix()}`,
    title: 'Cuối tuần đi đâu?',
    body: 'Gợi ý mới cho hai bạn',
    audienceType: 'all',
    destinationType: 'home',
    ...extra,
  });

  it('creates a draft and sends nothing', async () => {
    const res = await post('', draft());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('draft');
    expect(body.sentCount).toBe(0);
    expect(body.scheduledAt).toBeUndefined();

    // Nothing queued, nothing delivered: composing is not sending.
    const notifications = await db.$count(schema.notifications);
    expect(typeof notifications).toBe('number');
    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, body.id));
    expect(row!.startedAt).toBeNull();
    expect(row!.dispatchKey).toBeNull();
  });

  /*
   * BE-CMS-M2 — a campaign image is an upload like any other.
   *
   * `imageKey` used to be stored as whatever string arrived: never checked
   * against the actor who uploaded it, never against the purpose it was
   * issued for, never claimed. A campaign could carry a `place_image` key, or
   * one that had never been uploaded at all, and the upload row stayed
   * `pending` forever.
   */
  describe('the image key is an upload, not a string', () => {
    const patchCampaign = (id: string, payload: unknown, token = ops.token) =>
      api().inject({
        method: 'PATCH',
        url: `/v1/cms/campaigns/${id}`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: payload as object,
      });

    async function campaignKey(token = ops.token, purpose = 'campaign_image') {
      const res = await api().inject({
        method: 'POST',
        url: '/v1/cms/uploads',
        remoteAddress: ip(),
        headers: auth(token),
        payload: { purpose, contentType: 'image/jpeg', contentLength: 90_000 },
      });
      expect(res.statusCode).toBe(201);
      return markUploaded(res.json().key as string);
    }

    it('binds a valid key to the campaign it was saved on', async () => {
      const imageKey = await campaignKey();
      const res = await post('', draft({ imageKey }));
      expect(res.statusCode).toBe(201);

      const [media] = await db
        .select()
        .from(schema.mediaUploads)
        .where(eq(schema.mediaUploads.storageKey, imageKey));
      expect(media!.status).toBe('attached');
      expect(media!.attachedToType).toBe('campaign');
      expect(media!.attachedToId).toBe(res.json().id);
    });

    it('refuses a key that was never uploaded, and leaves no campaign behind', async () => {
      const name = `Chiến dịch mồ côi ${suffix()}`;
      const res = await post('', draft({ name, imageKey: 'u/admin/never/uploaded.jpg' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_UPLOAD_KEY');

      const rows = await db
        .select()
        .from(schema.notificationCampaigns)
        .where(eq(schema.notificationCampaigns.name, name));
      expect(rows).toHaveLength(0);
    });

    it('refuses a key issued for another purpose', async () => {
      const bannerKey = await campaignKey(ops.token, 'banner_image');
      const res = await post('', draft({ imageKey: bannerKey }));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
    });

    it('releases the image claim when the write fails after it', async () => {
      const taken = await post('', draft({ imageKey: await campaignKey() }));
      expect(taken.statusCode).toBe(201);

      const campaign = await post('', draft({ imageKey: await campaignKey() }));
      expect(campaign.statusCode).toBe(201);

      // Good key, and a name the write will refuse: the claim must roll back
      // with the update rather than burning a key the operator can still use.
      const replacement = await campaignKey();
      const refused = await patchCampaign(campaign.json().id, {
        imageKey: replacement,
        name: taken.json().name,
      });
      expect(refused.statusCode).toBe(409);

      const [claim] = await db
        .select()
        .from(schema.mediaUploads)
        .where(eq(schema.mediaUploads.storageKey, replacement));
      expect(claim!.status).toBe('pending');
      expect(claim!.attachedToId).toBeNull();
    });

    it('refuses an expired key', async () => {
      const stale = await campaignKey();
      await db
        .update(schema.mediaUploads)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.mediaUploads.storageKey, stale));

      const res = await post('', draft({ imageKey: stale }));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
    });

    it('refuses a key belonging to another actor', async () => {
      const foreign = await campaignKey(editor.token);
      const res = await post('', draft({ imageKey: foreign }));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
    });

    it('leaves a text-only campaign alone', async () => {
      const res = await post('', draft());
      expect(res.statusCode).toBe(201);
      expect(res.json().imageKey).toBeUndefined();

      // And it stays text-only through an unrelated edit.
      const edited = await patchCampaign(res.json().id, { title: 'Đổi tiêu đề' });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().imageKey).toBeUndefined();
    });

    it('keeps the saved image when a replacement is refused', async () => {
      const imageKey = await campaignKey();
      const created = await post('', draft({ imageKey }));
      expect(created.statusCode).toBe(201);

      const refused = await patchCampaign(created.json().id, {
        imageKey: 'u/admin/never/uploaded.jpg',
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe('INVALID_UPLOAD_KEY');

      const after = await get(`/${created.json().id}`);
      expect(after.json().imageKey).toBe(imageKey);
    });
  });

  it('validates the destination against real data, and refuses an unsafe URL', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const missing = await post('', draft({ destinationType: 'place', destinationValue: ghost }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('DESTINATION_NOT_FOUND');

    const real = await post('', draft({ destinationType: 'place', destinationValue: placeId }));
    expect(real.statusCode).toBe(201);

    // home carries nothing; a value alongside it is a contradiction.
    const contradiction = await post(
      '',
      draft({ destinationType: 'home', destinationValue: placeId }),
    );
    expect(contradiction.statusCode).toBe(400);

    for (const url of [
      'http://gogo.id.vn/promo',
      'https://127.0.0.1/admin',
      'https://localhost:8080',
      'https://user:pw@gogo.id.vn',
      'https://10.0.0.5/internal',
      'javascript:alert(1)',
    ]) {
      const res = await post('', draft({ destinationType: 'external_url', destinationValue: url }));
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe('INVALID_DESTINATION');
    }
    // A safe URL is well formed, but the app cannot open it from a push yet
    // (GoGo-BE#604): 422, not 201.
    expect(
      (
        await post(
          '',
          draft({ destinationType: 'external_url', destinationValue: 'https://gogo.id.vn/tet' }),
        )
      ).statusCode,
    ).toBe(422);
  });

  it('refuses an audience the backend cannot compute', async () => {
    // `city`, `app_version` and `custom_segment` are in the mockup and not in
    // the contract: nothing stores either fact.
    for (const audienceType of ['city', 'app_version', 'custom_segment']) {
      expect((await post('', draft({ audienceType }))).statusCode, audienceType).toBe(400);
    }
    const badFilter = await post(
      '',
      draft({ audienceType: 'platform', audienceFilter: { os: 'ios' } }),
    );
    expect(badFilter.statusCode).toBe(400);
    expect(badFilter.json().code).toBe('INVALID_AUDIENCE');

    const good = await post(
      '',
      draft({ audienceType: 'platform', audienceFilter: { platform: 'ios' } }),
    );
    expect(good.statusCode).toBe(201);
  });

  it('estimates the audience without writing or sending anything', async () => {
    const id = (await post('', draft())).json().id;
    const before = await db.$count(schema.notifications);

    const estimate = await get(`/${id}/audience-estimate`);
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json().estimatedRecipients).toBeGreaterThanOrEqual(2);
    expect(estimate.json().audienceType).toBe('all');

    expect(await db.$count(schema.notifications)).toBe(before);
    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.status).toBe('draft');

    // Only reachable accounts count: the user with no device is not a recipient.
    const platform = (
      await post('', draft({ audienceType: 'platform', audienceFilter: { platform: 'ios' } }))
    ).json();
    const iosEstimate = await get(`/${platform.id}/audience-estimate`);
    expect(iosEstimate.json().estimatedRecipients).toBeLessThan(
      estimate.json().estimatedRecipients,
    );
  });

  it('counts a live push subscription as reachable, and a legacy device token as nothing', async () => {
    // #515 regression. The audience used to be `exists (device_tokens)`, a
    // table no runtime wrote to: on DEV its only rows were the mobile contract
    // test's throwaway accounts, so campaign "AAA" reached three people who had
    // never opened the app while every real user was excluded. Reachability is
    // now a live `push_subscriptions` row, and only that.
    const [legacyOnly, live, revoked] = await db
      .insert(schema.users)
      .values([
        { email: `camp-legacy-${suffix()}@gogo.id.vn`, displayName: 'Legacy token only' },
        { email: `camp-live-${suffix()}@gogo.id.vn`, displayName: 'Live subscription' },
        { email: `camp-revoked-${suffix()}@gogo.id.vn`, displayName: 'Signed out' },
      ])
      .returning();

    // Exactly the shape the mobile contract test leaves behind.
    await db
      .insert(schema.deviceTokens)
      .values({ userId: legacyOnly!.id, platform: 'ios', token: `contract-${suffix()}` });
    await db.insert(schema.pushSubscriptions).values([
      { userId: live!.id, platform: 'ios', subscriptionId: `sub-live-${suffix()}` },
      {
        userId: revoked!.id,
        platform: 'ios',
        subscriptionId: `sub-revoked-${suffix()}`,
        revokedAt: new Date(),
      },
    ]);

    const platform = (
      await post('', draft({ audienceType: 'platform', audienceFilter: { platform: 'ios' } }))
    ).json();
    const reached = await db.execute(sql`
      select u.id from users u
      where ${audiencePredicate('platform', { platform: 'ios' })}
        and ${respectsPushPreference()}
    `);
    const ids = (reached.rows as { id: string }[]).map((r) => r.id);

    expect(platform.audienceFilter).toEqual({ platform: 'ios' });
    expect(ids).toContain(live!.id);
    // A device token proves nothing about whether anyone can be delivered to.
    expect(ids).not.toContain(legacyOnly!.id);
    // A confirmed logout takes the person out of the audience.
    expect(ids).not.toContain(revoked!.id);
  });

  it('drops a user from the audience once every subscription of theirs is revoked', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `camp-two-dev-${suffix()}@gogo.id.vn`, displayName: 'Two devices' })
      .returning();
    const phone = `sub-phone-${suffix()}`;
    const tablet = `sub-tablet-${suffix()}`;
    await db.insert(schema.pushSubscriptions).values([
      { userId: user!.id, platform: 'ios', subscriptionId: phone },
      { userId: user!.id, platform: 'ios', subscriptionId: tablet },
    ]);

    const reachable = async () => {
      const { rows } = await db.execute(sql`
        select u.id from users u where ${audiencePredicate('all', {})}
      `);
      return (rows as { id: string }[]).some((r) => r.id === user!.id);
    };

    expect(await reachable()).toBe(true);
    // Signing out of one device leaves the other; one row does not speak for
    // the account.
    await db
      .update(schema.pushSubscriptions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.pushSubscriptions.subscriptionId, phone));
    expect(await reachable()).toBe(true);

    await db
      .update(schema.pushSubscriptions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.pushSubscriptions.subscriptionId, tablet));
    expect(await reachable()).toBe(false);
  });

  it('scheduling writes a row and dispatches nothing in the request path', async () => {
    const id = (await post('', draft())).json().id;
    const res = await post(`/${id}/schedule`);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('scheduled');

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    // The request path leaves a due row and nothing else: no start time, no
    // recipients resolved, no notification. Only the worker changes that.
    expect(row!.status).toBe('scheduled');
    expect(row!.dispatchKey).toBeTruthy();
    expect(row!.startedAt).toBeNull();
    expect(row!.recipientCount).toBeNull();

    const delivered = await db.$count(
      schema.notifications,
      eq(schema.notifications.kind, 'campaign'),
    );
    expect(delivered).toBe(0);
  });

  it('cannot be edited once scheduled, and can be cancelled until it starts', async () => {
    const id = (await post('', draft())).json().id;
    await post(`/${id}/schedule`);

    const edit = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/campaigns/${id}`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { title: 'Đổi tiêu đề' },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe('CAMPAIGN_NOT_EDITABLE');

    const cancelled = await post(`/${id}/cancel`);
    expect(cancelled.statusCode).toBe(201);
    expect(cancelled.json().status).toBe('cancelled');
    expect(cancelled.json().scheduledAt).toBeUndefined();

    // Cancelling frees it for editing and re-scheduling again.
    expect(
      (
        await api().inject({
          method: 'PATCH',
          url: `/v1/cms/campaigns/${id}`,
          remoteAddress: ip(),
          headers: auth(ops.token),
          payload: { title: 'Đổi tiêu đề' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses to cancel a send that has already started, and says how far it got', async () => {
    const id = (await post('', draft())).json().id;
    await post(`/${id}/schedule`);
    // Stand in for the worker having claimed it.
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'sending', startedAt: new Date(), recipientCount: 10, sentCount: 4 })
      .where(eq(schema.notificationCampaigns.id, id));

    const res = await post(`/${id}/cancel`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CAMPAIGN_ALREADY_SENDING');
    // An honest answer rather than a rollback the backend cannot perform.
    expect(res.json().message).toContain('4');
    expect(res.json().message).toMatch(/cannot be recalled/i);
  });

  it('queues a test send to the composer, and refuses when there is no such account', async () => {
    const id = (await post('', draft())).json().id;

    const noAccount = await post(`/${id}/test-send`);
    expect(noAccount.statusCode).toBe(400);
    expect(noAccount.json().code).toBe('NO_TEST_RECIPIENT');

    // The staff address, registered and verified on the consumer side.
    const [self] = await db
      .insert(schema.users)
      .values({
        email: 'camp226@gogo.local',
        displayName: 'Ops Self',
        emailVerifiedAt: new Date(),
      })
      .returning();
    await db
      .insert(schema.pushSubscriptions)
      .values({ userId: self!.id, platform: 'ios', subscriptionId: `sub-self-${suffix()}` });

    const queued = await post(`/${id}/test-send`);
    expect(queued.statusCode).toBe(201);
    expect(queued.json().testSendQueued).toBe(true);

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    // A test is not a send: the request queued work for the worker and left
    // the campaign exactly where it was.
    expect(row!.testSendRequestedAt).toBeTruthy();
    expect(row!.testSendUserId).toBe(self!.id);
    expect(row!.status).toBe('draft');
  });

  it('audits composing, scheduling and cancelling', async () => {
    const id = (await post('', draft())).json().id;
    await post(`/${id}/schedule`);
    await post(`/${id}/cancel`);

    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=notification_campaign&resourceId=${id}&limit=10`,
      headers: auth(ops.token),
    });
    const actions = audit.json().items.map((e: { action: string }) => e.action);
    expect(actions).toContain('campaign.created');
    expect(actions).toContain('campaign.scheduled');
    expect(actions).toContain('campaign.cancelled');
  });

  it('is an ops resource: an editor cannot compose or send one', async () => {
    expect((await post('', draft(), editor.token)).statusCode).toBe(403);
    expect((await get('', editor.token)).statusCode).toBe(403);
  });

  it('filters and pages the list', async () => {
    const name = `probe-${suffix()}`;
    for (let i = 0; i < 3; i += 1) await post('', draft({ name: `${name}-${i}` }));

    const filtered = await get(`?q=${name}`);
    expect(filtered.json().totalCount).toBe(3);
    const first = await get(`?q=${name}&limit=2`);
    expect(first.json().items).toHaveLength(2);
    const second = await get(
      `?q=${name}&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(second.json().items).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
    expect((await get(`?q=${name}&status=sent`)).json().totalCount).toBe(0);
  });
});

/**
 * BE-CMS-G4e (#226) — the worker half. Delivery is at-least-once, so the test
 * that matters is what a second run does.
 */
describe('campaign dispatch (worker side, BE-CMS-G4e #226)', () => {
  let ops: { id: string; token: string };
  let userWithTwoDevices: string;
  let userOptedOut: string;
  const suffix = () => Math.random().toString(36).slice(2, 8);

  /** Counts every push, so a double send is visible rather than inferred. */
  // #193: user-targeted, like the real provider — one entry per recipient.
  class CountingPush {
    readonly sent: { userId: string; title: string; imageUrl?: string | undefined }[] = [];
    async sendToUser(
      userId: string,
      payload: { headings: { en: string }; imageUrl?: string | undefined },
    ) {
      return this.sendToUsers([userId], payload);
    }
    async sendToUsers(
      userIds: readonly string[],
      payload: { headings: { en: string }; imageUrl?: string | undefined },
    ) {
      for (const userId of userIds)
        this.sent.push({ userId, title: payload.headings.en, imageUrl: payload.imageUrl });
      const id = `fake-${this.sent.length}`;
      return {
        providerMessageId: id,
        providerMessageIds: [id],
        emptyResponses: 0,
        unknownUserIds: [],
      };
    }
  }

  async function dispatcher(push: CountingPush, mediaBaseUrl?: string) {
    const { CampaignDispatcher } = await import('@gogo/modules');
    return new CampaignDispatcher(db as never, push, undefined, mediaBaseUrl);
  }

  beforeAll(async () => {
    ops = await createAdmin('dispatch226@gogo.local', 'ops_admin');

    const [twoDevices] = await db
      .insert(schema.users)
      .values({ email: `disp-a-${suffix()}@gogo.id.vn`, displayName: 'Two devices' })
      .returning();
    userWithTwoDevices = twoDevices!.id;
    await db.insert(schema.pushSubscriptions).values([
      { userId: userWithTwoDevices, platform: 'ios', subscriptionId: `disp-ios-${suffix()}` },
      { userId: userWithTwoDevices, platform: 'android', subscriptionId: `disp-and-${suffix()}` },
    ]);

    const [optedOut] = await db
      .insert(schema.users)
      .values({ email: `disp-b-${suffix()}@gogo.id.vn`, displayName: 'Opted out' })
      .returning();
    userOptedOut = optedOut!.id;
    await db
      .insert(schema.pushSubscriptions)
      .values({ userId: userOptedOut, platform: 'ios', subscriptionId: `disp-out-${suffix()}` });
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: userOptedOut, channel: 'push', kind: 'campaign', enabled: false });
  });

  async function scheduledCampaign(extra: Record<string, unknown> = {}) {
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/campaigns',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {
        name: `Gửi thử ${suffix()}`,
        title: 'Ưu đãi cuối tuần',
        body: 'Mở app để xem gợi ý',
        audienceType: 'all',
        ...extra,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const scheduled = await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/schedule`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(scheduled.statusCode).toBe(201);
    return id;
  }

  /**
   * #358 — "this campaign is due, and nothing else is", made true by the
   * database rather than by timing.
   *
   * `dispatchDue()` claims whatever is `scheduled` with `scheduled_at <= now()`,
   * oldest first. Two things made that nondeterministic under a loaded suite:
   * - `scheduled_at` is the api's `new Date()` (host clock) while `now()` is the
   *   container's clock. When the container lags, a campaign scheduled a
   *   moment ago is not due yet, the tick claims nothing, and the test reads
   *   `scheduled` / zero sends.
   * - Earlier tests in this file leave campaigns `scheduled` (one on purpose,
   *   to prove scheduling dispatches nothing). A tick claims those too.
   * So: the campaign under test is pinned a second into the past in the
   * database's clock, and every other still-scheduled campaign is parked a day
   * ahead. Nothing about what the dispatcher does is changed or skipped.
   */
  /** Inbox rows written for one campaign — not every campaign the file made. */
  async function campaignNotifications(id: string): Promise<number> {
    const { rows } = await db.execute(sql`
      select count(*)::int as n from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id}
    `);
    return (rows[0] as { n: number }).n;
  }

  async function makeOnlyDue(id: string) {
    await db.execute(sql`
      update notification_campaigns
      set scheduled_at = case when id = ${id}::uuid
                              then now() - interval '1 second'
                              else now() + interval '1 day' end
      where status = 'scheduled'
    `);
  }

  async function dispatchCampaign(id: string, push: CountingPush) {
    await makeOnlyDue(id);
    return (await dispatcher(push)).dispatchDue();
  }

  /*
   * BE-CMS-M3 — the image has to survive the whole way to the provider.
   *
   * It was stored on the campaign and stopped there: the dispatcher never
   * selected `image_key`, the notification contract had no image field, and
   * the adapter sent none. An editor uploaded a picture, saved it, and the
   * push went out as text with nothing saying so.
   *
   * Driven through the test-send path rather than `dispatchDue`, deliberately.
   * A due-campaign tick claims up to five campaigns at once, so a test that
   * calls it consumes whatever else the suite has left scheduled — which is
   * how these two tests, written that way first, broke four unrelated ones.
   * `deliverTestSends` claims by request, so this touches only its own row and
   * still runs the same `deliver()` that a real send does.
   */
  /*
   * A composer of its own: a test send goes to the staff member's *consumer*
   * account, matched by email, so the pair has to exist and be subscribed.
   * Created here rather than in `beforeAll` so it cannot collide with the
   * account the later test-send test inserts for the shared `ops` admin.
   */
  let imageComposer: { id: string; token: string } | undefined;
  async function composer() {
    if (imageComposer) return imageComposer;
    const email = `dispatch226-image-${suffix()}@gogo.local`;
    imageComposer = await createAdmin(email, 'ops_admin');
    const [self] = await db
      .insert(schema.users)
      .values({ email, displayName: 'Image composer', emailVerifiedAt: new Date() })
      .returning();
    await db
      .insert(schema.pushSubscriptions)
      .values({ userId: self!.id, platform: 'ios', subscriptionId: `sub-img-${suffix()}` });
    return imageComposer;
  }

  async function testSend(push: CountingPush, extra: Record<string, unknown>) {
    const who = await composer();
    const title = `Ảnh chiến dịch ${suffix()}`;
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/campaigns',
      remoteAddress: ip(),
      headers: auth(who.token),
      payload: {
        name: `Gửi thử ảnh ${suffix()}`,
        title,
        body: 'Mở app để xem gợi ý',
        audienceType: 'all',
        ...extra,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/test-send`,
      remoteAddress: ip(),
      headers: auth(who.token),
      payload: {},
    });
    await (await dispatcher(push, 'https://assets-dev.gogo.id.vn')).deliverTestSends();
    return { id, title, sent: push.sent.filter((entry) => entry.title === title) };
  }

  it('delivers a campaign image as a durable public URL', async () => {
    const BASE = 'https://assets-dev.gogo.id.vn';
    const authorized = await api().inject({
      method: 'POST',
      url: '/v1/cms/uploads',
      remoteAddress: ip(),
      headers: auth((await composer()).token),
      payload: { purpose: 'campaign_image', contentType: 'image/jpeg', contentLength: 5_000 },
    });
    expect(authorized.statusCode).toBe(201);
    const key = markUploaded(authorized.json().key as string);
    // ADR-0005 routing: a campaign image lands on the public prefix, which is
    // what makes a public URL for it meaningful at all.
    expect(key).toMatch(/^campaigns\//);

    const { id, sent } = await testSend(new CountingPush(), { imageKey: key });

    expect(sent.length).toBeGreaterThan(0);
    for (const entry of sent) {
      expect(entry.imageUrl).toBe(`${BASE}/${key}`);
      // Never the presigned upload URL: it is signed for PUT and expires.
      expect(entry.imageUrl).not.toContain('X-Amz-Signature');
    }

    const detail = await api().inject({
      method: 'GET',
      url: `/v1/cms/campaigns/${id}`,
      headers: auth((await composer()).token),
    });
    // The console previews the same URL the provider is given — where this
    // environment has media hosting at all. The API composes it from its own
    // config, which the integration app leaves unset, so the assertion is that
    // the key is carried and never that a host appears from nowhere.
    expect(detail.json().imageKey).toBe(key);
    const previewed = detail.json().imageUrl as string | null;
    if (previewed !== null) expect(previewed).toBe(`${BASE}/${key}`);
  });

  it('sends a text campaign without an image field', async () => {
    const { sent } = await testSend(new CountingPush(), {});
    expect(sent.length).toBeGreaterThan(0);
    for (const entry of sent) expect(entry.imageUrl).toBeUndefined();
  });

  it('estimates exactly what the send will attempt, opt-outs included (#523)', async () => {
    // The header of `campaign-audience.ts` promises one definition used by both
    // the estimate and the worker, "because the whole point of an estimate is
    // that it is the same question the send will ask". It was not: the estimate
    // applied only `audiencePredicate`, so it counted `userOptedOut` — someone
    // who had turned campaign push off — and the send then reached one fewer
    // with nothing saying where the difference went.
    //
    // Asserted as an equality between the two numbers rather than against a
    // constant. A hand-written expected count is exactly what drifts apart
    // again the next time either side changes.
    const id = await scheduledCampaign();

    const estimate = await api().inject({
      method: 'GET',
      url: `/v1/cms/campaigns/${id}/audience-estimate`,
      headers: auth(ops.token),
    });
    expect(estimate.statusCode).toBe(200);
    const estimated = estimate.json().estimatedRecipients as number;

    await dispatchCampaign(id, new CountingPush());
    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));

    // `recipient_count` is what the worker resolved and then acted on.
    expect(row!.recipientCount).toBe(estimated);

    // And the opted-out account is in neither number — the guard against both
    // sides being consistently wrong.
    const { rows: reached } = await db.execute(sql`
      select count(*)::int as n from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id}
        and user_id = ${userOptedOut}::uuid
    `);
    expect((reached[0] as { n: number }).n).toBe(0);
  });

  it('claims a due campaign, sends once per recipient, and records what it did', async () => {
    const id = await scheduledCampaign();
    const push = new CountingPush();
    const handled = await dispatchCampaign(id, push);
    expect(handled).toBe(1);

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.status).toBe('sent');
    expect(row!.startedAt).not.toBeNull();
    expect(row!.completedAt).not.toBeNull();
    expect(row!.recipientCount).toBeGreaterThanOrEqual(1);
    expect(row!.sentCount).toBeGreaterThanOrEqual(1);

    // One notification per recipient and one push per recipient — addressed by
    // user id, however many devices they hold (#193, spec §26). The two device
    // tokens registered above are not consulted on this path.
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userWithTwoDevices));
    const forThis = rows.filter((n) => (n.payload as { campaignId?: string }).campaignId === id);
    expect(forThis).toHaveLength(1);
    expect(forThis[0]!.kind).toBe('campaign');
    expect(forThis[0]!.dedupeKey).toMatch(/^campaign:/);
    expect(
      push.sent.filter((s) => s.userId === userWithTwoDevices && s.title === 'Ưu đãi cuối tuần'),
    ).toHaveLength(1);
  });

  it('a second run sends nothing: the dedupe key is the record of "already sent"', async () => {
    const id = await scheduledCampaign();
    const first = new CountingPush();
    await dispatchCampaign(id, first);
    const afterFirst = await campaignNotifications(id);
    expect(first.sent.length).toBeGreaterThan(0);
    expect(afterFirst).toBe(first.sent.length);

    // Put it back on the queue with the same dispatch key — exactly what a
    // crash between "claimed" and "finished" leaves behind.
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'scheduled' })
      .where(eq(schema.notificationCampaigns.id, id));

    const second = new CountingPush();
    await dispatchCampaign(id, second);

    expect(second.sent).toHaveLength(0);
    expect(await campaignNotifications(id)).toBe(afterFirst);
  });

  it('a re-send after a cancel is a new dispatch, not a suppressed retry', async () => {
    const id = await scheduledCampaign();
    await dispatchCampaign(id, new CountingPush());
    const afterFirst = await campaignNotifications(id);
    expect(afterFirst).toBeGreaterThan(0);

    // A deliberate second send gets a new dispatch key, so the dedupe key that
    // silenced the retry above does not silence this.
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'cancelled', scheduledAt: null, dispatchKey: null })
      .where(eq(schema.notificationCampaigns.id, id));
    const rescheduled = await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/schedule`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(rescheduled.statusCode).toBe(201);

    const push = new CountingPush();
    await dispatchCampaign(id, push);
    expect(push.sent.length).toBeGreaterThan(0);
    expect(await campaignNotifications(id)).toBe(afterFirst + push.sent.length);
  });

  it('does not send to someone who turned campaigns off', async () => {
    const id = await scheduledCampaign();
    await dispatchCampaign(id, new CountingPush());

    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userOptedOut));
    expect(rows.filter((n) => (n.payload as { campaignId?: string }).campaignId === id)).toEqual(
      [],
    );
  });

  it('a send that fails half-way resumes on reschedule: nobody pushed twice, nobody left out (#193 review)', async () => {
    const id = await scheduledCampaign();

    // First run: the provider dies on the second recipient.
    const firstRun = new CountingPush();
    let calls = 0;
    const flaky = {
      sent: firstRun.sent,
      async sendToUser(userId: string, payload: { headings: { en: string } }) {
        calls += 1;
        if (calls === 2) throw new Error('provider unavailable');
        return firstRun.sendToUsers([userId], payload);
      },
      async sendToUsers(ids: readonly string[], payload: { headings: { en: string } }) {
        return firstRun.sendToUsers(ids, payload);
      },
    };
    await dispatchCampaign(id, flaky as never);
    const [failed] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(failed!.status).toBe('failed');
    expect(firstRun.sent).toHaveLength(1);
    const delivered = firstRun.sent[0]!.userId;
    const keyBefore = failed!.dispatchKey;
    expect(keyBefore).not.toBeNull();

    // The operator reschedules through the API — the advertised recovery.
    const rescheduled = await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/schedule`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(rescheduled.statusCode).toBe(201);
    const [again] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    // A resumed send keeps its dispatch identity; only cancel-then-schedule mints a new one.
    expect(again!.dispatchKey).toBe(keyBefore);

    const secondRun = new CountingPush();
    await dispatchCampaign(id, secondRun);
    const [done] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(done!.status).toBe('sent');

    // Nobody twice — in particular not the recipient the first run reached.
    const everyone = [...firstRun.sent, ...secondRun.sent].map((s) => s.userId);
    expect(new Set(everyone).size).toBe(everyone.length);
    expect(secondRun.sent.map((s) => s.userId)).not.toContain(delivered);

    // Nobody left out: one inbox row per resolved recipient, every row marked delivered.
    const { rows } = await db.execute(sql`
      select user_id, push_sent_at, push_message_id
      from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id}
    `);
    expect(rows).toHaveLength(done!.recipientCount!);
    expect(everyone).toHaveLength(rows.length);
    for (const row of rows as { push_sent_at: Date | null; push_message_id: string | null }[]) {
      expect(row.push_sent_at).not.toBeNull();
      expect(row.push_message_id).not.toBeNull();
    }
    expect(done!.sentCount).toBe(rows.length);
    expect(done!.failedCount).toBe(0);
  });

  it('a delivered campaign refuses edits to copy, audience and destination (R3)', async () => {
    const id = await scheduledCampaign();
    const push = new CountingPush();
    await dispatchCampaign(id, push);
    expect(push.sent.length).toBeGreaterThan(0);
    const [sent] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(sent!.status).toBe('sent');

    // `sent` is not editable at all, so put it in a state that is — the exact
    // shape the finding describes: a campaign that reached some people and is
    // now editable again.
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'failed' })
      .where(eq(schema.notificationCampaigns.id, id));

    const edits: [string, Record<string, unknown>][] = [
      ['copy', { title: 'Tiêu đề mới' }],
      ['body', { body: 'Nội dung mới' }],
      ['audience', { audienceType: 'couple' }],
      ['destination', { destinationType: 'saved' }],
    ];
    for (const [label, payload] of edits) {
      const res = await api().inject({
        method: 'PATCH',
        url: `/v1/cms/campaigns/${id}`,
        remoteAddress: ip(),
        headers: auth(ops.token),
        payload,
      });
      expect(res.statusCode, label).toBe(409);
      expect(res.json().code, label).toBe('CAMPAIGN_ALREADY_DELIVERED');
    }

    // Nothing was written by the refused edits.
    const [unchanged] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(unchanged!.title).toBe(sent!.title);
    expect(unchanged!.body).toBe(sent!.body);
    expect(unchanged!.audienceType).toBe(sent!.audienceType);
    expect(unchanged!.destinationType).toBe(sent!.destinationType);
  });

  it('a delivered campaign still accepts an editorial rename and a no-op patch (R3)', async () => {
    const id = await scheduledCampaign();
    await dispatchCampaign(id, new CountingPush());
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'failed' })
      .where(eq(schema.notificationCampaigns.id, id));
    const [before] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));

    // The name never reaches a phone.
    const renamed = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/campaigns/${id}`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { name: `Đổi tên ${suffix()}` },
    });
    expect(renamed.statusCode).toBe(200);

    // Re-sending the same values is not a change, so it is not refused.
    const noop = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/campaigns/${id}`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {
        title: before!.title,
        body: before!.body,
        audienceType: before!.audienceType,
        destinationType: before!.destinationType,
      },
    });
    expect(noop.statusCode).toBe(200);
  });

  it('a campaign that delivered to nobody is still fully editable (R3)', async () => {
    const id = await scheduledCampaign();
    // Provider refuses everyone: rows exist, none marked delivered.
    const refusing = {
      async sendToUser() {
        return {
          providerMessageId: null,
          providerMessageIds: [],
          emptyResponses: 1,
          unknownUserIds: [],
        };
      },
      async sendToUsers() {
        return {
          providerMessageId: null,
          providerMessageIds: [],
          emptyResponses: 1,
          unknownUserIds: [],
        };
      },
    };
    await dispatchCampaign(id, refusing as never);
    const { rows: delivered } = await db.execute(sql`
      select count(*)::int as n from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id} and push_sent_at is not null
    `);
    expect((delivered[0] as { n: number }).n).toBe(0);

    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'failed' })
      .where(eq(schema.notificationCampaigns.id, id));
    const edited = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/campaigns/${id}`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { title: 'Vẫn sửa được' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().title).toBe('Vẫn sửa được');
  });

  /**
   * R4, recorded rather than changed: what actually happens to a recipient the
   * provider had no subscription for. These tests assert today's behaviour so a
   * future product decision is a deliberate edit here, not a silent drift.
   */
  it('a completed campaign is terminal, so its no-target recipients are final (R4)', async () => {
    const id = await scheduledCampaign();
    // Everyone resolves, nobody is subscribed: rows exist, none delivered.
    const noTarget = {
      async sendToUser() {
        return {
          providerMessageId: null,
          providerMessageIds: [],
          emptyResponses: 1,
          unknownUserIds: [],
        };
      },
      async sendToUsers() {
        return {
          providerMessageId: null,
          providerMessageIds: [],
          emptyResponses: 1,
          unknownUserIds: [],
        };
      },
    };
    await dispatchCampaign(id, noTarget as never);

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    // #516: the provider answered and had nobody to deliver to, so nothing was
    // sent — and the campaign says so. This used to record `sent`, which is how
    // campaign AAA on DEV finished with a mint "Đã gửi" badge over 0 accepted
    // and 3 failures.
    expect(row!.status).toBe('failed');
    expect(row!.failedCount).toBeGreaterThan(0);
    expect(row!.sentCount).toBe(0);
    expect(row!.lastError).toMatch(/^NO_SUBSCRIPTION_ACCEPTED:/);

    const { rows: owed } = await db.execute(sql`
      select count(*)::int as n from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id} and push_sent_at is null
    `);
    expect((owed[0] as { n: number }).n).toBe(row!.failedCount);

    // And `failed` reopens, which is the whole reason for choosing it: the
    // recipients counted above are the ones a reschedule attempts again.
    const reschedule = await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/schedule`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(reschedule.statusCode).toBe(201);
    expect(reschedule.json().status).toBe('scheduled');
  });

  it('an empty audience ends failed, not as a campaign that sent nothing to nobody', async () => {
    // #516. `sent 0/0` reads as success; "this selected nobody" is precisely
    // what an operator has to see before concluding the message went out.
    const id = await scheduledCampaign({
      audienceType: 'platform',
      audienceFilter: { platform: 'web' },
    });
    const push = new CountingPush();
    await dispatchCampaign(id, push);

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.recipientCount).toBe(0);
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toMatch(/^EMPTY_AUDIENCE:/);
    expect(row!.sentCount).toBe(0);
    expect(row!.failedCount).toBe(0);
    // Deliberately not asserted on `push.sent`: one tick claims up to five
    // campaigns, so the fake carries whatever else this file left scheduled.
    // `recipientCount = 0` is this campaign's own evidence that it sent nothing.
  });

  it('a failed campaign does retry its no-target recipients on an unchanged retry (R4)', async () => {
    const id = await scheduledCampaign();
    // First run: recipient 1 has no subscription, then the provider dies.
    let calls = 0;
    const firstRun = new CountingPush();
    const flaky = {
      sent: firstRun.sent,
      async sendToUser(userId: string, payload: { headings: { en: string } }) {
        calls += 1;
        if (calls === 1) {
          return {
            providerMessageId: null,
            providerMessageIds: [],
            emptyResponses: 1,
            unknownUserIds: [],
          };
        }
        if (calls === 2) throw new Error('provider unavailable');
        return firstRun.sendToUsers([userId], payload);
      },
      async sendToUsers(ids: readonly string[], payload: { headings: { en: string } }) {
        return firstRun.sendToUsers(ids, payload);
      },
    };
    await dispatchCampaign(id, flaky as never);
    const [failed] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(failed!.status).toBe('failed');

    // Unchanged retry — permitted by the R3 rule, and resumed on the same key.
    const rescheduled = await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/schedule`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });
    expect(rescheduled.statusCode).toBe(201);

    const secondRun = new CountingPush();
    await dispatchCampaign(id, secondRun);

    // The no-target recipient is attempted again: its row carries no
    // push_sent_at, which is the same thing "never delivered" means for a
    // recipient the outage never reached. That is the difference from the
    // completed case above — the retry exists only because `failed` reopens.
    const [done] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(done!.status).toBe('sent');
    expect(secondRun.sent.length).toBeGreaterThan(0);
    const { rows: delivered } = await db.execute(sql`
      select count(*)::int as n from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id} and push_sent_at is not null
    `);
    expect((delivered[0] as { n: number }).n).toBe(done!.sentCount);
  });

  it('a provider outage fails the campaign visibly instead of leaving it sending', async () => {
    const id = await scheduledCampaign();
    const exploding = {
      sent: [],
      async sendToUser() {
        throw new Error('provider unavailable');
      },
      async sendToUsers() {
        throw new Error('provider unavailable');
      },
    };
    const { CampaignDispatcher } = await import('@gogo/modules');
    // The outage simulated here is in resolving the audience; a provider error
    // takes the same path (see the next test).
    const literalText = (query: unknown): string =>
      ((query as { queryChunks?: { value?: string[] }[] }).queryChunks ?? [])
        .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join('') : ''))
        .join(' ');
    const broken = new CampaignDispatcher(
      {
        execute: async (query: unknown) => {
          if (literalText(query).includes('from users u')) {
            throw new Error('audience resolution failed');
          }
          return db.execute(query as never);
        },
      } as never,
      exploding as never,
    );
    await makeOnlyDue(id);
    await broken.dispatchDue();

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toContain('audience resolution failed');
    expect(row!.completedAt).not.toBeNull();
  });

  it('delivers a queued test send to exactly one account, without touching status', async () => {
    const [self] = await db
      .insert(schema.users)
      .values({
        email: 'dispatch226@gogo.local',
        displayName: 'Ops Self',
        emailVerifiedAt: new Date(),
      })
      .returning();
    await db
      .insert(schema.pushSubscriptions)
      .values({ userId: self!.id, platform: 'ios', subscriptionId: `disp-self-${suffix()}` });

    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/campaigns',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {
        name: `Thử nghiệm ${suffix()}`,
        title: 'Bản xem trước',
        body: 'Chỉ gửi cho người soạn',
        audienceType: 'all',
      },
    });
    const id = created.json().id as string;
    await api().inject({
      method: 'POST',
      url: `/v1/cms/campaigns/${id}/test-send`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {},
    });

    const push = new CountingPush();
    const delivered = await (await dispatcher(push)).deliverTestSends();
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(push.sent.some((s) => s.title === 'Bản xem trước')).toBe(true);

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.status).toBe('draft');
    expect(row!.testSendRequestedAt).toBeNull();
    expect(row!.testSendCompletedAt).not.toBeNull();

    const others = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userWithTwoDevices));
    expect(others.filter((n) => (n.payload as { campaignId?: string }).campaignId === id)).toEqual(
      [],
    );
  });
});

/**
 * BE-CMS-G4c (#224) — banners. Destination is cross-checked against the type
 * it names, and `expired` is the server's answer, not the client's guess.
 */
describe('banners (BE-CMS-G4c #224)', () => {
  let editor: { id: string; token: string };
  let otherEditor: { id: string; token: string };
  let moderator: { id: string; token: string };
  /*
   * `POST /cms/uploads` is rate-limited 30/60s per actor, so tests that mint
   * extra keys get their own account. Sharing `editor` made the image tests
   * spend the budget the rest of the suite was already counting on, and the
   * failure landed on whichever test happened to run at number 31.
   */
  let imageEditor: { id: string; token: string };
  let placeId: string;
  let recommendationId: string;
  let campaignId: string;
  const suffix = () => Math.random().toString(36).slice(2, 8);

  /** A real key through the real upload path, as the CMS would get one. */
  async function uploadKey(token: string, purpose = 'banner_image') {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/cms/uploads',
      remoteAddress: ip(),
      headers: auth(token),
      payload: { purpose, contentType: 'image/jpeg', contentLength: 120_000 },
    });
    expect(res.statusCode).toBe(201);
    return markUploaded(res.json().key as string);
  }

  beforeAll(async () => {
    editor = await createAdmin('banner224@gogo.local', 'editor');
    otherEditor = await createAdmin('banner224-other@gogo.local', 'editor');
    moderator = await createAdmin('banner224-mod@gogo.local', 'moderator');
    imageEditor = await createAdmin('banner224-image@gogo.local', 'editor');
    const ops = await createAdmin('banner224-ops@gogo.local', 'ops_admin');

    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Banner Place',
        nameNormalized: 'banner place',
        status: 'published',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    placeId = place!.id;

    const recommendation = await api().inject({
      method: 'POST',
      url: '/v1/cms/recommendations',
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: {
        slug: `banner-rec-${suffix()}`,
        internalName: 'Rec for banner',
        title: 'Gợi ý',
        audience: 'couple',
      },
    });
    recommendationId = recommendation.json().id;

    const campaign = await api().inject({
      method: 'POST',
      url: '/v1/cms/campaigns',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: {
        name: `Banner campaign ${suffix()}`,
        title: 'Ưu đãi',
        body: 'Xem ngay',
        audienceType: 'all',
      },
    });
    campaignId = campaign.json().id;
  });

  const post = (payload: unknown, token = editor.token) =>
    api().inject({
      method: 'POST',
      url: '/v1/cms/banners',
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const patch = (path: string, payload: unknown, token = editor.token) =>
    api().inject({
      method: 'PATCH',
      url: `/v1/cms/banners/${path}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const get = (path = '', token = editor.token) =>
    api().inject({ method: 'GET', url: `/v1/cms/banners${path}`, headers: auth(token) });

  async function valid(extra: Record<string, unknown> = {}, token = editor.token) {
    return {
      name: `Banner ${suffix()}`,
      imageKey: await uploadKey(token),
      title: 'Cuối tuần này',
      placement: 'home_hero',
      priority: 10,
      ...extra,
    };
  }

  it('creates one and binds the image to it', async () => {
    const payload = await valid();
    const res = await post(payload);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('draft');
    expect(body.lifecycleStatus).toBe('draft');
    expect(body.destinationType).toBe('none');
    expect(body.imageKey).toBe(payload.imageKey);

    // The upload is now this banner's, through the same attach path check-in
    // photos use — not an unowned string sitting in a column.
    const [media] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, payload.imageKey));
    expect(media!.status).toBe('attached');
    expect(media!.attachedToType).toBe('banner');
    expect(media!.attachedToId).toBe(body.id);
  });

  it('refuses an image that is not the caller’s, or not a banner image', async () => {
    const foreign = await uploadKey(otherEditor.token);
    const notMine = await post(await valid({ imageKey: foreign }));
    expect(notMine.statusCode).toBe(400);
    expect(notMine.json().code).toBe('INVALID_UPLOAD_KEY');

    const wrongPurpose = await uploadKey(editor.token, 'campaign_image');
    const mismatched = await post(await valid({ imageKey: wrongPurpose }));
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().code).toBe('INVALID_UPLOAD_KEY');

    // An image is mandatory: a banner without one is not a banner.
    const payload = await valid();
    const { imageKey: _dropped, ...withoutImage } = payload;
    expect((await post(withoutImage)).statusCode).toBe(400);
  });

  /*
   * A refused image used to leave the banner behind.
   *
   * `create` inserted the row and attached afterwards, so a rejected key
   * returned 400 over a banner that was already saved, pointing at an image
   * nobody could load. The refusal has to leave nothing behind — the property
   * `CmsPlaceMediaService.attach` gets by attaching before it writes.
   */
  it('leaves no banner behind when the image is refused', async () => {
    const name = `Orphan check ${suffix()}`;
    const foreign = await uploadKey(otherEditor.token);

    const res = await post(
      { ...(await valid({ name }, imageEditor.token)), imageKey: foreign },
      imageEditor.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');

    const rows = await db.select().from(schema.banners).where(eq(schema.banners.name, name));
    expect(rows).toHaveLength(0);
  });

  /*
   * A refused replacement used to destroy the image it replaced.
   *
   * `update` wrote `imageKey` first and validated afterwards, so the rejected
   * key was already saved when the 400 came back and the last good image was
   * gone from the record with nothing to recover it from.
   */
  it('switching back to an earlier image key re-checks storage (#560 F-01)', async () => {
    const created = await post(await valid({}, imageEditor.token), imageEditor.token);
    expect(created.statusCode).toBe(201);
    const banner = created.json();
    const keyA = banner.imageKey as string;
    const keyB = await uploadKey(imageEditor.token);
    expect((await patch(banner.id, { imageKey: keyB }, imageEditor.token)).statusCode).toBe(200);

    // A's object is gone from the bucket; its upload row still says it is
    // attached to this banner, which used to skip the check entirely.
    app.get<FakeStorage>(PUBLIC_STORAGE_PROVIDER).objects.delete(keyA);
    const back = await patch(banner.id, { imageKey: keyA }, imageEditor.token);
    expect(back.statusCode).toBe(409);
    expect(back.json().code).toBe('UPLOAD_NOT_RECEIVED');
    expect((await get(`/${banner.id}`)).json().imageKey).toBe(keyB);
  });

  it('keeps the saved image when a replacement is refused', async () => {
    const created = await post(await valid({}, imageEditor.token), imageEditor.token);
    expect(created.statusCode).toBe(201);
    const banner = created.json();

    const foreign = await uploadKey(otherEditor.token);
    const refused = await patch(banner.id, { imageKey: foreign }, imageEditor.token);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('INVALID_UPLOAD_KEY');

    const after = await get(`/${banner.id}`);
    expect(after.json().imageKey).toBe(banner.imageKey);

    // And the banner still resolves to the image it actually owns.
    const [media] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, banner.imageKey));
    expect(media!.attachedToId).toBe(banner.id);
  });

  /*
   * The other direction: a write that fails *after* the claim.
   *
   * Moving the attach earlier stops the rejected key from being saved, but on
   * its own it does not make the pair atomic — `uploads.attach` ran on its own
   * connection and committed separately, so a banner write that failed after
   * it left the upload marked `attached` to a banner that never took the
   * image. The claim now runs on the caller's transaction, so it rolls back
   * with everything else. A duplicate name is the cheapest way to fail the
   * write at exactly that point.
   */
  it('releases the image claim when the write fails after it', async () => {
    const taken = await post(await valid({}, imageEditor.token), imageEditor.token);
    expect(taken.statusCode).toBe(201);
    const clashingName = taken.json().name;

    const banner = await post(await valid({}, imageEditor.token), imageEditor.token);
    expect(banner.statusCode).toBe(201);

    // A good key, and a name the write will refuse.
    const replacement = await uploadKey(imageEditor.token);
    const refused = await patch(
      banner.json().id,
      { imageKey: replacement, name: clashingName },
      imageEditor.token,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('BANNER_NAME_TAKEN');

    // The banner kept its own image...
    expect((await get(`/${banner.json().id}`, imageEditor.token)).json().imageKey).toBe(
      banner.json().imageKey,
    );
    // ...and the replacement key is still unclaimed, so it can be used again
    // rather than being burnt by a request that changed nothing.
    const [claim] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, replacement));
    expect(claim!.status).toBe('pending');
    expect(claim!.attachedToId).toBeNull();

    const reused = await patch(banner.json().id, { imageKey: replacement }, imageEditor.token);
    expect(reused.statusCode).toBe(200);
    expect(reused.json().imageKey).toBe(replacement);
  });

  it('re-saving the same image key is not a re-attach', async () => {
    const created = await post(await valid({}, imageEditor.token), imageEditor.token);
    expect(created.statusCode).toBe(201);
    const banner = created.json();

    // The key is already this banner's; saving the unchanged value must not
    // trip the "already attached" refusal.
    const again = await patch(banner.id, { imageKey: banner.imageKey }, imageEditor.token);
    expect(again.statusCode).toBe(200);
    expect(again.json().imageKey).toBe(banner.imageKey);

    const [claim] = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.storageKey, banner.imageKey));
    expect(claim!.attachedToId).toBe(banner.id);
  });

  it('refuses an expired key', async () => {
    const stale = await uploadKey(imageEditor.token);
    await db
      .update(schema.mediaUploads)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.mediaUploads.storageKey, stale));

    const res = await post(
      { ...(await valid({}, imageEditor.token)), imageKey: stale },
      imageEditor.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_UPLOAD_KEY');
  });

  it('cross-validates the destination against the type it names', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';

    for (const [destinationType, destinationValue] of [
      ['place', placeId],
      ['recommendation', recommendationId],
      ['campaign', campaignId],
      ['external_url', 'https://gogo.id.vn/tet'],
    ] as const) {
      const res = await post(await valid({ destinationType, destinationValue }));
      expect(res.statusCode, destinationType).toBe(201);
      expect(res.json().destinationType).toBe(destinationType);
    }

    // A place id in the recommendation slot resolves to nothing: the type
    // decides which table is checked, so this is caught rather than shipped.
    const crossed = await post(
      await valid({ destinationType: 'recommendation', destinationValue: placeId }),
    );
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json().code).toBe('DESTINATION_NOT_FOUND');

    const missing = await post(await valid({ destinationType: 'place', destinationValue: ghost }));
    expect(missing.json().code).toBe('DESTINATION_NOT_FOUND');

    const noneWithValue = await post(
      await valid({ destinationType: 'none', destinationValue: placeId }),
    );
    expect(noneWithValue.statusCode).toBe(400);

    const missingValue = await post(await valid({ destinationType: 'place' }));
    expect(missingValue.statusCode).toBe(400);
    expect(missingValue.json().code).toBe('INVALID_DESTINATION');
  });

  it('refuses an external URL that is unsafe to open at scale', async () => {
    for (const url of [
      'http://gogo.id.vn/promo',
      'https://127.0.0.1/admin',
      'https://192.168.1.1',
      'https://user:pw@gogo.id.vn',
      'not-a-url',
    ]) {
      const res = await post(
        await valid({ destinationType: 'external_url', destinationValue: url }),
      );
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe('INVALID_DESTINATION');
    }
  });

  it('computes `expired` from the clock rather than storing it', async () => {
    const id = (
      await post(
        await valid({
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2026-02-01T00:00:00Z',
        }),
      )
    ).json().id;

    // Publishing a window that has already closed would produce a banner the
    // very next read calls expired.
    const early = await patch(`${id}/status`, { status: 'published' });
    expect(early.statusCode).toBe(400);
    expect(early.json().code).toBe('WINDOW_CLOSED');

    // Publish with an open window, then move the end into the past directly:
    // no job runs, and the read must still be right.
    await patch(id, { endsAt: '2099-01-01T00:00:00Z' });
    expect((await patch(`${id}/status`, { status: 'published' })).statusCode).toBe(200);
    expect((await get(`/${id}`)).json().status).toBe('published');

    await db
      .update(schema.banners)
      .set({ endsAt: new Date('2026-02-01T00:00:00Z') })
      .where(eq(schema.banners.id, id));

    const read = await get(`/${id}`);
    expect(read.json().status).toBe('expired');
    // And what a person set is still visible beside it.
    expect(read.json().lifecycleStatus).toBe('published');

    const expiredList = await get('?status=expired');
    expect(expiredList.json().items.map((b: { id: string }) => b.id)).toContain(id);
    const publishedList = await get('?status=published');
    expect(publishedList.json().items.map((b: { id: string }) => b.id)).not.toContain(id);
  });

  it('refuses an inverted window and a scheduled banner with no start', async () => {
    const inverted = await post(
      await valid({ startsAt: '2027-02-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' }),
    );
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().code).toBe('INVALID_SCHEDULE');

    const id = (await post(await valid())).json().id;
    const noStart = await patch(`${id}/status`, { status: 'scheduled' });
    expect(noStart.statusCode).toBe(400);
    expect(noStart.json().code).toBe('SCHEDULE_REQUIRED');
  });

  it('archived is terminal, and the lifecycle refuses undeclared moves', async () => {
    const id = (await post(await valid())).json().id;
    expect((await patch(`${id}/status`, { status: 'published' })).statusCode).toBe(200);
    expect((await patch(`${id}/status`, { status: 'archived' })).statusCode).toBe(200);
    const revive = await patch(`${id}/status`, { status: 'published' });
    expect(revive.statusCode).toBe(409);
    expect(revive.json().code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('filters by placement and pages, and refuses a duplicate name', async () => {
    const marker = `probe-${suffix()}`;
    for (let i = 0; i < 3; i += 1) {
      await post(await valid({ name: `${marker}-${i}`, placement: 'home_secondary' }));
    }
    const filtered = await get(`?q=${marker}&placement=home_secondary`);
    expect(filtered.json().totalCount).toBe(3);
    expect((await get(`?q=${marker}&placement=home_hero`)).json().totalCount).toBe(0);

    const first = await get(`?q=${marker}&limit=2`);
    expect(first.json().items).toHaveLength(2);
    const second = await get(
      `?q=${marker}&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(second.json().items).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();

    const name = `Banner dup ${suffix()}`;
    expect((await post(await valid({ name }))).statusCode).toBe(201);
    const again = await post(await valid({ name }));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('BANNER_NAME_TAKEN');
  });

  it('audits the write, and stays an editorial resource', async () => {
    const id = (await post(await valid())).json().id;
    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=banner&resourceId=${id}`,
      headers: auth(editor.token),
    });
    expect(audit.json().items[0].action).toBe('banner.created');

    expect((await post(await valid(), moderator.token)).statusCode).toBe(403);
    expect((await get('', moderator.token)).statusCode).toBe(200);
  });
});

describe('ops KPIs (CMS-010)', () => {
  it('KPIs endpoint aggregates health metrics (FR-CMS-010)', async () => {
    const ops = await createAdmin('ops4@gogo.local', 'ops_admin');
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/ops/kpis',
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('placeFreshness');
    expect(body).toHaveProperty('zeroResultsLast7d');
    expect(body).toHaveProperty('suggestionRunsLast7d');
    expect(body).toHaveProperty('currentPlansOverBudget');
    expect(body).toHaveProperty('moderationBacklog');
  });
});

describe('place list: filter, sort, cursor paging (BE-IMP-001/002)', () => {
  let editorToken: string;

  beforeAll(async () => {
    editorToken = (await createAdmin('list-editor@gogo.local', 'editor')).token;
    // 25 places, deterministic names/areas; updatedAt spaced so the keyset has
    // a real ordering to walk rather than a pile of identical timestamps.
    for (let i = 0; i < 25; i++) {
      await db.insert(schema.places).values({
        name: `Danh Sách Quán ${String(i).padStart(2, '0')}`,
        nameNormalized: 'set-by-trigger',
        status: i % 5 === 0 ? 'published' : 'draft',
        geom: { x: 106.7 + i / 1000, y: 10.77 + i / 1000 },
        areaKey: i % 2 === 0 ? 'hcm_q1' : 'hcm_q3',
        confidence: '0.50',
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }
  });

  const list = async (query: string) => {
    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places?${query}`,
      remoteAddress: ip(),
      headers: auth(editorToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: { id: string; name: string; status: string; areaKey?: string }[];
      nextCursor: string | null;
    };
  };

  it('walks the whole catalog by cursor without repeating or skipping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list(
        `limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(30);
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length); // no repeats
    const all = await db.select({ id: schema.places.id }).from(schema.places);
    expect(seen.length).toBe(all.length); // no skips
  });

  it('stays stable while rows are being written underneath it', async () => {
    // The whole reason for keyset over offset: an import runs while an editor
    // pages through the table.
    const first = await list('limit=5');
    expect(first.nextCursor).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      await db.insert(schema.places).values({
        name: `Chen Ngang ${i}`,
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.8, y: 10.8 },
        updatedAt: new Date(Date.UTC(2026, 1, 1, 0, i)), // newer than page 1
      });
    }

    const second = await list(`limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`);
    const overlap = second.items.filter((i) => first.items.some((f) => f.id === i.id));
    expect(overlap).toEqual([]);
  });

  it('nextCursor is null on the last page, not a page that comes back empty', async () => {
    const page = await list('limit=200');
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor instead of returning arbitrary rows', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places?cursor=not-a-real-cursor',
      remoteAddress: ip(),
      headers: auth(editorToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CURSOR');
  });

  it('searches without diacritics and matches the consumer-side behaviour', async () => {
    // "danh sach" must find "Danh Sách" — the old query hit `name` and missed.
    const page = await list('q=danh sach quan 03');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.name).toBe('Danh Sách Quán 03');
  });

  it('filters by status and area', async () => {
    const published = await list('status=published&limit=200');
    expect(published.items.every((i) => i.status === 'published')).toBe(true);
    expect(published.items.length).toBeGreaterThan(0);

    const q1 = await list('areaKey=hcm_q1&limit=200');
    expect(q1.items.every((i) => i.areaKey === 'hcm_q1')).toBe(true);
  });

  it('sorts by name ascending using the normalized column', async () => {
    const page = await list('sort=name&direction=asc&limit=200');
    const names = page.items.map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'vi')));
  });

  it('search predicate can be served by the trigram index', async () => {
    // Not "the planner must use it" — on a 30-row test table a seq scan is the
    // correct choice. What matters is that the index *applies* to this
    // predicate at all: querying `name` instead of `name_normalized` made it
    // unusable at any size, which is the regression being guarded.
    // SET LOCAL only lives inside a transaction — outside one it is discarded
    // before the next statement runs.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(
        sql`explain (format json) select p.id from places p
            where p.name_normalized like '%danh sach%'`,
      );
    });
    expect(JSON.stringify(plan.rows)).toContain('places_name_trgm_idx');
  });
});

describe('RBAC: hierarchical read, exact-match write (BE-IMP-008, #143)', () => {
  let editor: { id: string; token: string };
  let moderator: { id: string; token: string };
  let ops: { id: string; token: string };
  let root: { id: string; token: string };
  let placeId: string;

  beforeAll(async () => {
    editor = await createAdmin('rbac-editor@gogo.local', 'editor');
    moderator = await createAdmin('rbac-mod@gogo.local', 'moderator');
    ops = await createAdmin('rbac-ops@gogo.local', 'ops_admin');
    root = await superAdmin();
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'RBAC Place',
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();
    placeId = place!.id;
  });

  const get = (url: string, token: string) =>
    api().inject({ method: 'GET', url, remoteAddress: ip(), headers: auth(token) });

  it('every staff role can READ the catalog, including the one that publishes into it', async () => {
    // The case that motivated this: ops_admin publishes an import, creating
    // places, then could not open the list to see what it had just created.
    for (const t of [editor, moderator, ops, root]) {
      expect((await get('/v1/cms/places?limit=1', t.token)).statusCode).toBe(200);
    }
  });

  it('WRITING the catalog stays with the role that owns it', async () => {
    const patch = (token: string) =>
      api().inject({
        method: 'PATCH',
        url: `/v1/cms/places/${placeId}`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { description: 'edited' },
      });

    expect((await patch(editor.token)).statusCode).toBe(200);
    expect((await patch(root.token)).statusCode).toBe(200);
    // Read access did not become write access.
    expect((await patch(ops.token)).json().code).toBe('ROLE_DENIED');
    expect((await patch(moderator.token)).json().code).toBe('ROLE_DENIED');
  });

  it('reads do not climb: a lower rank still cannot see ops-only data', async () => {
    expect((await get('/v1/cms/ops/kpis', ops.token)).statusCode).toBe(200);
    expect((await get('/v1/cms/ops/kpis', root.token)).statusCode).toBe(200);
    expect((await get('/v1/cms/ops/kpis', editor.token)).json().code).toBe('ROLE_DENIED');
    expect((await get('/v1/cms/ops/kpis', moderator.token)).json().code).toBe('ROLE_DENIED');
  });

  it('peers can read each other: editor sees the moderation queue, moderator sees places', async () => {
    expect((await get('/v1/cms/moderation?limit=1', editor.token)).statusCode).toBe(200);
    expect((await get('/v1/cms/places?limit=1', moderator.token)).statusCode).toBe(200);
  });

  it('moderation decisions stay with moderators', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'rbac-reviewer@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'R',
      },
    });
    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
      payload: { placeId, rating: 4, text: 'rbac target' },
    });
    const decide = (token: string) =>
      api().inject({
        method: 'POST',
        url: `/v1/cms/moderation/reviews/${review.json().id}`,
        remoteAddress: ip(),
        headers: auth(token),
        payload: { decision: 'published', reason: 'nội dung phù hợp' },
      });
    expect((await decide(editor.token)).json().code).toBe('ROLE_DENIED');
    expect((await decide(ops.token)).json().code).toBe('ROLE_DENIED');
    expect([200, 201]).toContain((await decide(moderator.token)).statusCode);
  });

  it('a suspended admin loses read access too, not just write', async () => {
    const victim = await createAdmin('rbac-suspended@gogo.local', 'ops_admin');
    expect((await get('/v1/cms/places?limit=1', victim.token)).statusCode).toBe(200);
    await db
      .update(schema.adminUsers)
      .set({ status: 'suspended' })
      .where(eq(schema.adminUsers.id, victim.id));
    expect((await get('/v1/cms/places?limit=1', victim.token)).json().code).toBe('ADMIN_ONLY');
  });
});

describe('audit request context (BE-IMP-007)', () => {
  it('records request id and staff IP for an admin write', async () => {
    const editor = await createAdmin('audit-ctx@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Audit Ctx Place',
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();

    const res = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}`,
      remoteAddress: '10.99.0.7',
      headers: auth(editor.token),
      payload: { description: 'audit context' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place!.id));
    expect(row!.actorId).toBe(editor.id);
    // Both used to be lost: request_id was declared and never written, and the
    // IP had nowhere to go at all.
    expect(row!.requestId).toBe(res.headers['x-request-id']);
    expect(row!.ipAddress).toBe('10.99.0.7');
  });

  it('does not record an IP for a non-admin actor', async () => {
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: '10.99.0.8',
      payload: {
        email: 'audit-user@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'U',
      },
    });
    const del = await api().inject({
      method: 'DELETE',
      url: '/v1/me',
      remoteAddress: '10.99.0.8',
      headers: auth(reg.json().accessToken),
    });
    expect([200, 202, 204]).toContain(del.statusCode);

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.actorType, 'user'));
    // Staff accountability justifies keeping an IP; it does not extend to users.
    expect(rows.every((r) => r.ipAddress === null)).toBe(true);
  });
});

describe('SEC-001 emergency takedown (break-glass)', () => {
  const takedown = (token: string, url: string, reason = 'nội dung vi phạm nghiêm trọng') =>
    api().inject({
      method: 'POST',
      url,
      remoteAddress: ip(),
      headers: auth(token),
      payload: { reason },
    });

  async function publishedPlace(name: string) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'set-by-trigger',
        status: 'published',
        geom: { x: 106.7009, y: 10.7769 },
        areaKey: 'hcm_q1',
      })
      .returning();
    return place!;
  }

  it('every admin role can take a place down — the point is whoever is awake', async () => {
    for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
      // The environment's one `super_admin` is shared rather than created here.
      const admin =
        role === 'super_admin'
          ? await superAdmin()
          : await createAdmin(`bg-${role}@gogo.local`, role);
      const place = await publishedPlace(`Break Glass ${role}`);
      const res = await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('suspended');
    }
  });

  it('the place actually leaves discovery, not just the database row', async () => {
    // The success condition is "gone from discovery". Today search reads status
    // live from Postgres so this holds automatically — this test is what turns
    // red the day an external index lands (SE-009) and a takedown would
    // otherwise silently stop working.
    const admin = await createAdmin('bg-discovery@gogo.local', 'editor');
    const place = await publishedPlace('Break Glass Discovery Quán');

    const before = await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=Break Glass Discovery&lat=10.7769&lng=106.7009&radiusM=5000',
      remoteAddress: ip(),
    });
    expect(before.json().results.some((i: { id: string }) => i.id === place.id)).toBe(true);

    await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);

    const after = await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=Break Glass Discovery&lat=10.7769&lng=106.7009&radiusM=5000',
      remoteAddress: ip(),
    });
    expect(after.json().results.some((i: { id: string }) => i.id === place.id)).toBe(false);
  });

  it('records who, from where, why, and what changed', async () => {
    const admin = await createAdmin('bg-audit@gogo.local', 'moderator');
    const place = await publishedPlace('Break Glass Audit');
    const res = await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: '10.77.0.9',
      headers: auth(admin.token),
      payload: { reason: 'ảnh vi phạm, gỡ khẩn cấp' },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place.id));
    expect(row!.action).toBe('place.emergency_suspended');
    expect(row!.actorId).toBe(admin.id);
    expect(row!.ipAddress).toBe('10.77.0.9');
    expect(row!.requestId).toBe(res.headers['x-request-id']);
    expect(row!.diff).toMatchObject({
      breakGlass: true,
      role: 'moderator',
      reason: 'ảnh vi phạm, gỡ khẩn cấp',
      before: { status: 'published' },
      after: { status: 'suspended' },
    });
  });

  it('taking down does not grant putting back up', async () => {
    // The asymmetry is the whole design: an ops_admin can suspend a place but
    // still cannot restore or edit it.
    const ops = await createAdmin('bg-asym@gogo.local', 'ops_admin');
    const place = await publishedPlace('Break Glass Asymmetry');
    expect(
      (await takedown(ops.token, `/v1/cms/emergency/places/${place.id}/suspend`)).statusCode,
    ).toBe(201);

    const restore = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place.id}/status`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { status: 'published' },
    });
    expect(restore.json().code).toBe('ROLE_DENIED');
  });

  it('refuses a reason that explains nothing, and a state it does not apply to', async () => {
    const admin = await createAdmin('bg-guard@gogo.local', 'editor');
    const place = await publishedPlace('Break Glass Guard');

    const noReason = await takedown(
      admin.token,
      `/v1/cms/emergency/places/${place.id}/suspend`,
      'x',
    );
    expect(noReason.statusCode).toBe(400);

    expect(
      (await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`)).statusCode,
    ).toBe(201);
    // Already suspended: break-glass covers exactly one transition.
    const again = await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('NOT_TAKEDOWNABLE');
  });

  it('burst limit stops a scripted run that the hourly cap alone would allow', async () => {
    const admin = await createAdmin('bg-burst@gogo.local', 'editor');
    const places = [];
    for (let i = 0; i < 8; i++) places.push(await publishedPlace(`Break Glass Burst ${i}`));

    let limited = false;
    for (const place of places) {
      const res = await takedown(admin.token, `/v1/cms/emergency/places/${place.id}/suspend`);
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    // 5/minute: a human working an incident never reaches this; a script does.
    expect(limited).toBe(true);
  });

  it('hides a published review, keeping it distinct from a moderator verdict', async () => {
    const admin = await createAdmin('bg-review@gogo.local', 'ops_admin');
    const place = await publishedPlace('Break Glass Review Target');
    const reg = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'bg-reviewer@gogo.id.vn',
        password: 'sufficiently-long-pw',
        displayName: 'R',
      },
    });
    const review = await api().inject({
      method: 'POST',
      url: '/v1/reviews',
      remoteAddress: ip(),
      headers: auth(reg.json().accessToken),
      payload: { placeId: place.id, rating: 4, text: 'break glass target' },
    });
    await db
      .update(schema.reviews)
      .set({ status: 'published' })
      .where(eq(schema.reviews.id, review.json().id));

    const res = await takedown(admin.token, `/v1/cms/emergency/reviews/${review.json().id}/hide`);
    expect(res.statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, review.json().id));
    // Not `rejected`/`removed`: those are quality verdicts, this is a takedown.
    expect(row!.status).toBe('hidden');
  });
});

describe('SEC-002 part A: which rule authorized the write', () => {
  it('tells a super_admin bypass apart from a write it was entitled to', async () => {
    const root = await superAdmin();
    const editor = await createAdmin('authz-editor@gogo.local', 'editor');
    const [place] = await db
      .insert(schema.places)
      .values({
        name: 'Authz Path Place',
        nameNormalized: 'set-by-trigger',
        status: 'draft',
        geom: { x: 106.7, y: 10.77 },
      })
      .returning();

    // The editor owns catalog writes: this is the model working as designed.
    const byEditor = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { description: 'by the role that owns it' },
    });
    expect(byEditor.statusCode).toBe(200);

    // super_admin writing the same route would have been refused for any other
    // role — that is the escape hatch, and it must be visible as such.
    const byRoot = await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place!.id}`,
      remoteAddress: ip(),
      headers: auth(root.token),
      payload: { description: 'through the hatch' },
    });
    expect(byRoot.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, place!.id));
    const paths = new Map(rows.map((r) => [r.actorId, r.authorizationPath]));
    expect(paths.get(editor.id)).toBe('exact_role');
    expect(paths.get(root.id)).toBe('super_admin_bypass');
  });

  it('answers "how often was the hatch used" with plain SQL, no metrics backend', async () => {
    const bypasses = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.authorizationPath, 'super_admin_bypass'));
    expect(bypasses[0]!.n).toBeGreaterThan(0);
  });
});

describe('SEC-003 admin session model', () => {
  async function login(email: string, role: 'editor' | 'ops_admin' = 'editor') {
    const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
    await db.insert(schema.adminUsers).values({ email, passwordHash, displayName: 'A', role });
    return api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders(email),
      payload: { email, password: 'admin-password-123' },
    });
  }

  type SetCookie = { name: string; value: string; httpOnly?: boolean; path?: string };
  const cookie = (res: { cookies: unknown[] }, name: string) =>
    (res.cookies as SetCookie[]).find((c) => c.name === name);

  it('opens a session on a cookie, not on something the client must store', async () => {
    const res = await login('sess-cookie@gogo.local');
    expect(res.statusCode).toBe(201);

    const access = cookie(res, 'gogo_at');
    const refresh = cookie(res, 'gogo_rt');
    const csrf = cookie(res, 'gogo_csrf');
    expect(access?.httpOnly).toBe(true);
    expect(refresh?.httpOnly).toBe(true);
    // Scoped to the endpoint that consumes it, so it never rides along on
    // ordinary CMS requests.
    expect(refresh?.path).toBe('/v1/cms/auth/refresh');
    // The double-submit token has to be readable by JS — that is the point.
    expect(csrf?.httpOnly).toBeFalsy();
  });

  it('the session outlives the access token, and is shorter than a consumer one', async () => {
    const res = await login('sess-ttl@gogo.local');
    const body = res.json();
    // The whole reason this exists: 15 minutes was a hard logout mid-edit.
    expect(body.refreshExpiresIn).toBeGreaterThan(body.expiresIn);
    // Security rule: CMS sessions expire sooner than the consumer app's 30 days.
    expect(body.refreshExpiresIn).toBeLessThan(30 * 24 * 3600);
  });

  it('rotates on refresh and treats reuse of the old token as theft', async () => {
    const res = await login('sess-rotate@gogo.local');
    const first = res.json().refreshToken;

    const rotated = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/refresh',
      remoteAddress: ip(),
      payload: { refreshToken: first },
    });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.json().refreshToken).not.toBe(first);

    // Replaying the superseded token revokes the family, not just this call.
    const replay = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/refresh',
      remoteAddress: ip(),
      payload: { refreshToken: first },
    });
    expect(replay.json().code).toBe('SESSION_REVOKED');

    const afterTheft = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/refresh',
      remoteAddress: ip(),
      payload: { refreshToken: rotated.json().refreshToken },
    });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('logout kills the access token immediately, not at expiry', async () => {
    const res = await login('sess-logout@gogo.local');
    const token = res.json().accessToken;
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/v1/cms/places?limit=1',
          remoteAddress: ip(),
          headers: auth(token),
        })
      ).statusCode,
    ).toBe(200);

    await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/logout',
      remoteAddress: ip(),
      headers: auth(token),
      payload: {},
    });

    // Same guarantee as #129 for consumer sessions: revoked means revoked now.
    const after = await api().inject({
      method: 'GET',
      url: '/v1/cms/places?limit=1',
      remoteAddress: ip(),
      headers: auth(token),
    });
    expect(after.json().code).toBe('SESSION_REVOKED');
  });

  it('logging out one device leaves the other signed in', async () => {
    const first = await login('sess-two@gogo.local');
    const second = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/login',
      remoteAddress: ip(),
      headers: cmsAccessHeaders('sess-two@gogo.local'),
      payload: { email: 'sess-two@gogo.local', password: 'admin-password-123' },
    });

    await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/logout',
      remoteAddress: ip(),
      headers: auth(first.json().accessToken),
      payload: {},
    });

    // Each login is its own session row — that is what `sid = admin.id` made
    // impossible before.
    const other = await api().inject({
      method: 'GET',
      url: '/v1/cms/places?limit=1',
      remoteAddress: ip(),
      headers: auth(second.json().accessToken),
    });
    expect(other.statusCode).toBe(200);
  });

  it('a suspended admin cannot refresh their way onward', async () => {
    const res = await login('sess-suspended@gogo.local');
    await db
      .update(schema.adminUsers)
      .set({ status: 'suspended' })
      .where(eq(schema.adminUsers.email, 'sess-suspended@gogo.local'));

    const refreshed = await api().inject({
      method: 'POST',
      url: '/v1/cms/auth/refresh',
      remoteAddress: ip(),
      payload: { refreshToken: res.json().refreshToken },
    });
    expect(refreshed.statusCode).toBe(403);
  });
});

/**
 * BE-IMP-009/010 (#157–#161) — the CMS could write these records but not read
 * them back. Every assertion below is about the read half specifically: that
 * it returns what the editor form needs, and that reading does not widen who
 * can see what.
 */
describe('CMS read endpoints', () => {
  async function seedPlace(name: string) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'set-by-trigger',
        status: 'published',
        geom: { x: 106.7009, y: 10.7769 },
        areaKey: 'hcm_q1',
        rating: '4.60',
        ratingCount: 812,
        priceLevel: 2,
        avgVisitMinutes: 75,
      })
      .returning();
    return place!;
  }

  it('the place detail carries what the editor form needs, typed', async () => {
    const admin = await createAdmin('read-detail@gogo.local', 'editor');
    const place = await seedPlace('Detail Read Cafe');
    await db.insert(schema.placeHours).values({
      placeId: place.id,
      dayOfWeek: 1,
      openMinute: 480,
      closeMinute: 1320,
      source: 'editor',
    });
    await db.insert(schema.placePrices).values({
      placeId: place.id,
      priceMin: 50000,
      priceMax: 120000,
      currency: 'VND',
      unit: 'per_person',
      source: 'editor',
    });

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${place.id}`,
      remoteAddress: ip(),
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Numbers as numbers: `numeric` and PostGIS columns come back as strings
    // from the driver, and a form binding a string to a number input silently
    // misbehaves rather than failing.
    expect(typeof body.lat).toBe('number');
    expect(typeof body.confidence).toBe('number');
    expect(body.hours).toHaveLength(1);
    expect(body.prices[0].priceMin).toBe(50000);
    expect(typeof body.prices[0].priceMin).toBe('number');
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the provider rating and GoGo’s own apart instead of blending them', async () => {
    const admin = await createAdmin('read-ratings@gogo.local', 'editor');
    const place = await seedPlace('Ratings Read Cafe');

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${place.id}`,
      remoteAddress: ip(),
      headers: auth(admin.token),
    });
    const { ratings } = res.json();
    expect(ratings.provider).toEqual({ rating: 4.6, count: 812 });
    // No published reviews yet — an empty GoGo rating is absent, not zero.
    expect(ratings.gogo.count).toBe(0);
    expect(ratings.gogo.rating).toBeUndefined();
    expect(res.json().rating).toBeUndefined();
  });

  it('404s on an unknown place rather than returning an empty record', async () => {
    const admin = await createAdmin('read-missing@gogo.local', 'editor');
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/places/00000000-0000-4000-8000-000000000000',
      remoteAddress: ip(),
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists inactive taxonomy keys too — the CMS is where one is reactivated', async () => {
    const admin = await createAdmin('read-taxonomy@gogo.local', 'editor');
    await db.insert(schema.taxonomies).values([
      { kind: 'mood', key: 'read_active_mood', isActive: true },
      { kind: 'mood', key: 'read_inactive_mood', isActive: false },
    ]);

    const all = await api().inject({
      method: 'GET',
      url: '/v1/cms/taxonomies?kind=mood',
      remoteAddress: ip(),
      headers: auth(admin.token),
    });
    expect(all.statusCode).toBe(200);
    const keys = all.json().map((t: { key: string }) => t.key);
    expect(keys).toContain('read_active_mood');
    expect(keys).toContain('read_inactive_mood');

    const activeOnly = await api().inject({
      method: 'GET',
      url: '/v1/cms/taxonomies?kind=mood&isActive=true',
      remoteAddress: ip(),
      headers: auth(admin.token),
    });
    expect(activeOnly.json().map((t: { key: string }) => t.key)).not.toContain(
      'read_inactive_mood',
    );
  });

  it('reads a collection back in the order it was written', async () => {
    const admin = await createAdmin('read-collection@gogo.local', 'editor');
    const first = await seedPlace('Collection Read One');
    const second = await seedPlace('Collection Read Two');
    const [collection] = await db
      .insert(schema.contentCollections)
      .values({ slug: 'read-collection', title: 'Read Collection', createdByAdminId: admin.id })
      .returning();

    await api().inject({
      method: 'PUT',
      url: `/v1/cms/collections/${collection!.id}/items`,
      remoteAddress: ip(),
      headers: auth(admin.token),
      payload: { placeIds: [second.id, first.id] },
    });

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/collections/${collection!.id}/items`,
      remoteAddress: ip(),
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { placeId: string }) => i.placeId)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it('ranking configs come back with drafter and approver, so four-eyes is checkable', async () => {
    const ops = await createAdmin('read-ranking-ops@gogo.local', 'ops_admin');
    const other = await createAdmin('read-ranking-two@gogo.local', 'ops_admin');
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { key: 'search.ranking', weights: { distance: 0.5, rating: 0.5 } },
    });
    const configId = created.json().id as string;
    await api().inject({
      method: 'POST',
      url: `/v1/cms/ranking-configs/${configId}/approve`,
      remoteAddress: ip(),
      headers: auth(other.token),
    });

    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/ranking-configs?key=search.ranking',
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().find((c: { id: string }) => c.id === configId);
    expect(row.createdBy.id).toBe(ops.id);
    expect(row.approvedBy.id).toBe(other.id);
    expect(row.createdBy.id).not.toBe(row.approvedBy.id);
    expect(row.bounds).toBeTruthy();
  });

  it('feature flags are readable — a kill switch nobody can read is not one', async () => {
    const ops = await createAdmin('read-flags@gogo.local', 'ops_admin');
    await api().inject({
      method: 'PUT',
      url: '/v1/cms/feature-flags/feature_ai_recommendation',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { enabled: false },
    });

    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/feature-flags',
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const flag = res.json().find((f: { key: string }) => f.key === 'feature_ai_recommendation');
    expect(flag.enabled).toBe(false);
    expect(flag.updatedBy.id).toBe(ops.id);
  });
});

/**
 * BE-CMS-G3 (#221) — typed application flags. The contract was
 * `enabled: boolean` plus an opaque `payload`, so a version, a limit and an
 * iOS-only switch all had to be smuggled through the same field.
 */
describe('typed app flags (BE-CMS-G3 #221)', () => {
  let opsToken: string;
  let opsId: string;

  beforeAll(async () => {
    const ops = await createAdmin('flags221@gogo.local', 'ops_admin');
    opsToken = ops.token;
    opsId = ops.id;
  });

  const put = (key: string, payload: unknown, token = opsToken) =>
    api().inject({
      method: 'PUT',
      url: `/v1/cms/feature-flags/${key}`,
      remoteAddress: ip(),
      headers: auth(token),
      payload: payload as object,
    });
  const get = (qs = '', token = opsToken) =>
    api().inject({ method: 'GET', url: `/v1/cms/feature-flags${qs}`, headers: auth(token) });

  it('publishes a catalog of keys with their type and default', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/feature-flags/catalog',
      headers: auth(opsToken),
    });
    expect(res.statusCode).toBe(200);
    const byKey = Object.fromEntries(res.json().map((d: { key: string }) => [d.key, d])) as Record<
      string,
      { valueType: string; defaultValue: unknown; platformScoped: boolean }
    >;

    expect(byKey['minimum_app_version']).toMatchObject({
      valueType: 'version',
      platformScoped: true,
    });
    expect(byKey['recommendation_limit']).toMatchObject({ valueType: 'number', defaultValue: 20 });
    // A default is never null: "not configured" has to be distinguishable from
    // a value of zero or false.
    for (const definition of res.json()) expect(definition.defaultValue).not.toBeNull();
  });

  it('refuses a key nothing reads, rather than storing a value with no reader', async () => {
    const res = await put('marketing.banner.color', { enabled: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLAG_UNKNOWN');
  });

  it('validates the value against the declared type at the API, not in the client', async () => {
    const badVersion = await put('minimum_app_version', { enabled: true, value: 'v2.1' });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().code).toBe('INVALID_FLAG_VALUE');
    expect(badVersion.json().field_errors[0].field).toBe('value');

    const badNumber = await put('recommendation_limit', { enabled: true, value: '25' });
    expect(badNumber.statusCode).toBe(400);

    const badJson = await put('place_import.rules', { enabled: true, value: 'nope' });
    expect(badJson.statusCode).toBe(400);

    const good = await put('minimum_app_version', { enabled: true, value: '2.1.0' });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ valueType: 'version', value: '2.1.0', environment: 'all' });
  });

  it('a boolean flag is set through `enabled` and carries no second value', async () => {
    const withValue = await put('maintenance_mode', { enabled: true, value: true });
    expect(withValue.statusCode).toBe(400);

    const ok = await put('maintenance_mode', { enabled: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ valueType: 'boolean', enabled: true, value: true });
  });

  it('refuses a platform override on a key that has no per-platform form', async () => {
    const res = await put('recommendation_limit', { enabled: true, value: 30, platform: 'ios' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FLAG_NOT_PLATFORM_SCOPED');
  });

  it('stores one row per (key, environment, platform) instead of one per key', async () => {
    expect((await put('minimum_app_version', { enabled: true, value: '2.0.0' })).statusCode).toBe(
      200,
    );
    expect(
      (
        await put('minimum_app_version', {
          enabled: true,
          value: '2.5.0',
          environment: 'production',
          platform: 'ios',
        })
      ).statusCode,
    ).toBe(200);

    const all = (await get()).json() as { key: string; environment: string; platform: string }[];
    const rows = all.filter((f) => f.key === 'minimum_app_version');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.environment}/${r.platform}`).sort()).toEqual([
      'all/all',
      'production/ios',
    ]);

    const scoped = (await get('?environment=production&platform=ios')).json() as {
      key: string;
      value: unknown;
    }[];
    expect(scoped.find((f) => f.key === 'minimum_app_version')?.value).toBe('2.5.0');
  });

  it('keeps `payload` working for the console that already ships against it', async () => {
    const res = await put('place_import.rules', { enabled: true, payload: { minReviews: 4 } });
    expect(res.statusCode).toBe(200);

    const listed = (await get()).json() as { key: string; value: unknown; payload: unknown }[];
    const rules = listed.find((f) => f.key === 'place_import.rules');
    expect(rules?.value).toEqual({ minReviews: 4 });
    expect(rules?.payload).toEqual({ minReviews: 4 });

    // Two names for one field must not be able to say different things.
    const conflicting = await put('place_import.rules', {
      enabled: true,
      value: { minReviews: 4 },
      payload: { minReviews: 9 },
    });
    expect(conflicting.statusCode).toBe(400);
  });

  it('audits the change with before and after, not just who touched it', async () => {
    await put('feature_group_planning', { enabled: false });
    await put('feature_group_planning', { enabled: true });

    const audit = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?actorId=${opsId}&action=feature_flag.set&resourceId=feature_group_planning&limit=1`,
      headers: auth(opsToken),
    });
    expect(audit.statusCode).toBe(200);
    const diff = audit.json().items[0].diff;
    expect(diff.before).toMatchObject({ enabled: false });
    expect(diff.after).toMatchObject({ enabled: true });
    expect(diff.environment).toBe('all');
  });

  it('the import kill switch still reads the flag it always read', async () => {
    // #221 changed the primary key underneath this reader; the behaviour it
    // gates must not have moved with it.
    await put('place_import.autopublish', { enabled: false });
    const off = await resolveImportAutoPublish();
    expect(off).toBe(false);

    await put('place_import.autopublish', { enabled: true });
    expect(await resolveImportAutoPublish()).toBe(true);

    // A more specific row for another environment must not leak into this one.
    await put('place_import.autopublish', { enabled: false, environment: 'production' });
    expect(await resolveImportAutoPublish()).toBe(true);
  });

  async function resolveImportAutoPublish(): Promise<boolean> {
    const { resolveFlag } = await import('../../../libs/modules/shared/feature-flags.js');
    const resolved = await resolveFlag(db, 'place_import.autopublish', { environment: 'dev' });
    return resolved.enabled;
  }

  it('stays an ops_admin write, and is never a place for a secret', async () => {
    const editor = await createAdmin('flags221-editor@gogo.local', 'editor');
    expect((await put('maintenance_mode', { enabled: true }, editor.token)).statusCode).toBe(403);
    // Reads do not climb (BE-IMP-008): the flag console stays ops-only, both
    // ways, and #221 does not widen who can see it.
    expect((await get('', editor.token)).statusCode).toBe(403);
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/v1/cms/feature-flags/catalog',
          headers: auth(editor.token),
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('audit read (BE-IMP-010, #158, FR-CMS-008)', () => {
  async function suspendablePlace(name: string) {
    const [place] = await db
      .insert(schema.places)
      .values({
        name,
        nameNormalized: 'set-by-trigger',
        status: 'published',
        geom: { x: 106.7009, y: 10.7769 },
      })
      .returning();
    return place!;
  }

  it('answers “who suspended this place and why” without a database', async () => {
    const editor = await createAdmin('audit-actor@gogo.local', 'editor');
    const place = await suspendablePlace('Audit History Cafe');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { reason: 'Reported for a health violation, taking it down pending review' },
    });

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/places/${place.id}/audit`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json().items[0];
    expect(entry.action).toBe('place.emergency_suspended');
    expect(entry.actorId).toBe(editor.id);
    expect(entry.actorRole).toBe('editor');
    expect(entry.reason).toContain('health violation');
    expect(entry.breakGlass).toBe(true);
    expect(entry.diff.before.status).toBe('published');
    expect(entry.diff.after.status).toBe('suspended');
    expect(entry.requestId).toBeTruthy();
  });

  it('breakGlass=true returns takedowns only, not every write on the resource', async () => {
    const editor = await createAdmin('audit-filter@gogo.local', 'editor');
    const place = await suspendablePlace('Audit Filter Cafe');
    await api().inject({
      method: 'PATCH',
      url: `/v1/cms/places/${place.id}`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { name: 'Audit Filter Cafe Renamed' },
    });
    await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: ip(),
      headers: auth(editor.token),
      payload: { reason: 'Emergency takedown for the audit filter test' },
    });

    const all = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=place&resourceId=${place.id}`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(all.json().items.length).toBeGreaterThanOrEqual(2);

    const glass = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=place&resourceId=${place.id}&breakGlass=true`,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    const actions = glass.json().items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['place.emergency_suspended']);
  });

  it('shows the staff IP to ops_admin and withholds it from an editor', async () => {
    const ops = await createAdmin('audit-ip-ops@gogo.local', 'ops_admin');
    const editor = await createAdmin('audit-ip-editor@gogo.local', 'editor');
    const place = await suspendablePlace('Audit IP Cafe');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { reason: 'Takedown used to check who may see the staff IP' },
    });

    const url = `/v1/cms/audit?resourceType=place&resourceId=${place.id}`;
    const asOps = await api().inject({
      method: 'GET',
      url,
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(asOps.json().items[0].ipAddress).toBeTruthy();

    // The editor still reads the history — only the PII inside it is narrower.
    const asEditor = await api().inject({
      method: 'GET',
      url,
      remoteAddress: ip(),
      headers: auth(editor.token),
    });
    expect(asEditor.statusCode).toBe(200);
    expect(asEditor.json().items[0].action).toBe('place.emergency_suspended');
    expect(asEditor.json().items[0].ipAddress).toBeUndefined();
  });

  it('returns occurredAt as RFC 3339 date-time in UTC (#443)', async () => {
    const ops = await createAdmin('audit-iso@gogo.local', 'ops_admin');
    const place = await suspendablePlace('Audit ISO Cafe');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { reason: 'Takedown used to check the audit timestamp format' },
    });

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=place&resourceId=${place.id}&limit=1`,
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json().items[0] as { id: string; occurredAt: string };
    // The raw query hands created_at back as the Postgres text form
    // ("2026-09-06 11:16:24.599968+00"): a space for the `T` and a `+00`
    // offset, neither of which `format: date-time` accepts.
    expect(entry.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    // Same instant as the stored row, to the millisecond a JS Date carries.
    const stored = await db.execute(
      sql`select floor(extract(epoch from created_at) * 1000)::text as ms
          from audit_logs where id = ${entry.id}::uuid`,
    );
    expect(Date.parse(entry.occurredAt)).toBe(Number((stored.rows[0] as { ms: string }).ms));
  });

  it('pages by cursor without repeating a row, newest first', async () => {
    const ops = await createAdmin('audit-page@gogo.local', 'ops_admin');
    // Five distinct registry keys: #221 closed the key space, so an audit
    // trail of five writes needs five keys something actually reads.
    for (const key of [
      'maintenance_mode',
      'feature_group_planning',
      'feature_ai_recommendation',
      'place_import.autopublish',
      'minimum_app_version',
    ]) {
      await api().inject({
        method: 'PUT',
        url: `/v1/cms/feature-flags/${key}`,
        remoteAddress: ip(),
        headers: auth(ops.token),
        payload:
          key === 'minimum_app_version' ? { enabled: true, value: '2.1.0' } : { enabled: true },
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      // Filtered by action as well as actor: logging in is itself audited, so
      // "everything this admin did" is not the same count as "the writes made".
      const url =
        `/v1/cms/audit?actorId=${ops.id}&action=feature_flag.set&limit=2` +
        `${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await api().inject({
        method: 'GET',
        url,
        remoteAddress: ip(),
        headers: auth(ops.token),
      });
      const body = res.json() as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...body.items.map((e) => e.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('is read-only: there is no route that edits or deletes an entry', async () => {
    const boss = await superAdmin();
    const place = await suspendablePlace('Audit Immutable Cafe');
    await api().inject({
      method: 'POST',
      url: `/v1/cms/emergency/places/${place.id}/suspend`,
      remoteAddress: ip(),
      headers: auth(boss.token),
      payload: { reason: 'Takedown that must remain in the log afterwards' },
    });
    const listed = await api().inject({
      method: 'GET',
      url: `/v1/cms/audit?resourceType=place&resourceId=${place.id}`,
      remoteAddress: ip(),
      headers: auth(boss.token),
    });
    const entryId = listed.json().items[0].id as string;

    // Not even super_admin: the log is immutable, so these routes do not exist.
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const res = await api().inject({
        method,
        url: `/v1/cms/audit/${entryId}`,
        remoteAddress: ip(),
        headers: auth(boss.token),
        payload: { action: 'tampered' },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

/**
 * SG-010 (#49) — A/B assignment, offline evaluation, and the kill switch. The
 * acceptance is "version audit + kill switch", and both are asserted here
 * against the real endpoints rather than the units underneath.
 */
describe('experiments and offline evaluation', () => {
  async function opsAdmin(email: string) {
    return createAdmin(email, 'ops_admin');
  }

  it('records who changed an experiment and what the split was', async () => {
    const ops = await opsAdmin('exp-audit@gogo.local');
    const res = await api().inject({
      method: 'PUT',
      url: '/v1/cms/experiments/suggestion.ranking',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { enabled: true, variants: { '7': 0.5 }, description: 'try v7 weights' },
    });
    expect(res.statusCode).toBe(200);

    const audit = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, 'suggestion.ranking'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('experiment.created');
    expect(audit[0]!.actorId).toBe(ops.id);
    // The audit is the version record: what the split was, from when.
    expect(
      (audit[0]!.diff as { after: { variants: Record<string, number> } }).after.variants,
    ).toEqual({ '7': 0.5 });
  });

  it('refuses a split that allocates more than everyone', async () => {
    const ops = await opsAdmin('exp-overalloc@gogo.local');
    const res = await api().inject({
      method: 'PUT',
      url: '/v1/cms/experiments/over.allocated',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { enabled: true, variants: { a: 0.7, b: 0.6 } },
    });
    // Silently dropping whichever variant sorted last is the kind of quiet
    // miscount an experiment cannot survive.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VARIANT_SHARES_EXCEED_ONE');
  });

  it('reports the control share rather than making ops compute it', async () => {
    const ops = await opsAdmin('exp-control@gogo.local');
    await api().inject({
      method: 'PUT',
      url: '/v1/cms/experiments/partial.split',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { enabled: true, variants: { a: 0.1, b: 0.2 } },
    });
    const list = await api().inject({
      method: 'GET',
      url: '/v1/cms/experiments',
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    const row = list.json().find((e: { key: string }) => e.key === 'partial.split');
    expect(row.controlShare).toBeCloseTo(0.7, 4);
  });

  it('switching an experiment off is a normal write, not a deploy', async () => {
    const ops = await opsAdmin('exp-killswitch@gogo.local');
    const url = '/v1/cms/experiments/kill.switch';
    await api().inject({
      method: 'PUT',
      url,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { enabled: true, variants: { a: 1 } },
    });
    const off = await api().inject({
      method: 'PUT',
      url,
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { enabled: false, variants: { a: 1 } },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);

    // The definition survives being switched off: history is not deleted.
    const list = await api().inject({
      method: 'GET',
      url: '/v1/cms/experiments',
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(list.json().find((e: { key: string }) => e.key === 'kill.switch').variants).toEqual({
      a: 1,
    });
  });

  it('evaluates a candidate config without writing anything', async () => {
    const ops = await opsAdmin('exp-evaluate@gogo.local');
    const created = await api().inject({
      method: 'POST',
      url: '/v1/cms/ranking-configs',
      remoteAddress: ip(),
      headers: auth(ops.token),
      payload: { key: 'suggestion.scoring', weights: { distance: 0.2, quality: 0.25 } },
    });
    expect(created.statusCode).toBe(201);
    const configId = created.json().id as string;

    const runsBefore = await db.execute(sql`select count(*)::int as n from suggestion_runs`);
    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/ranking-configs/${configId}/evaluate?sampleSize=10`,
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configVersion).toBeGreaterThan(0);
    expect(body.metrics).toHaveProperty('top1Agreement');
    expect(body.metrics).toHaveProperty('newZeroResults');

    const runsAfter = await db.execute(sql`select count(*)::int as n from suggestion_runs`);
    // Offline in the strict sense: no run, no plan, no user.
    expect((runsAfter.rows[0] as { n: number }).n).toBe((runsBefore.rows[0] as { n: number }).n);
  });

  it('refuses to evaluate weights the engine would itself reject', async () => {
    const ops = await opsAdmin('exp-bounds@gogo.local');
    // Written straight to the table: the create endpoint enforces bounds, and
    // the point here is that evaluation does not trust the row either.
    const [config] = await db
      .insert(schema.rankingConfigs)
      .values({
        key: 'suggestion.scoring',
        version: 9_001,
        status: 'draft',
        weights: { distance: 99 },
        bounds: {},
        createdByAdminId: ops.id,
      })
      .returning();

    const res = await api().inject({
      method: 'GET',
      url: `/v1/cms/ranking-configs/${config!.id}/evaluate`,
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    // Any number produced from out-of-bounds weights would describe a config
    // the engine would have refused anyway.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('WEIGHTS_OUT_OF_BOUNDS');
  });

  it('404s on a config that does not exist', async () => {
    const ops = await opsAdmin('exp-missing@gogo.local');
    const res = await api().inject({
      method: 'GET',
      url: '/v1/cms/ranking-configs/00000000-0000-4000-8000-000000000000/evaluate',
      remoteAddress: ip(),
      headers: auth(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * ADM-009 (#462) — the smallest administrative dataset an approval can be
 * validated against: one published version, one current province, one current
 * commune under it. Deliberately not the pinned import, which would put a
 * 14,000-row parse into a CMS flow test to prove one status transition.
 */
async function seedAdministrativeMapping(): Promise<{ datasetVersion: string }> {
  const datasetVersion = 'cms-test-dataset';
  const existing = await db
    .select({ id: schema.administrativeDatasetVersions.id })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.combinedDatasetVersion, datasetVersion));
  if (existing.length > 0) return { datasetVersion };

  const [dataset] = await db
    .insert(schema.administrativeDatasetVersions)
    .values({
      combinedDatasetVersion: datasetVersion,
      combinedChecksum: 'cms-test-checksum',
      currentSourceVersion: 'test',
      source: 'test',
      effectiveDate: '2025-07-01',
      status: 'PUBLISHED',
      publishedAt: new Date(),
    })
    .returning();

  await db.insert(schema.administrativeUnits).values([
    {
      datasetVersionId: dataset!.id,
      code: '79',
      name: 'Hồ Chí Minh',
      fullName: 'Thành phố Hồ Chí Minh',
      nameNormalized: 'ho chi minh',
      fullNameNormalized: 'thanh pho ho chi minh',
      unitType: 'MUNICIPALITY',
      level: 'PROVINCE',
      status: 'ACTIVE',
      effectiveFrom: '2025-07-01',
      source: 'test',
      sourceVersion: 'test',
    },
    {
      datasetVersionId: dataset!.id,
      code: '26734',
      name: 'Sài Gòn',
      fullName: 'Phường Sài Gòn',
      nameNormalized: 'sai gon',
      fullNameNormalized: 'phuong sai gon',
      unitType: 'WARD',
      level: 'COMMUNE',
      parentCode: '79',
      status: 'ACTIVE',
      effectiveFrom: '2025-07-01',
      source: 'test',
      sourceVersion: 'test',
    },
  ]);
  return { datasetVersion };
}

/**
 * GoGo-BE#604 — owner decision (c): until the app can open them, a campaign may
 * not newly point at `recommendation`, `plan_template` or `external_url`. The
 * contract enum is unchanged; the API refuses with 422 `INVALID_DESTINATION`.
 * A row that already holds one stays readable and editable in every other
 * field, and the dispatcher never sends it to a Home screen the operator did not
 * choose.
 */
describe('campaigns cannot newly target a destination the app cannot open (#604)', () => {
  let ops: { id: string; token: string };
  const ghost = '00000000-0000-4000-8000-000000000604';
  const suffix = () => Math.random().toString(36).slice(2, 8);
  const DEAD = [
    ['recommendation', ghost],
    ['plan_template', ghost],
    ['external_url', 'https://gogo.id.vn/tet'],
  ] as const;

  beforeAll(async () => {
    ops = await createAdmin('camp604@gogo.local', 'ops_admin');
  });

  const call = (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: object) =>
    api().inject({
      method,
      url: `/v1/cms/campaigns${url}`,
      remoteAddress: ip(),
      headers: auth(ops.token),
      ...(payload ? { payload } : {}),
    });
  const draft = (extra: Record<string, unknown> = {}) => ({
    name: `Chiến dịch 604 ${suffix()}`,
    title: 'Cuối tuần đi đâu?',
    body: 'Gợi ý mới',
    audienceType: 'all',
    ...extra,
  });

  /** A row written before the rule, straight to the table. */
  async function legacy(
    destinationType: (typeof DEAD)[number][0],
    destinationValue: string,
    status: 'draft' | 'scheduled' = 'draft',
  ) {
    const [row] = await db
      .insert(schema.notificationCampaigns)
      .values({
        name: `Cũ 604 ${suffix()}`,
        title: 'Cũ',
        body: 'Cũ',
        audienceType: 'all',
        destinationType,
        destinationValue,
        status,
        createdByAdminId: ops.id,
        ...(status === 'scheduled'
          ? { scheduledAt: new Date(Date.now() - 60_000), dispatchKey: crypto.randomUUID() }
          : {}),
      })
      .returning({ id: schema.notificationCampaigns.id });
    return row!.id;
  }

  it('refuses to create a campaign with a destination the app cannot open', async () => {
    for (const [destinationType, destinationValue] of DEAD) {
      const res = await call('POST', '', draft({ destinationType, destinationValue }));
      expect(res.statusCode, destinationType).toBe(422);
      expect(res.json().code).toBe('INVALID_DESTINATION');
      expect(res.json().field_errors?.[0]?.field).toBe('destinationType');
    }
    // The openable ones still work.
    expect((await call('POST', '', draft({ destinationType: 'home' }))).statusCode).toBe(201);
    expect((await call('POST', '', draft({ destinationType: 'saved' }))).statusCode).toBe(201);
  });

  it('refuses to change a destination to one the app cannot open', async () => {
    const id = (await call('POST', '', draft({ destinationType: 'home' }))).json().id as string;
    for (const [destinationType, destinationValue] of DEAD) {
      const res = await call('PATCH', `/${id}`, { destinationType, destinationValue });
      expect(res.statusCode, destinationType).toBe(422);
      expect(res.json().code).toBe('INVALID_DESTINATION');
    }
    expect((await call('GET', `/${id}`)).json().destinationType).toBe('home');
  });

  it('leaves a campaign that already holds one readable and editable elsewhere', async () => {
    const id = await legacy('external_url', 'https://gogo.id.vn/tet');
    const read = await call('GET', `/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().destinationType).toBe('external_url');

    // An edit that leaves the destination alone still works…
    const renamed = await call('PATCH', `/${id}`, { name: `Đổi tên ${suffix()}` });
    expect(renamed.statusCode, renamed.body).toBe(200);
    // …and so does repeating the destination it already has.
    const same = await call('PATCH', `/${id}`, {
      destinationType: 'external_url',
      destinationValue: 'https://gogo.id.vn/tet',
    });
    expect(same.statusCode, same.body).toBe(200);
    // Moving it to something openable is the way out.
    // The old URL is not carried over to a type that takes no value.
    const fixed = await call('PATCH', `/${id}`, { destinationType: 'home' });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json().destinationType).toBe('home');
  });

  it('refuses to schedule a campaign that already holds an unopenable destination (F-01)', async () => {
    // A URL needs no row to exist, so before the rule this scheduled (201).
    const id = await legacy('external_url', 'https://gogo.id.vn/tet');
    const res = await call('POST', `/${id}/schedule`, {});
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe('INVALID_DESTINATION');
    expect(res.json().field_errors?.[0]?.field).toBe('destinationType');
    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.status).toBe('draft');
  });

  it('refuses a test send of a campaign with an unopenable destination (F-02)', async () => {
    // The composer has a verified consumer account, so before the rule this
    // queued (201) rather than failing on NO_TEST_RECIPIENT.
    await db
      .insert(schema.users)
      .values({ email: 'camp604@gogo.local', displayName: 'Ops 604', emailVerifiedAt: new Date() })
      .onConflictDoNothing();
    const id = await legacy('external_url', 'https://gogo.id.vn/tet');
    const res = await call('POST', `/${id}/test-send`, {});
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe('INVALID_DESTINATION');
    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.testSendRequestedAt).toBeNull();
  });

  it('never sends a due campaign whose destination the app cannot open', async () => {
    // An eligible recipient (live push subscription, push not opted out), so
    // "nothing was sent" is a decision and not an empty audience (F-03).
    const [reachable] = await db
      .insert(schema.users)
      .values({ email: `camp604-r-${suffix()}@gogo.id.vn`, displayName: 'Reachable' })
      .returning();
    await db
      .insert(schema.pushSubscriptions)
      .values({ userId: reachable!.id, platform: 'ios', subscriptionId: `sub-604-${suffix()}` });
    const id = await legacy('plan_template', ghost, 'scheduled');
    // Only this campaign is due; anything else still scheduled is parked.
    await db.execute(sql`
      update notification_campaigns
      set scheduled_at = case when id = ${id}::uuid
                              then now() - interval '1 second'
                              else now() + interval '1 day' end
      where status = 'scheduled'
    `);
    const sent: string[] = [];
    const push = {
      async sendToUser(userId: string) {
        return this.sendToUsers([userId]);
      },
      async sendToUsers(userIds: readonly string[]) {
        sent.push(...userIds);
        return {
          providerMessageId: 'x',
          providerMessageIds: ['x'],
          emptyResponses: 0,
          unknownUserIds: [],
        };
      },
    };
    const { CampaignDispatcher } = await import('@gogo/modules');
    await new CampaignDispatcher(db as never, push as never).dispatchDue();

    const [row] = await db
      .select()
      .from(schema.notificationCampaigns)
      .where(eq(schema.notificationCampaigns.id, id));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toBe('DESTINATION_NOT_OPENABLE');
    expect(sent).toHaveLength(0);
    // The audience was never resolved, let alone pushed to.
    expect(row!.recipientCount).toBeNull();
    const { rows } = await db.execute(sql`
      select count(*)::int as n from notifications
      where kind = 'campaign' and payload->>'campaignId' = ${id}
    `);
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
