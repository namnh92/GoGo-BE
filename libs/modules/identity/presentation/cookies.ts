import { randomBytes } from 'node:crypto';
// Side-effect import: augments FastifyReply with setCookie/clearCookie types.
import '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from './auth.guard';

export type CookieOptions = {
  secure: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /**
   * Where the refresh cookie is sent. Scoped to the endpoint that consumes it
   * so it never rides along on ordinary requests; CMS refreshes at its own
   * path, so the caller says which (SEC-003).
   */
  refreshPath?: string | undefined;
};

/**
 * Web session cookies (ADR-0003): HttpOnly + SameSite=Lax; refresh cookie
 * path-scoped to the refresh endpoint; CSRF cookie readable by JS for the
 * double-submit header. Mobile clients ignore cookies and use the body.
 */
export function setAuthCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken?: string },
  opts: CookieOptions,
): void {
  reply.setCookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: opts.accessTtlSeconds,
  });
  if (tokens.refreshToken) {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: opts.secure,
      sameSite: 'lax',
      path: opts.refreshPath ?? '/v1/auth/refresh',
      maxAge: opts.refreshTtlSeconds,
    });
  }
  reply.setCookie(CSRF_COOKIE, randomBytes(16).toString('base64url'), {
    httpOnly: false,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: opts.refreshTtlSeconds,
  });
}

export function clearAuthCookies(
  reply: FastifyReply,
  secure: boolean,
  refreshPath = '/v1/auth/refresh',
): void {
  // The refresh cookie only clears on the path it was set for, so the caller
  // has to name it — CMS sets its own (SEC-003).
  for (const [name, path] of [
    [ACCESS_COOKIE, '/'],
    [REFRESH_COOKIE, refreshPath],
    [CSRF_COOKIE, '/'],
  ] as const) {
    reply.setCookie(name, '', {
      httpOnly: name !== CSRF_COOKIE,
      secure,
      sameSite: 'lax',
      path,
      maxAge: 0,
    });
  }
}
