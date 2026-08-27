import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { PasswordService } from '../../identity/application/password.service';
import { TokenService } from '../../identity/application/token.service';
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
    @Inject(APP_CONFIG) private readonly config: IdentityConfig,
  ) {}

  async login(input: { email: string; password: string; totp?: string | undefined }) {
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

    return {
      accessToken: this.tokens.issueAccessToken({
        actorId: admin.id,
        actorType: 'admin',
        sessionId: admin.id,
      }),
      role: admin.role,
      displayName: admin.displayName,
      expiresIn: this.tokens.accessTtlSeconds,
    };
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
