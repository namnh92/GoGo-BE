import { AppError } from '../../shared/app-error';
import { expect, it, vi } from 'vitest';
import {
  InviteAttemptController,
  inviteAttemptRequest,
  inviteBootstrapSchema,
} from './invite-attempt.controller';
import type { InviteAttemptService } from '../application/invite-attempt.service';
it('sets Secure host-only HttpOnly Lax cookie with remaining TTL even on insecure dev config', async () => {
  const expiresAt = '2026-11-14T00:00:00.000Z';
  const body = { expiresAt, csrfToken: 'separate-csrf' };
  const service = {
    bootstrap: vi.fn(async () => ({ body, cookie: 'opaque-proof', maxAge: 172799 })),
  };
  const setCookie = vi.fn();
  const controller = new InviteAttemptController(service as unknown as InviteAttemptService);
  expect(
    await controller.bootstrap(
      { transport: 'BROWSER_COOKIE' },
      { ip: '203.0.113.1', headers: {}, cookies: {} } as never,
      { setCookie } as never,
    ),
  ).toEqual(body);
  expect(setCookie).toHaveBeenCalledWith('__Host-gogo_invite_ctx', 'opaque-proof', {
    secure: true,
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    expires: new Date(expiresAt),
    maxAge: 172799,
  });
  expect(setCookie.mock.calls[0]![2]).not.toHaveProperty('domain');
  expect(setCookie).toHaveBeenCalledWith('__Host-gogo_invite_csrf', body.csrfToken, {
    secure: true,
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    expires: new Date(expiresAt),
    maxAge: 172799,
  });
});
it('uses only vetted edgeClientIp or req.ip, never arbitrary forwarded headers', () => {
  expect(
    inviteAttemptRequest({
      ip: '203.0.113.1',
      edgeClientIp: '198.51.100.1',
      headers: { 'x-forwarded-for': 'evil' },
      cookies: {},
    } as never).ip,
  ).toBe('198.51.100.1');
  expect(
    inviteAttemptRequest({ ip: '203.0.113.1', headers: { 'x-gogo-client-ip': 'evil' } } as never)
      .ip,
  ).toBe('203.0.113.1');
});
it('does not widen CODE6 endpoints or accept client-supplied context IDs/secrets', () => {
  expect(
    inviteBootstrapSchema.safeParse({ transport: 'MOBILE_HEADER', contextId: 'chosen' }).success,
  ).toBe(false);
});

it('expires unusable browser proof cookies on 401 so a client can explicitly bootstrap again', async () => {
  const failure = AppError.unauthorized('INVITE_CONTEXT_REQUIRED', 'Invite context required');
  const controller = new InviteAttemptController({
    bootstrap: vi.fn().mockRejectedValue(failure),
  } as unknown as InviteAttemptService);
  const clearCookie = vi.fn();
  await expect(
    controller.bootstrap(
      { transport: 'BROWSER_COOKIE' },
      { ip: '203.0.113.1', headers: {}, cookies: {} } as never,
      { clearCookie } as never,
    ),
  ).rejects.toBe(failure);
  expect(clearCookie).toHaveBeenCalledWith('__Host-gogo_invite_ctx', {
    secure: true,
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
  });
  expect(clearCookie).toHaveBeenCalledWith('__Host-gogo_invite_csrf', {
    secure: true,
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
  });
});

it('recovery returns body only, without success cookie writes or key requirement', async () => {
  const body = { expiresAt: '2026-11-14T00:00:00.000Z', csrfToken: 'a'.repeat(64) };
  const recoverCsrf = vi.fn().mockResolvedValue(body);
  const controller = new InviteAttemptController({
    recoverCsrf,
  } as unknown as InviteAttemptService);
  const setCookie = vi.fn();
  const clearCookie = vi.fn();
  expect(
    await controller.recoverCsrf(
      {},
      {
        ip: '203.0.113.1',
        headers: { 'content-type': 'application/json; charset=utf-8' },
      } as never,
      { setCookie, clearCookie } as never,
    ),
  ).toEqual(body);
  expect(setCookie).not.toHaveBeenCalled();
  expect(clearCookie).not.toHaveBeenCalled();
});

it.each([undefined, null, [], 'text', { transport: 'BROWSER_COOKIE' }])(
  'requires an explicit empty object: %j',
  async (body) => {
    const recoverCsrf = vi.fn();
    const controller = new InviteAttemptController({
      recoverCsrf,
    } as unknown as InviteAttemptService);
    await expect(
      controller.recoverCsrf(
        body,
        { headers: { 'content-type': 'application/json' } } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ httpStatus: 400, code: 'VALIDATION_FAILED' });
    expect(recoverCsrf).not.toHaveBeenCalled();
  },
);

it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/problem+json'])(
  'rejects non-JSON media type %s',
  async (contentType) => {
    const controller = new InviteAttemptController({} as InviteAttemptService);
    await expect(
      controller.recoverCsrf(
        {},
        { headers: { 'content-type': contentType } } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ httpStatus: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
  },
);

it.each([
  { code: 'INVITE_CONTEXT_REQUIRED', status: 401, header: undefined, clears: true },
  { code: 'INVITE_CONTEXT_REQUIRED', status: 401, header: '', clears: false },
  { code: 'CSRF_FAILED', status: 403, header: undefined, clears: false },
  { code: 'RATE_LIMITED', status: 429, header: undefined, clears: false },
  { code: 'INVITE_LOOKUP_UNAVAILABLE', status: 503, header: undefined, clears: false },
])('recovery cleanup policy: $code header=$header', async ({ code, status, header, clears }) => {
  const failure = new AppError(code, 'safe', status);
  const controller = new InviteAttemptController({
    recoverCsrf: vi.fn().mockRejectedValue(failure),
  } as unknown as InviteAttemptService);
  const clearCookie = vi.fn();
  await expect(
    controller.recoverCsrf(
      {},
      {
        headers: { 'content-type': 'application/json', 'x-gogo-invite-context': header },
        cookies: {},
      } as never,
      { clearCookie } as never,
    ),
  ).rejects.toBe(failure);
  expect(clearCookie).toHaveBeenCalledTimes(clears ? 2 : 0);
  if (clears) {
    expect(clearCookie).toHaveBeenCalledWith('__Host-gogo_invite_ctx', {
      secure: true,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
    });
    expect(clearCookie).toHaveBeenCalledWith('__Host-gogo_invite_csrf', {
      secure: true,
      httpOnly: false,
      path: '/',
      sameSite: 'lax',
    });
  }
});
