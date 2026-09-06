import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { PasswordService } from '../../identity/application/password.service';
import { TokenService } from '../../identity/application/token.service';
import { SessionRevocationService } from '../../identity/application/session-revocation.service';
import type { ClientMeta } from '../../identity/application/auth.service';
import { writeAudit } from '../../shared/audit';
import { SecretBox } from '../../shared/secret-box';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import { IdentityRepository } from '../../identity/infrastructure/identity.repository';

export type AdminRole = (typeof schema.adminUsers.$inferSelect)['role'];
export type AdminStatus = (typeof schema.adminUsers.$inferSelect)['status'];

export type AdminListQuery = {
  q?: string | undefined;
  role?: AdminRole | undefined;
  status?: AdminStatus | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type AdminListEntry = {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: string;
  lastLoginAt?: string | undefined;
  /**
   * #248 — whether a second factor is enrolled. The status, never the secret:
   * the console needs to show which accounts are unprotected, and nothing
   * about the TOTP seed helps it do that.
   */
  mfaEnrolled: boolean;
  /** #248 — a temporary password is outstanding and owes a replacement. */
  mustChangePassword: boolean;
};

export type AdminListPage = {
  items: AdminListEntry[];
  nextCursor: string | null;
  totalCount: number;
};

/**
 * Accepts a transaction as well as the pool — the same structural trick
 * `writeAudit` uses. Drizzle's `PgTransaction` is not assignable to `Db`, so a
 * cast compiles under the editor's config and fails the build; naming the
 * methods actually used is both honest and portable.
 */
type DbLike = Pick<Db, 'select' | 'update' | 'execute'>;

type AdminRow = {
  id: string;
  email: string;
  display_name: string;
  role: AdminRole;
  status: AdminStatus;
  created_at: Date | string;
  last_login_at: Date | string | null;
  mfa_enrolled: boolean;
  must_change_password: boolean;
};

/** One shape for an account, whether it came back from a list or a mutation. */
function toAdminEntry(row: typeof schema.adminUsers.$inferSelect): AdminListEntry {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt.toISOString() } : {}),
    mfaEnrolled: row.mfaTotpSecretEnc !== null,
    mustChangePassword: row.mustChangePasswordAt !== null,
  };
}

/**
 * Same numbers as consumer login. The console is the higher-privilege door;
 * it had a per-IP limit and no per-account one at all, so an attacker rotating
 * addresses had unlimited attempts against a named admin.
 */
export const ADMIN_LOCKOUT_THRESHOLD = 5;
export const ADMIN_LOCKOUT_WINDOW_SECONDS = 15 * 60;

/** TOTP step length, from the otplib defaults this service authenticates with. */
const TOTP_STEP_SECONDS = 30;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Namespaced so an admin's failures cannot be counted against the consumer
 * account with the same address, in either direction.
 */
const adminIdentifier = (email: string) => sha256(`admin:${email.trim().toLowerCase()}`);

/**
 * CMS-001 — admin authentication. Security rules: CMS sessions are shorter
 * than the consumer app; production requires MFA (TOTP now, SSO when an IdP
 * is provisioned — tracked on GoGo-BE#62). Admin access tokens carry
 * act=admin; role is re-checked from the DB on every request, never trusted
 * from the token.
 */
