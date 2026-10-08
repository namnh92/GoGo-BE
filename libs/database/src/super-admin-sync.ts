import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { summarizeError } from './error-summary';
import * as schema from './schema';

/**
 * GoGo-BE#687 D-3 — the one `super_admin` row follows `CMS_SUPER_ADMIN_EMAIL`
 * (SSM `cms/super-admin-email`) at every deploy.
 *
 * Runs in the migrate container after migrations and before the new API starts,
 * so a failure here aborts the deploy and the previous revision keeps serving.
 * One transaction, the super admin row locked for its duration:
 *
 * | state                                         | action                                   |
 * | --------------------------------------------- | ---------------------------------------- |
 * | no super_admin row                            | insert it, no password; audit bootstrapped |
 * | row address == SSM address                    | nothing                                  |
 * | row address != SSM, SSM address unused        | move the address, revoke every session; audit email_changed |
 * | SSM address belongs to a staff row            | refuse — the deploy stops                |
 *
 * Then the erase gate: with `CMS_SUPER_ADMIN_SSO_ONLY` on **and** an
 * `admin.sso_confirmed` audit row for this account at its current address, the
 * password hash and any password-change obligation are cleared (idempotent).
 * Without that confirmation the hash is untouched and the run says so — a
 * switch flipped before anyone proved the Access door works must not remove the
 * other one.
 *
 * Sessions are revoked in the database only. `AdminGuard` reads
 * `admin_sessions.revoked_at` on every request (D-3, F-16), so nothing here
 * needs Redis, and a retry after a committed run is a no-op.
 */

export type SyncSuperAdminInput = {
  /** Already trimmed and lower-cased by the caller. */
  email: string;
  ssoOnly: boolean;
  /** Deploy revision for the audit trail, when the environment provides one. */
  revision?: string | null;
};

export type SyncSuperAdminResult = {
  action: 'bootstrapped' | 'unchanged' | 'email_changed';
  adminId: string;
  revokedSessions: number;
  passwordErased: boolean;
  erasePending: boolean;
};

/**
 * An error the sync raises on purpose. Its message is written for the operator
 * and names no address, so the CLI prints it as is. Every other error that
 * reaches the CLI is reduced to its class and code by {@link formatSyncFailure}
 * (review F-07): a `DrizzleQueryError` carries the bound parameters — the
 * address among them — in its message and stack.
 */
export class SuperAdminSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuperAdminSyncError';
  }
}

export class SuperAdminSyncConflict extends SuperAdminSyncError {
  constructor() {
    super(
      'cms:sync-super-admin: the address in CMS_SUPER_ADMIN_EMAIL belongs to a staff account; ' +
        'change that account first (PATCH /v1/cms/auth/admins/{id}) — nothing was changed',
    );
    this.name = 'SuperAdminSyncConflict';
  }
}

/**
 * The one line `cms:sync-super-admin` prints when it fails. The sync's own
 * errors pass through; anything else — Drizzle, pg, a socket — is named by
 * class and code only, never by message (F-07).
 */
export function formatSyncFailure(err: unknown): string {
  if (err instanceof SuperAdminSyncError) return err.message;
  return `cms:sync-super-admin failed: ${summarizeError(err)}`;
}

type Db = NodePgDatabase<typeof schema>;

