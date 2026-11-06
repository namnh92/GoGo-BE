import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../domain/actor';
import { SessionRevocationService } from '../application/session-revocation.service';
import { TokenService } from '../application/token.service';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { IS_PUBLIC_KEY } from './decorators';

export const ACCESS_COOKIE = 'gogo_at';
export const REFRESH_COOKIE = 'gogo_rt';
export const CSRF_COOKIE = 'gogo_csrf';
export const CSRF_HEADER = 'x-gogo-csrf';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Driver failures may be wrapped by Drizzle. Keep this allowlist local to the
// authoritative lookup: schema, SQL, permissions and application errors must
// retain their existing handling. Never copy driver messages/causes into the
// public error or telemetry for the mapped operational failure.
function operationalLookupFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let operational = false;
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof AppError) return false;
    const code = (error as Error & { code?: string }).code;
    if (code !== undefined) {
      if (
        [
          'ECONNREFUSED',
          'ECONNRESET',
          'EPIPE',
          'ETIMEDOUT',
          'EHOSTUNREACH',
          'ENETUNREACH',
          '08000',
          '08001',
          '08003',
          '08006',
          '08007',
          '53300',
          '57P01',
          '57P02',
          '57P03',
        ].includes(code)
      ) {
        operational = true;
      } else if (
        (code === '57014' && /statement timeout/i.test(error.message)) ||
        (code === '55P03' && /lock timeout/i.test(error.message))
      ) {
        operational = true;
      } else {
        return false;
      }
    } else if (
      /^(timeout exceeded when trying to connect|connection terminated due to connection timeout|connection terminated unexpectedly|query read timeout)$/i.test(
        error.message,
      )
    ) {
      operational = true;
    }
    error = error.cause;
  }
  return operational;
}

type AuthedRequest = FastifyRequest & {
  actor?: Actor;
  cookies?: Record<string, string | undefined>;
};

/**
 * Global authentication guard — deny by default; @Public() opts a route out.
 * Accepts bearer tokens (mobile/api) or the HttpOnly access cookie (web).
 * Cookie-authenticated mutations require the CSRF double-submit header,
 * since SameSite alone does not cover all navigations (ADR-0003).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly revocations: SessionRevocationService,
    private readonly repo: IdentityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    let token: string | undefined;
    let viaCookie = false;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length);
    } else if (req.cookies?.[ACCESS_COOKIE]) {
      token = req.cookies[ACCESS_COOKIE];
      viaCookie = true;
    }
    if (!token) throw AppError.unauthorized();

    let claims;
    try {
      claims = this.tokens.verifyAccessToken(token);
    } catch {
      throw AppError.unauthorized('INVALID_TOKEN', 'Authentication required');
    }

    if (viaCookie && MUTATING.has(req.method)) {
      const csrfCookie = req.cookies?.[CSRF_COOKIE];
      const csrfHeader = req.headers[CSRF_HEADER];
      if (!csrfCookie || typeof csrfHeader !== 'string' || csrfHeader !== csrfCookie) {
        throw AppError.forbidden('CSRF_FAILED', 'Missing or invalid CSRF token');
      }
    }

    if (claims.act === 'user') {
      // Authoritative, fail-closed check: negative denylist caches can be stale.
      let session;
      try {
        session = await this.repo.findAuthSessionById(claims.sid);
      } catch (error) {
        if (!operationalLookupFailure(error)) throw error;
        throw AppError.serviceUnavailable(
          'SERVICE_UNAVAILABLE',
          'Session verification is temporarily unavailable',
        );
      }
      if (!session || session.userId !== claims.sub || session.revokedAt) {
        throw AppError.unauthorized('SESSION_REVOKED', 'Session is no longer valid');
      }
      // supersededAt only rotates refresh credentials, not access credentials.
    }

    // Logout/removal revokes the session id; the outstanding access token must
    // stop working immediately, not when it happens to expire.
    if (await this.revocations.isRevoked(claims.sid)) {
      throw AppError.unauthorized('SESSION_REVOKED', 'Session is no longer valid');
    }

    const actor: Actor = {
      type: claims.act,
      id: claims.sub,
      sessionId: claims.sid,
      ...(claims.room ? { roomId: claims.room } : {}),
    };
    req.actor = actor;
    return true;
  }
}