@Injectable()
export class AdminAuthService {
  /**
   * Accepted in place of a real TOTP code outside production, so a fresh
   * environment can be used before anyone has an authenticator enrolled. It
   * matches the code the CMS mock expects.
   *
   * Reachable only when APP_ENV is not prod. It is a deliberate hole in a
   * security control, so it is a named constant next to the check that uses it
   * rather than a literal buried in a condition — if this ever appears in a
   * production login path, it should be obvious in review rather than
   * discoverable by guessing six digits.
   */
  static readonly DEV_TOTP_CODE = '123456';

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly revocations: SessionRevocationService,
    @Inject(APP_CONFIG)
    private readonly config: IdentityConfig & { CMS_MFA_ENCRYPTION_KEY: string },
    private readonly identity: IdentityRepository,
  ) {
    // Production validates its own key at boot (env.ts). Elsewhere the key is
    // derived from the JWT secret so dev and test boot without one — the
    // derivation is deliberate and documented, not an empty-key fallback that
    // would silently encrypt with nothing.
    this.secrets = new SecretBox(
      this.config.CMS_MFA_ENCRYPTION_KEY || `derived-mfa-key:${this.config.AUTH_JWT_SECRET}`,
    );
  }

  private readonly secrets: SecretBox;

  /** The step a code belongs to, used to refuse a replay of one already spent. */
  private static stepOf(delta: number): number {
    return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + delta;
  }

  async login(input: {
    email: string;
    password: string;
    totp?: string | undefined;
    meta?: ClientMeta | undefined;
  }) {
    // Per-account lockout, which the console did not have. A per-IP limit
    // alone means an attacker rotating addresses gets unlimited attempts at a
    // named admin — on the door with the most privilege behind it.
    const identifierHash = adminIdentifier(input.email);
    const ipHash = sha256(input.meta?.ip ?? 'unknown');
    const failures = await this.identity.countRecentFailures(
      identifierHash,
      ADMIN_LOCKOUT_WINDOW_SECONDS,
    );
    if (failures >= ADMIN_LOCKOUT_THRESHOLD) {
      // Indistinguishable from bad credentials apart from retryable, and never
      // confirms the account exists.
      throw AppError.tooManyRequests('Too many attempts, try again later');
    }

    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(sql`lower(${schema.adminUsers.email}) = lower(${input.email})`)
      .limit(1);
    const valid = await this.passwords.verifyOrBurn(admin?.passwordHash, input.password);
    await this.identity.recordLoginAttempt({ identifierHash, ipHash, succeeded: valid });
    if (!valid || !admin || admin.status !== 'active') {
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    const isProduction = this.config.APP_ENV === 'prod' || this.config.APP_ENV === 'production';

    if (admin.mfaTotpSecretEnc) {
      const step = await this.consumeTotp(admin, input.totp);
      // A wrong code is a failed attempt too: counting only the password would
      // leave the second factor brute-forceable at the per-IP rate.
      if (step === null && !(!isProduction && input.totp === AdminAuthService.DEV_TOTP_CODE)) {
        await this.identity.recordLoginAttempt({ identifierHash, ipHash, succeeded: false });
        throw AppError.unauthorized('MFA_REQUIRED', 'Valid TOTP code required');
      }
    } else if (isProduction) {
      // Production hard-requires MFA (security rule) — no silent bypass.
      //
      // APP_ENV, not NODE_ENV. NODE_ENV is `production` in every deployed
      // environment because they all run the production build, so this used to
      // lock DEV too — and there it is a deadlock rather than a policy:
      // enrolling calls /cms/auth/totp/setup, which needs a session, which
      // login refuses to issue until MFA is enrolled. The first admin on a
      // fresh environment could never sign in.
      throw AppError.forbidden('MFA_SETUP_REQUIRED', 'Set up MFA before logging in');
    }

    await this.db
      .update(schema.adminUsers)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(schema.adminUsers.id, admin.id));
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: admin.id,
      action: 'admin.login',
      resourceType: 'admin_user',
      resourceId: admin.id,
    });

    const session = await this.openSession(admin.id, randomUUID(), undefined, input.meta);
    return {
      ...session,
      role: admin.role,
      displayName: admin.displayName,
      // #248 — the console needs to know it must route to the change screen.
      // The obligation itself is enforced by AdminGuard, not by this flag.
      mustChangePassword: admin.mustChangePasswordAt !== null,
    };
  }

  /**
   * #62 / ADR-0010 — open a console session from a verified Cloudflare Access
   * identity. `CloudflareAccessService` has already established *who*; this
   * decides *whether*, and the split matters:
   *
   * **No auto-provisioning.** A verified assertion is not an account. The
   * Access allow-list and `admin_users` answer different questions — the first
   * says who may reach the hostname, the second who may act in the console —
   * and they are maintained by different people. Creating a row here would let
   * anyone added to an Access policy silently become staff, with a role
   * nobody chose.
   *
   * **No password, no TOTP.** Both factors were already presented upstream:
   * Access authenticated against the identity provider and enforced MFA there
   * before signing the assertion. Asking again is not defence in depth, it is
   * a second password to phish. What this path does *not* skip is the admin
   * row check — a suspended account is refused here exactly as it is on every
   * request.
   *
   * The session issued is an ordinary admin session: same rotating refresh,
   * same revocation family, same 8-hour lifetime. Nothing downstream needs to
   * know which door was used.
   */
  async loginWithAccessIdentity(identity: { email: string }, meta?: ClientMeta) {
    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(sql`lower(${schema.adminUsers.email}) = lower(${identity.email})`)
      .limit(1);

    // Deliberately distinguishable from a bad assertion: the caller proved a
    // real identity, and "you are not staff here" is the true and actionable
    // answer. Enumeration is not a risk on this path — reaching it already
    // required an assertion signed by Cloudflare for this application.
    if (!admin || admin.status !== 'active') {
      throw AppError.forbidden('ADMIN_ONLY', 'This identity has no active staff account');
    }

    await this.db
      .update(schema.adminUsers)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(schema.adminUsers.id, admin.id));
    // A distinct action from `admin.login`: which door someone came through is
    // the first question asked when reviewing an incident, and it is
    // unrecoverable if both write the same row.
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: admin.id,
      action: 'admin.login.sso',
      resourceType: 'admin_user',
      resourceId: admin.id,
    });

    const session = await this.openSession(admin.id, randomUUID(), undefined, meta);
    return {
      ...session,
      role: admin.role,
      displayName: admin.displayName,
      mustChangePassword: admin.mustChangePasswordAt !== null,
    };
  }

  /**
   * SEC-003 — rotating refresh for CMS. Same theft response as ADR-0003: a
   * refresh token is single-use, and presenting a superseded one revokes the
   * whole family rather than just failing the call.
   */
  async refresh(refreshToken: string, meta?: ClientMeta) {
    const hash = this.tokens.hashOpaqueToken(refreshToken);
    const [session] = await this.db
      .select()
      .from(schema.adminSessions)
      .where(eq(schema.adminSessions.refreshTokenHash, hash))
      .limit(1);
    if (!session) throw AppError.unauthorized('INVALID_REFRESH_TOKEN', 'Session is not valid');
    if (session.revokedAt) {
      throw AppError.unauthorized('SESSION_REVOKED', 'Session is not valid');
    }
    if (session.supersededAt) {
      await this.revokeFamily(session.familyId, 'refresh_token_reuse');
      throw AppError.unauthorized('SESSION_REVOKED', 'Session is not valid');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized('SESSION_EXPIRED', 'Session is not valid');
    }

    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, session.adminId))
      .limit(1);
    // The admin row is re-read rather than trusted from the token: a suspended
    // or demoted admin must not be able to refresh their way onward.
    if (!admin || admin.status !== 'active') {
      await this.revokeFamily(session.familyId, 'admin_inactive');
      throw AppError.forbidden('ADMIN_ONLY', 'Staff account is not active');
    }

    await this.db
      .update(schema.adminSessions)
      .set({ supersededAt: sql`now()`, lastUsedAt: sql`now()` })
      .where(eq(schema.adminSessions.id, session.id));

    const next = await this.openSession(admin.id, session.familyId, session.id, meta);
    return {
      ...next,
      role: admin.role,
      displayName: admin.displayName,
      mustChangePassword: admin.mustChangePasswordAt !== null,
    };
  }

  /** Ends one session; the outstanding access token stops working immediately. */
  async logout(sessionId: string, allDevices = false): Promise<void> {
    const [session] = await this.db
      .select()
      .from(schema.adminSessions)
      .where(eq(schema.adminSessions.id, sessionId))
      .limit(1);
    if (!session) return; // already gone — logout is idempotent
    if (allDevices) {
      await this.revokeFamily(session.familyId, 'logout_all');
      return;
    }
    await this.db
      .update(schema.adminSessions)
      .set({ revokedAt: sql`now()`, revokeReason: 'logout' })
      .where(eq(schema.adminSessions.id, sessionId));
    await this.revocations.revokeSession(sessionId);
  }

  private async openSession(
    adminId: string,
    familyId: string,
    rotatedFromId: string | undefined,
    meta?: ClientMeta,
  ) {
    const refreshToken = this.tokens.generateOpaqueToken();
    const [row] = await this.db
      .insert(schema.adminSessions)
      .values({
        adminId,
        refreshTokenHash: this.tokens.hashOpaqueToken(refreshToken),
        familyId,
        rotatedFromId: rotatedFromId ?? null,
        expiresAt: new Date(Date.now() + this.config.AUTH_ADMIN_REFRESH_TTL_SECONDS * 1000),
        ipHash: meta?.ip ? createHash('sha256').update(meta.ip).digest('hex') : null,
        userAgent: meta?.userAgent ?? null,
      })
      .returning();

    return {
      accessToken: this.tokens.issueAccessToken({
        actorId: adminId,
        actorType: 'admin',
        // A real session id, not the admin id: that is what makes logging out
        // of one device, and revoking one session, possible at all.
        sessionId: row!.id,
      }),
      refreshToken,
      expiresIn: this.tokens.accessTtlSeconds,
      refreshExpiresIn: this.config.AUTH_ADMIN_REFRESH_TTL_SECONDS,
    };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    const rows = await this.db
      .update(schema.adminSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(
        and(eq(schema.adminSessions.familyId, familyId), isNull(schema.adminSessions.revokedAt)),
      )
      .returning({ id: schema.adminSessions.id });
    // Every access token minted from the family dies now, not at expiry (#129).
    await this.revocations.revokeMany(rows.map((r) => r.id));
  }

  /**
   * Verifies a TOTP code against the stored secret and spends its step.
   *
   * Returns the consumed step, or null when the code is absent, wrong, or
   * belongs to a step already used. Replay matters because a code stays
   * mathematically valid for its whole 30-second window: without this, one
   * observed code is reusable inside it.
   */
  private async consumeTotp(
    admin: typeof schema.adminUsers.$inferSelect,
    code: string | undefined,
  ): Promise<number | null> {
    if (!code || !admin.mfaTotpSecretEnc) return null;
    let secret: string;
    try {
      secret = this.secrets.decrypt(admin.mfaTotpSecretEnc);
    } catch {
      // An unreadable secret is a refusal, never a bypass.
      return null;
    }
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null || delta === undefined) return null;

    const step = AdminAuthService.stepOf(delta);
    if (admin.mfaTotpLastStep !== null && step <= admin.mfaTotpLastStep) return null;

    // Conditional on the step not having moved, so two requests racing with
    // the same code cannot both win.
    const updated = await this.db
      .update(schema.adminUsers)
      .set({ mfaTotpLastStep: step })
      .where(
        and(
          eq(schema.adminUsers.id, admin.id),
          admin.mfaTotpLastStep === null
            ? isNull(schema.adminUsers.mfaTotpLastStep)
            : eq(schema.adminUsers.mfaTotpLastStep, admin.mfaTotpLastStep),
        ),
      )
      .returning({ id: schema.adminUsers.id });
    return updated.length > 0 ? step : null;
  }

  /**
   * TOTP enrollment, step one: requires a fresh password proof and returns the
   * otpauth URI. MFA is **not** switched on here.
   *
   * Enrolling and activating in one step meant an admin whose authenticator
   * never got the secret was locked out of the console at the next login,
   * because production requires MFA. `confirmTotp` is the proof that the code
   * actually works.
   */
  async setupTotp(adminId: string, password: string) {
    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, adminId))
      .limit(1);
    if (!admin) throw AppError.unauthorized();
    const valid = await this.passwords.verifyOrBurn(admin.passwordHash, password);
    if (!valid) throw AppError.unauthorized('INVALID_CREDENTIALS', 'Password check failed');

    const secret = authenticator.generateSecret();
    await this.db
      .update(schema.adminUsers)
      .set({ mfaTotpPendingEnc: this.secrets.encrypt(secret), updatedAt: sql`now()` })
      .where(eq(schema.adminUsers.id, adminId));
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'admin.mfa_enrollment_started',
      resourceType: 'admin_user',
      resourceId: adminId,
    });
    return {
      // Returned once, at enrollment, so the authenticator can be provisioned.
      // It is never readable again — the stored copy is encrypted.
      secret,
      otpauthUri: authenticator.keyuri(admin.email, 'GoGo CMS', secret),
      confirmed: false,
    };
  }

  /**
   * TOTP enrollment, step two: a code generated from the pending secret proves
   * the authenticator holds it, and only then does MFA become required for
   * this account.
   */
  async confirmTotp(adminId: string, code: string) {
    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, adminId))
      .limit(1);
    if (!admin) throw AppError.unauthorized();
    if (!admin.mfaTotpPendingEnc) {
      throw AppError.conflict('MFA_NOT_PENDING', 'Start MFA enrollment first');
    }

    let secret: string;
    try {
      secret = this.secrets.decrypt(admin.mfaTotpPendingEnc);
    } catch {
      throw AppError.conflict('MFA_NOT_PENDING', 'Start MFA enrollment first');
    }
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null || delta === undefined) {
      throw AppError.unauthorized('MFA_CODE_INVALID', 'That code is not valid');
    }

    await this.db
      .update(schema.adminUsers)
      .set({
        mfaTotpSecretEnc: admin.mfaTotpPendingEnc,
        mfaTotpPendingEnc: null,
        // The confirming code is spent, so it cannot also be used to log in.
        mfaTotpLastStep: AdminAuthService.stepOf(delta),
        mfaEnrolledAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.adminUsers.id, adminId));
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'admin.mfa_enrolled',
      resourceType: 'admin_user',
      resourceId: adminId,
    });
    // Every other session of this admin ends: enrolling a second factor is a
    // credential change, and sessions opened before it were opened with less.
    await this.revokeAllSessions(adminId, 'mfa_enrolled');
    return { confirmed: true };
  }

  /**
   * Ends every live session for one admin.
   *
   * `tx` when the revoke has to land with the write that caused it — suspending
   * an account that stays reachable because the surrounding transaction rolled
   * back is the failure this prevents. `keepSessionId` for a self-service
   * password change, where the session doing the changing survives and every
   * other one does not.
   */
  private async revokeAllSessions(
    adminId: string,
    reason: string,
    opts: { tx?: DbLike; keepSessionId?: string } = {},
  ): Promise<void> {
    const rows = await (opts.tx ?? this.db)
      .update(schema.adminSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(
        and(
          eq(schema.adminSessions.adminId, adminId),
          isNull(schema.adminSessions.revokedAt),
          ...(opts.keepSessionId
            ? [sql`${schema.adminSessions.id} <> ${opts.keepSessionId}::uuid`]
            : []),
        ),
      )
      .returning({ id: schema.adminSessions.id });
    // The denylist is what stops an access token already in someone's hands;
    // revoking the row only closes the refresh path.
    await this.revocations.revokeMany(rows.map((r) => r.id));
  }

  /**
   * Super-admin creates staff accounts (CMS-001 RBAC bootstrap).
   *
   * Every CMS account except the `super_admin` itself is created here. The
   * `super_admin` is bootstrapped once from SSM (ADR-0018) and cannot be
   * created through the console at all.
   */
  async createAdmin(input: {
    email: string;
    password: string;
    displayName: string;
    role: AdminRole;
    createdBy: string;
  }) {
    AdminAuthService.assertRoleAssignable(input.role);
    const passwordHash = await this.passwords.hash(input.password);
    const [row] = await this.db
      .insert(schema.adminUsers)
      .values({
        email: input.email.toLowerCase(),
        passwordHash,
        displayName: input.displayName,
        role: input.role,
      })
      .returning();
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: input.createdBy,
      action: 'admin.created',
      resourceType: 'admin_user',
      resourceId: row!.id,
      diff: { role: input.role },
    });
    return { id: row!.id, email: row!.email, role: row!.role };
  }

  /**
   * BE-CMS-G2 (#220) — reading staff accounts back.
   *
   * `POST /cms/auth/admins` existed with no read beside it: the console could
   * create an account and then never show it again, so the create screen
   * shipped and the list could not.
   *
   * Columns are selected one by one rather than `select()`: the row carries the
   * password hash and both TOTP secrets, and a response built by spreading it
   * would leak all three the first time someone added a field.
   */
  /**
   * ADR-0018 — at most one `super_admin` before an environment is bootstrapped,
   * exactly one after, and this service cannot mint a second one at any point.
   *
   * That account is bootstrapped once, from credentials an operator reads out
   * of SSM, and everything else in the console is created and managed by it.
   * A second holder of the role would double the blast radius of a compromise
   * for no gain the role model needs: `ops_admin` covers every delegable
   * operation, and the one thing it does not cover — changing who holds which
   * role — is the thing that must stay singular.
   *
   * Refused rather than silently downgraded. Handing back a working account
   * with less privilege than was asked for means finding out later, from the
   * thing it could not do.
   *
   * The database refuses it too (`admin_users_single_super_admin`). This check
   * exists so the refusal has a code and a message instead of a constraint
   * violation, not because it is the only one.
   */
  private static assertRoleAssignable(role: AdminRole | undefined): void {
    if (role === 'super_admin') {
      throw AppError.conflict(
        'SUPER_ADMIN_SINGLETON',
        'An environment has exactly one super_admin; a second cannot be created or promoted',
      );
    }
  }

  /**
   * #248, kept under ADR-0018 — the single `super_admin` is load-bearing.
   * Demoting or suspending it leaves a console nobody can administer: role
   * changes, account creation and ranking approval are all `super_admin`, and
   * there is by construction no second one to fall back to. Recovery would mean
   * an engineer with database access.
   *
   * Its **credentials** are another matter and are deliberately not frozen: the
   * account rotates its password through the ordinary account-management flow,
   * which audits the change and revokes the sessions it invalidates. Freezing
   * the row is about who holds the role, not about how long a password lives.
   */
  private static assertRoleSurvives(subject: { role: AdminRole }, next: AdminRole | undefined) {
    if (subject.role === 'super_admin' && next !== undefined && next !== 'super_admin') {
      throw AppError.conflict(
        'LAST_SUPER_ADMIN',
        'The super_admin role cannot be given up; an environment has exactly one',
      );
    }
  }

  private async loadAdmin(tx: DbLike, id: string) {
    const [admin] = await tx
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, id))
      .limit(1);
    if (!admin) throw AppError.notFound('ADMIN_NOT_FOUND', 'No such staff account');
    return admin;
  }

  /**
   * #248 — edit role or display name.
   *
   * **An admin cannot change their own role.** Not because self-promotion is
   * the risk — a `super_admin` is already the top of the model — but because
   * the one-person path from any role to any other role removes the only
   * check the model has. Two people, or nothing.
   */
  async updateAdmin(input: {
    id: string;
    role?: AdminRole | undefined;
    displayName?: string | undefined;
    reason: string;
    actorId: string;
  }) {
    if (input.role && input.id === input.actorId) {
      throw AppError.forbidden('SELF_ROLE_CHANGE', 'Another super_admin must change your role');
    }
    AdminAuthService.assertRoleAssignable(input.role);
    return this.db.transaction(async (tx) => {
      const before = await this.loadAdmin(tx, input.id);
      AdminAuthService.assertRoleSurvives(before, input.role);

      const [after] = await tx
        .update(schema.adminUsers)
        .set({
          ...(input.role ? { role: input.role } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.adminUsers.id, input.id))
        .returning();

      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.actorId,
        action: 'admin.updated',
        resourceType: 'admin_user',
        resourceId: input.id,
        // Before and after both: "role changed to ops_admin" does not tell a
        // reviewer whether that was a promotion or a demotion.
        diff: {
          reason: input.reason,
          before: { role: before.role, displayName: before.displayName },
          after: { role: after!.role, displayName: after!.displayName },
        },
      });
      return toAdminEntry(after!);
    });
  }

  /**
   * #248 — suspend or reactivate.
   *
   * Suspending revokes every session rather than relying on `AdminGuard`
   * refusing the next request. Both are true, and they answer different
   * questions: the guard stops the account being *used*, the revoke stops the
   * refresh chain being *continued* — and it is what makes the session list
   * afterwards mean what it says.
   */
  async setAdminStatus(input: {
    id: string;
    status: AdminStatus;
    reason: string;
    actorId: string;
  }) {
    if (input.status === 'suspended' && input.id === input.actorId) {
      // The failure mode is immediate and total, and no product need justifies
      // it: signing out is the operation this person actually wants.
      throw AppError.forbidden('SELF_SUSPEND', 'You cannot suspend your own account');
    }
    return this.db.transaction(async (tx) => {
      const before = await this.loadAdmin(tx, input.id);
      if (input.status === 'suspended' && before.role === 'super_admin') {
        // Suspending it is demotion by another name: the console would be left
        // with nobody who can change a role or create an account.
        throw AppError.conflict(
          'LAST_SUPER_ADMIN',
          'The super_admin cannot be suspended; an environment has exactly one',
        );
      }

      const [after] = await tx
        .update(schema.adminUsers)
        .set({ status: input.status, updatedAt: sql`now()` })
        .where(eq(schema.adminUsers.id, input.id))
        .returning();

      if (input.status === 'suspended') {
        await this.revokeAllSessions(input.id, 'admin_suspended', { tx: tx });
      }

      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.actorId,
        action: input.status === 'suspended' ? 'admin.suspended' : 'admin.reactivated',
        resourceType: 'admin_user',
        resourceId: input.id,
        diff: { reason: input.reason, before: before.status, after: after!.status },
      });
      return toAdminEntry(after!);
    });
  }

  /**
   * #248 — issue a one-time temporary password.
   *
   * Three things have to be true together, and dropping any one of them makes
   * this a way in rather than a way back in:
   *
   * - The password is **returned once and never stored in the clear**, like
   *   every other credential here.
   * - Every existing session is revoked. A reset happens because control of
   *   the account is in doubt; leaving a live session open answers the
   *   question the wrong way.
   * - The account owes a change (`mustChangePasswordAt`), enforced by
   *   `AdminGuard`, not by the console hiding a screen.
   *
   * MFA is deliberately left alone. Resetting it here would turn one
   * `super_admin` into a complete account takeover with no second factor to
   * stop it; re-enrolling MFA stays a separate, deliberate act.
   */
  async resetAdminPassword(input: { id: string; reason: string; actorId: string }) {
    return this.db.transaction(async (tx) => {
      await this.loadAdmin(tx, input.id);
      const temporary = this.tokens.generateOpaqueToken().slice(0, 24);
      const passwordHash = await this.passwords.hash(temporary);

      await tx
        .update(schema.adminUsers)
        .set({
          passwordHash,
          mustChangePasswordAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.adminUsers.id, input.id));
      await this.revokeAllSessions(input.id, 'password_reset', { tx: tx });

      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.actorId,
        action: 'admin.password_reset',
        resourceType: 'admin_user',
        resourceId: input.id,
        // The reason, never the password.
        diff: { reason: input.reason },
      });
      return { temporaryPassword: temporary, mustChangePassword: true };
    });
  }

  /**
   * #248 — an admin replaces their own password, which is the only way to
   * clear the obligation a reset creates.
   *
   * The current password is required even when a reset is outstanding: it is
   * what proves the person typing is the one the temporary password was
   * handed to, and without it a leaked session id would be enough.
   *
   * This is also how the `super_admin` rotates the password it was bootstrapped
   * with (ADR-0018). Rotation is an authenticated, audited act that revokes the
   * sessions it invalidates — editing the SSM parameter is none of those things
   * and changes nothing about how this account signs in.
   *
   * **The initiating session survives; every other session of the account is
   * revoked.** Both halves are deliberate: the person rotating authenticated a
   * moment ago and is still working, so signing them out of the tab they used
   * would make a routine rotation read as a failure — while a rotation is also
   * how someone answers a suspected compromise, which is worth nothing if the
   * other sessions live on. `resetAdminPassword` keeps none, because there the
   * actor is someone else and control of the account is already in doubt.
   */
  async changeOwnPassword(input: {
    adminId: string;
    currentPassword: string;
    newPassword: string;
    keepSessionId: string;
  }) {
    const admin = await this.loadAdmin(this.db, input.adminId);
    const valid = await this.passwords.verifyOrBurn(admin.passwordHash, input.currentPassword);
    if (!valid) throw AppError.unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
    if (input.currentPassword === input.newPassword) {
      throw AppError.badRequest('PASSWORD_UNCHANGED', 'The new password must differ from the old');
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.adminUsers)
        .set({ passwordHash, mustChangePasswordAt: null, updatedAt: sql`now()` })
        .where(eq(schema.adminUsers.id, input.adminId));
      // Every other session dies: a password change is also how someone
      // responds to a suspected compromise, and leaving the other sessions
      // alive would make it useless for that.
      await this.revokeAllSessions(input.adminId, 'password_changed', {
        tx: tx,
        keepSessionId: input.keepSessionId,
      });
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.adminId,
        action: 'admin.password_changed',
        resourceType: 'admin_user',
        resourceId: input.adminId,
      });
    });
    return { changed: true };
  }

  async listAdmins(query: AdminListQuery): Promise<AdminListPage> {
    const where: SQL[] = [];
    if (query.role) where.push(sql`a.role = ${query.role}`);
    if (query.status) where.push(sql`a.status = ${query.status}`);
    if (query.q) {
      // Email and display name are the two things a person searches an account
      // list by, and both are already known to whoever can call this.
      const needle = `%${query.q.trim().toLowerCase()}%`;
      where.push(sql`(lower(a.email) like ${needle} or lower(a.display_name) like ${needle})`);
    }

    const countWhere = where.length ? sql.join(where, sql` and `) : sql`true`;
    const pageWhere = [...where];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageWhere.push(sql`(a.created_at, a.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select a.id, a.email, a.display_name, a.role, a.status,
               a.created_at, a.last_login_at,
               (a.mfa_totp_secret_enc is not null) as mfa_enrolled,
               (a.must_change_password_at is not null) as must_change_password
        from admin_users a
        where ${pageWhere.length ? sql.join(pageWhere, sql` and `) : sql`true`}
        order by a.created_at desc, a.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(sql`select count(*)::int as n from admin_users a where ${countWhere}`),
    ]);

    const rows = page.rows as AdminRow[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];

    return {
      items: items.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        status: r.status,
        createdAt: toIso(r.created_at),
        lastLoginAt: r.last_login_at ? toIso(r.last_login_at) : undefined,
        mfaEnrolled: r.mfa_enrolled,
        mustChangePassword: r.must_change_password,
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }
}
