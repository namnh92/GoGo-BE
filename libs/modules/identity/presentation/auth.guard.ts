import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../domain/actor';
import { TokenService } from '../application/token.service';
import { IS_PUBLIC_KEY } from './decorators';

export const ACCESS_COOKIE = 'gogo_at';
export const REFRESH_COOKIE = 'gogo_rt';
export const CSRF_COOKIE = 'gogo_csrf';
export const CSRF_HEADER = 'x-gogo-csrf';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  ) {}

  canActivate(context: ExecutionContext): boolean {
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
