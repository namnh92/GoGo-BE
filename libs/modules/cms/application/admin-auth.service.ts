import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { PasswordService } from '../../identity/application/password.service';
import { TokenService } from '../../identity/application/token.service';
import { SessionRevocationService } from '../../identity/application/session-revocation.service';
import type { ClientMeta } from '../../identity/application/auth.service';
import { writeAudit } from '../../shared/audit';

export type AdminRole = (typeof schema.adminUsers.$inferSelect)['role'];

/**
 * CMS-001 — admin authentication. Security rules: CMS sessions are shorter
 * than the consumer app; production requires MFA (TOTP now, SSO when an IdP
 * is provisioned — tracked on GoGo-BE#62). Admin access tokens carry
 * act=admin; role is re-checked from the DB on every request, never trusted
 * from the token.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly revocations: SessionRevocationService,
    @Inject(APP_CONFIG) private readonly config: IdentityConfig,
  ) {}

  async login(input: {
    email: string;
    password: string;
    totp?: string | undefined;
    meta?: ClientMeta | undefined;
  }) {
    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(sql`lower(${schema.adminUsers.email}) = lower(${input.email})`)
      .limit(1);
    const valid = await this.passwords.verifyOrBurn(admin?.passwordHash, input.password);
    if (!valid || !admin || admin.status !== 'active') {
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    if (admin.mfaTotpSecretEnc) {
      if (!input.totp || !authenticator.check(input.totp, admin.mfaTotpSecretEnc)) {
        throw AppError.unauthorized('MFA_REQUIRED', 'Valid TOTP code required');
      }
    } else if (this.config.NODE_ENV === 'production') {
      // Production hard-requires MFA (security rule) — no silent bypass.
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

  /** TOTP enrollment: requires a fresh password proof; returns otpauth URI. */
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
      .set({ mfaTotpSecretEnc: secret, updatedAt: sql`now()` })
      .where(eq(schema.adminUsers.id, adminId));
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'admin.mfa_enrolled',
      resourceType: 'admin_user',
      resourceId: adminId,
    });
    return {
      secret,
      otpauthUri: authenticator.keyuri(admin.email, 'GoGo CMS', secret),
    };
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
}