export async function syncSuperAdmin(
  db: Db,
  input: SyncSuperAdminInput,
): Promise<SyncSuperAdminResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new SuperAdminSyncError('cms:sync-super-admin: CMS_SUPER_ADMIN_EMAIL is empty');
  const revision = input.revision ?? null;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.role, 'super_admin'))
      .for('update')
      .limit(1);

    // Asked for explicitly (review F-04): a non-super row holding the address,
    // case-insensitively. Migration 0073 makes lower(email) unique, so there is
    // at most one row to find.
    const [staffHolder] = await tx
      .select({ id: schema.adminUsers.id })
      .from(schema.adminUsers)
      .where(
        and(
          sql`lower(${schema.adminUsers.email}) = ${email}`,
          sql`${schema.adminUsers.role} <> 'super_admin'`,
        ),
      )
      .limit(1);

    if (staffHolder) throw new SuperAdminSyncConflict();

    let action: SyncSuperAdminResult['action'];
    let adminId: string;
    let revokedSessions = 0;

    if (!current) {
      const [created] = await tx
        .insert(schema.adminUsers)
        .values({
          email,
          role: 'super_admin',
          status: 'active',
          displayName: 'Super Admin',
          passwordHash: null,
          mustChangePasswordAt: null,
        })
        .returning({ id: schema.adminUsers.id });
      adminId = created!.id;
      action = 'bootstrapped';
      await tx.insert(schema.auditLogs).values({
        actorType: 'system',
        actorId: null,
        action: 'admin.super_admin_bootstrapped',
        resourceType: 'admin_user',
        resourceId: adminId,
        diff: { email, source: 'CMS_SUPER_ADMIN_EMAIL', revision },
      });
    } else if (current.email.toLowerCase() === email) {
      adminId = current.id;
      action = 'unchanged';
    } else {
      adminId = current.id;
      action = 'email_changed';
      await tx
        .update(schema.adminUsers)
        .set({ email, updatedAt: sql`now()` })
        .where(eq(schema.adminUsers.id, adminId));
      const revoked = await tx
        .update(schema.adminSessions)
        .set({ revokedAt: sql`now()`, revokeReason: 'email_changed' })
        .where(
          and(eq(schema.adminSessions.adminId, adminId), isNull(schema.adminSessions.revokedAt)),
        )
        .returning({ id: schema.adminSessions.id });
      revokedSessions = revoked.length;
      await tx.insert(schema.auditLogs).values({
        actorType: 'system',
        actorId: null,
        action: 'admin.email_changed',
        resourceType: 'admin_user',
        resourceId: adminId,
        diff: {
          reason: 'ssm sync',
          before: { email: current.email },
          after: { email },
          revokedSessions,
          revision,
        },
      });
    }

    // Erase gate (F-01, O-12).
    let passwordErased = false;
    let erasePending = false;
    if (input.ssoOnly) {
      const outcome = await eraseIfConfirmed(tx, adminId, email, revision);
      passwordErased = outcome === 'erased';
      erasePending = outcome === 'pending';
    }

    return { action, adminId, revokedSessions, passwordErased, erasePending };
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The erase gate itself: clear the password hash and any change obligation of
 * this super admin row when an `admin.sso_confirmed` audit row exists for it at
 * its current address. Idempotent. Caller holds the row lock.
 */
async function eraseIfConfirmed(
  tx: Tx,
  adminId: string,
  email: string,
  revision: string | null,
): Promise<'erased' | 'nothing_to_erase' | 'pending'> {
  const [confirmed] = await tx
    .select({ id: schema.auditLogs.id })
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.action, 'admin.sso_confirmed'),
        eq(schema.auditLogs.resourceType, 'admin_user'),
        eq(schema.auditLogs.resourceId, adminId),
        sql`lower(${schema.auditLogs.diff} ->> 'email') = ${email}`,
      ),
    )
    .limit(1);
  if (!confirmed) return 'pending';
  const erased = await tx
    .update(schema.adminUsers)
    .set({ passwordHash: null, mustChangePasswordAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.adminUsers.id, adminId),
        or(
          isNotNull(schema.adminUsers.passwordHash),
          isNotNull(schema.adminUsers.mustChangePasswordAt),
        ),
      ),
    )
    .returning({ id: schema.adminUsers.id });
  if (erased.length === 0) return 'nothing_to_erase';
  await tx.insert(schema.auditLogs).values({
    actorType: 'system',
    actorId: null,
    action: 'admin.password_erased',
    resourceType: 'admin_user',
    resourceId: adminId,
    diff: { reason: 'super admin signs in through Access only', email, revision },
  });
  return 'erased';
}

/**
 * Review F-05 — the sync runs in the migrate container while the previous API
 * (switch off) can still serve a reset or a password change, which would put a
 * hash back after the sync erased it. The new API therefore runs the same gate
 * once it has started, when the old one is gone: only the erase, never the
 * address move. A no-op unless the switch is on and the confirmation exists.
 */
export async function eraseSuperAdminPasswordIfConfirmed(
  db: Db,
  input: { email: string; revision?: string | null },
): Promise<'erased' | 'nothing_to_erase' | 'pending' | 'no_super_admin' | 'address_mismatch'> {
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: schema.adminUsers.id, email: schema.adminUsers.email })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.role, 'super_admin'))
      .for('update')
      .limit(1);
    if (!row) return 'no_super_admin';
    if (row.email.toLowerCase() !== email) return 'address_mismatch';
    return eraseIfConfirmed(tx, row.id, email, input.revision ?? null);
  });
}
