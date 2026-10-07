import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/schema';
import { SuperAdminSyncConflict, syncSuperAdmin } from '../src/super-admin-sync';

/**
 * GoGo-BE#687 D-3 — every row of the sync table, the erase gate (AC-2 a/b),
 * the conflict that stops a deploy (AC-8), and that a repeat run writes no
 * audit row.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_test')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE admin_sessions, admin_users, audit_logs CASCADE`);
});

async function audits(action: string) {
  return db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));
}

async function superAdmin() {
  const [row] = await db
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.role, 'super_admin'));
  return row;
}

async function seedSuperAdmin(email: string, withPassword = true) {
  const [row] = await db
    .insert(schema.adminUsers)
    .values({
      email,
      role: 'super_admin',
      displayName: 'SA',
      passwordHash: withPassword ? 'argon2id$fake' : null,
      mustChangePasswordAt: withPassword ? new Date() : null,
    })
    .returning();
  return row!;
}

async function openSession(adminId: string) {
  const [row] = await db
    .insert(schema.adminSessions)
    .values({
      adminId,
      refreshTokenHash: `h-${Math.random()}`,
      familyId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
      authMethod: 'password',
    })
    .returning();
  return row!;
}

async function confirmSso(adminId: string, email: string) {
  await db.insert(schema.auditLogs).values({
    actorType: 'admin',
    actorId: adminId,
    action: 'admin.sso_confirmed',
    resourceType: 'admin_user',
    resourceId: adminId,
    diff: { email, sessionId: crypto.randomUUID() },
  });
}

describe('cms:sync-super-admin (#687 D-3)', () => {
  it('bootstraps the row with no password when none exists, audited as system', async () => {
    const r = await syncSuperAdmin(db, {
      email: 'Boss@Example.com',
      ssoOnly: false,
      revision: 'abc1234',
    });
    expect(r.action).toBe('bootstrapped');
    const row = await superAdmin();
    expect(row).toMatchObject({
      email: 'boss@example.com',
      status: 'active',
      passwordHash: null,
      mustChangePasswordAt: null,
    });
    const [a] = await audits('admin.super_admin_bootstrapped');
    expect(a).toMatchObject({
      actorType: 'system',
      actorId: null,
      resourceId: row!.id,
      requestId: null,
      ipAddress: null,
    });
    expect(a!.diff).toMatchObject({ email: 'boss@example.com', revision: 'abc1234' });
  });

  it('is a no-op when the row already has the SSM address, and a repeat run writes no audit row', async () => {
    const row = await seedSuperAdmin('boss@example.com');
    const first = await syncSuperAdmin(db, { email: 'boss@example.com', ssoOnly: false });
    const second = await syncSuperAdmin(db, { email: 'BOSS@example.com', ssoOnly: false });
    expect([first.action, second.action]).toEqual(['unchanged', 'unchanged']);
    expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
    expect((await superAdmin())!.passwordHash).toBe(row.passwordHash);
  });

  it('moves the address, revokes every session in the database and audits the change', async () => {
    const row = await seedSuperAdmin('old@example.com');
    const s1 = await openSession(row.id);
    const s2 = await openSession(row.id);
    const r = await syncSuperAdmin(db, {
      email: 'new@example.com',
      ssoOnly: false,
      revision: 'r2',
    });
    expect(r).toMatchObject({ action: 'email_changed', revokedSessions: 2 });
    expect((await superAdmin())!.email).toBe('new@example.com');
    const live = await db
      .select()
      .from(schema.adminSessions)
      .where(and(eq(schema.adminSessions.adminId, row.id), isNull(schema.adminSessions.revokedAt)));
    expect(live).toHaveLength(0);
    const revoked = await db.select().from(schema.adminSessions);
    expect(revoked.map((s) => s.revokeReason).sort()).toEqual(['email_changed', 'email_changed']);
    expect([s1.id, s2.id].sort()).toEqual(revoked.map((s) => s.id).sort());
    const [a] = await audits('admin.email_changed');
    expect(a).toMatchObject({ actorType: 'system', actorId: null });
    expect(a!.diff).toMatchObject({
      reason: 'ssm sync',
      before: { email: 'old@example.com' },
      after: { email: 'new@example.com' },
      revision: 'r2',
    });
  });

  it('refuses when the SSM address belongs to a staff row, changing nothing (AC-8)', async () => {
    const row = await seedSuperAdmin('old@example.com');
    await db
      .insert(schema.adminUsers)
      .values({ email: 'staff@example.com', role: 'editor', displayName: 'S' });
    await expect(
      syncSuperAdmin(db, { email: 'Staff@example.com', ssoOnly: false }),
    ).rejects.toBeInstanceOf(SuperAdminSyncConflict);
    expect((await superAdmin())!.email).toBe(row.email);
    expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
  });

  it('refuses when there is no super admin yet and the address is a staff row', async () => {
    await db
      .insert(schema.adminUsers)
      .values({ email: 'staff@example.com', role: 'editor', displayName: 'S' });
    await expect(
      syncSuperAdmin(db, { email: 'staff@example.com', ssoOnly: false }),
    ).rejects.toBeInstanceOf(SuperAdminSyncConflict);
    expect(await superAdmin()).toBeUndefined();
  });

  describe('erase gate (F-01, AC-2)', () => {
    it('(a) switch off: the hash is untouched even with a confirmation', async () => {
      const row = await seedSuperAdmin('boss@example.com');
      await confirmSso(row.id, 'boss@example.com');
      const r = await syncSuperAdmin(db, { email: 'boss@example.com', ssoOnly: false });
      expect(r).toMatchObject({ passwordErased: false, erasePending: false });
      expect((await superAdmin())!.passwordHash).toBe(row.passwordHash);
    });

    it('(b) switch on without a confirmation: the hash is untouched and the erase is pending', async () => {
      const row = await seedSuperAdmin('boss@example.com');
      const r = await syncSuperAdmin(db, { email: 'boss@example.com', ssoOnly: true });
      expect(r).toMatchObject({ passwordErased: false, erasePending: true });
      expect((await superAdmin())!.passwordHash).toBe(row.passwordHash);
    });

    it('a confirmation for a previous address does not count', async () => {
      const row = await seedSuperAdmin('new@example.com');
      await confirmSso(row.id, 'old@example.com');
      const r = await syncSuperAdmin(db, { email: 'new@example.com', ssoOnly: true });
      expect(r).toMatchObject({ passwordErased: false, erasePending: true });
    });

    it('a confirmation written by another admin row does not count', async () => {
      const row = await seedSuperAdmin('boss@example.com');
      const [other] = await db
        .insert(schema.adminUsers)
        .values({ email: 'staff@example.com', role: 'editor', displayName: 'S' })
        .returning();
      await confirmSso(other!.id, 'boss@example.com');
      const r = await syncSuperAdmin(db, { email: 'boss@example.com', ssoOnly: true });
      expect(r.passwordErased).toBe(false);
      expect((await superAdmin())!.passwordHash).toBe(row.passwordHash);
    });

    it('switch on with a confirmation for the current address: hash and obligation cleared, once', async () => {
      const row = await seedSuperAdmin('boss@example.com');
      await confirmSso(row.id, 'Boss@Example.com');
      const first = await syncSuperAdmin(db, { email: 'boss@example.com', ssoOnly: true });
      const second = await syncSuperAdmin(db, { email: 'boss@example.com', ssoOnly: true });
      expect([first.passwordErased, second.passwordErased]).toEqual([true, false]);
      expect(await superAdmin()).toMatchObject({ passwordHash: null, mustChangePasswordAt: null });
      expect(await audits('admin.password_erased')).toHaveLength(1);
    });
  });
});
