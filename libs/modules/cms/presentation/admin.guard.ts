import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import type { AdminRole } from '../application/admin-auth.service';

export const ADMIN_ROLES_KEY = 'gogo:admin_roles';
/** Role gate for CMS routes. Applied per controller/handler. */
export const RequireRole = (...roles: AdminRole[]): CustomDecorator =>
  SetMetadata(ADMIN_ROLES_KEY, roles);

export type AdminActor = Actor & { role: AdminRole };

/**
 * FR-CMS-001 — RBAC enforced server-side. Runs after the global AuthGuard;
 * the admin row (status + role) is re-read per request so a suspended or
 * demoted admin loses access immediately, whatever their token says.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles) return true; // not a CMS route

    const req = context.switchToHttp().getRequest<{ actor?: AdminActor }>();
    const actor = req.actor;
    if (!actor || actor.type !== 'admin') {
      throw AppError.forbidden('ADMIN_ONLY', 'CMS access requires a staff account');
    }
    const [admin] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, actor.id))
      .limit(1);
    if (!admin || admin.status !== 'active') {
      throw AppError.forbidden('ADMIN_ONLY', 'Staff account is not active');
    }
    if (admin.role !== 'super_admin' && !roles.includes(admin.role)) {
      throw AppError.forbidden('ROLE_DENIED', 'Your role cannot perform this action');
    }
    actor.role = admin.role;
    return true;
  }
}
