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
import { METRICS, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { setAuthorizationPath } from '../../shared/request-context';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import type { AdminRole } from '../application/admin-auth.service';

export const ADMIN_ROLES_KEY = 'gogo:admin_roles';
/** Role gate for CMS routes. Applied per controller/handler. */
export const RequireRole = (...roles: AdminRole[]): CustomDecorator =>
  SetMetadata(ADMIN_ROLES_KEY, roles);

export type AdminActor = Actor & { role: AdminRole };

/**
 * BE-IMP-008 — read is hierarchical, write is not.
 *
 * The roles are peers, not a chain: `ops_admin` is not a superset of `editor`.
 * That is the right shape for *writing* — an ops admin has no business editing
 * catalog copy. It was the wrong shape for *reading*: an ops admin could
 * publish an import (creating places) and then get a 403 opening the place list
 * to see what they had just created, and the on-call operator could see neither
 * the catalog nor the moderation queue.
 *
 * So a safe method (GET/HEAD/OPTIONS) passes when the caller's rank is at least
 * the lowest rank the route asks for: peers can read each other's areas, a
 * higher rank reads below it, and nothing reads above it — `ranking-configs`
 * and the admin list stay closed to lower ranks. Every write keeps the exact
 * role match it has today.
 */
const ROLE_RANK: Record<AdminRole, number> = {
  editor: 1,
  moderator: 1,
  ops_admin: 2,
  super_admin: 3,
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles) return true; // not a CMS route

    const req = context.switchToHttp().getRequest<{
      actor?: AdminActor;
      method?: string;
      routeOptions?: { url?: string };
    }>();
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
    const byExactRole = roles.includes(admin.role);
    const byRankRead =
      SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) &&
      ROLE_RANK[admin.role] >= Math.min(...roles.map((r) => ROLE_RANK[r]));

    if (!byExactRole && !byRankRead && admin.role !== 'super_admin') {
      throw AppError.forbidden('ROLE_DENIED', 'Your role cannot perform this action');
    }
    // SEC-002: record which rule let this through. `super_admin_bypass` means
    // the request would have been refused for every other role — that is the
    // escape hatch, and its frequency is the signal for whether the role model
    // fits the work people actually do.
    const path = byExactRole ? 'exact_role' : byRankRead ? 'rank_read' : 'super_admin_bypass';
    setAuthorizationPath(path);

    // SEC-002 metric. Counted only for writes that went through the bypass:
    // a super_admin reading, or writing where its own role was asked for, is
    // ordinary work and would drown the signal. The question this answers is
    // "how often did someone have to become root, and to touch what" — and a
    // rising answer means the role model does not fit the work, not that
    // someone misbehaved. Nothing here blocks: obstructing the escape hatch is
    // the surest way to have it routed around somewhere unobservable.
    const method = (req.method ?? 'GET').toUpperCase();
    if (path === 'super_admin_bypass' && !SAFE_METHODS.has(method)) {
      this.metrics.increment('cms_super_admin_bypass_total', {
        action: `${method} ${req.routeOptions?.url ?? 'unknown'}`,
        resource_type: resourceTypeOf(req.routeOptions?.url),
      });
    }
    actor.role = admin.role;
    return true;
  }
}

/**
 * The collection segment of a CMS route — `/v1/cms/places/:id/status` is about
 * places. Enough to answer "into what", without turning every id into its own
 * label and blowing up metric cardinality.
 */
function resourceTypeOf(url: string | undefined): string {
  if (!url) return 'unknown';
  const segments = url.split('/').filter(Boolean);
  const cmsIndex = segments.indexOf('cms');
  return segments[cmsIndex + 1] ?? 'unknown';
}
