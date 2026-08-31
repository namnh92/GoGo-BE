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
};

export type AdminListPage = {
  items: AdminListEntry[];
  nextCursor: string | null;
  totalCount: number;
};

type AdminRow = {
  id: string;
  email: string;
  display_name: string;
  role: AdminRole;
  status: AdminStatus;
  created_at: Date | string;
  last_login_at: Date | string | null;
};

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
    return { ...next, role: admin.role, displayName: admin.displayName };
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

  /** Ends every live session for one admin. */
  private async revokeAllSessions(adminId: string, reason: string): Promise<void> {
    const rows = await this.db
      .update(schema.adminSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(and(eq(schema.adminSessions.adminId, adminId), isNull(schema.adminSessions.revokedAt)))
      .returning({ id: schema.adminSessions.id });
    await this.revocations.revokeMany(rows.map((r) => r.id));
  }

  /** Super-admin creates staff accounts (CMS-001 RBAC bootstrap). */
  async createAdmin(input: {
    email: string;
    password: string;
    displayName: string;
    role: AdminRole;
    createdBy: string;
  }) {
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
               a.created_at, a.last_login_at
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
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }
}
