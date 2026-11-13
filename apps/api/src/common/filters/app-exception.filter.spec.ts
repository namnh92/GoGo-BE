import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { AppError, InviteTtlSettingUnavailable } from '@gogo/modules';
import { AppExceptionFilter } from './app-exception.filter';
const details = {
  creditBalance: 20,
  creditReserved: 9,
  creditAvailable: 11,
  requiredCredits: 12,
  remainingToday: 0 as const,
  resetsAt: '2026-11-11T17:00:00Z',
};
function render(code: string, d: unknown = details) {
  return renderError(new AppError(code, 'Refused', 409, { retryable: false, details: d as never }));
}
function renderError(error: AppError) {
  const send = vi.fn(),
    status = vi.fn().mockReturnValue({ send }),
    header = vi.fn(),
    removeHeader = vi.fn();
  const log = { info: vi.fn(), error: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, header, removeHeader }),
      getRequest: () => ({ id: 'r', log }),
    }),
  };
  new AppExceptionFilter().catch(error, host as never);
  return { status, body: send.mock.calls[0]![0], header, removeHeader, log };
}
it.each(['missing', 'invalid', 'db_error'] as const)(
  '#906 transports %s with fixed log fields only',
  (reason) => {
    const r = renderError(new InviteTtlSettingUnavailable(reason));
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.body).toMatchObject({
      code: 'INVITE_TTL_SETTING_UNAVAILABLE',
      retryable: reason === 'db_error',
      request_id: 'r',
    });
    expect(r.log.error).toHaveBeenCalledExactlyOnceWith(
      { operation: 'room_invite_issue', reason, request_id: 'r' },
      'invite setting unavailable',
    );
  },
);
describe('#851 typed credit refusal transport', () => {
  it('forwards exactly the allowlisted fields with 409 and retryable false', () => {
    const r = render('ASSISTANT_INSUFFICIENT_CREDIT', {
      ...details,
      providerId: 'private',
      cause: 'private',
    });
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.body).toEqual({
      code: 'ASSISTANT_INSUFFICIENT_CREDIT',
      message: 'Refused',
      field_errors: [],
      request_id: 'r',
      retryable: false,
      details,
    });
  });
  it('does not forward details for another code or malformed values', () => {
    expect(render('OTHER').body).not.toHaveProperty('details');
    for (const d of [
      { ...details, requiredCredits: 0 },
      { ...details, creditBalance: -1 },
      { ...details, resetsAt: 'bad' },
      { ...details, creditAvailable: Infinity },
    ])
      expect(render('ASSISTANT_INSUFFICIENT_CREDIT', d).body).not.toHaveProperty('details');
  });
});

describe('error backoff transport (#879)', () => {
  it('returns the host-transfer in-flight backoff without removing rate-limit counters', () => {
    const r = renderError(
      new AppError(
        'IDEMPOTENT_REQUEST_IN_FLIGHT',
        'Operation is busy; retry with the same key',
        409,
        {
          retryable: true,
          retryAfterSeconds: 1,
        },
      ),
    );
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.header).toHaveBeenCalledExactlyOnceWith('Retry-After', '1');
    expect(r.removeHeader).not.toHaveBeenCalled();
    expect(r.body).toEqual({
      code: 'IDEMPOTENT_REQUEST_IN_FLIGHT',
      message: 'Operation is busy; retry with the same key',
      field_errors: [],
      request_id: 'r',
      retryable: true,
    });
  });

  it('keeps limiter backoff rounded up and removes the coarse limiter counters', () => {
    const r = renderError(AppError.tooManyRequests('Rate limit exceeded', 1.2));
    expect(r.status).toHaveBeenCalledWith(429);
    expect(r.header).toHaveBeenCalledExactlyOnceWith('Retry-After', '2');
    expect(r.removeHeader.mock.calls).toEqual([
      ['x-ratelimit-limit'],
      ['x-ratelimit-remaining'],
      ['x-ratelimit-reset'],
    ]);
  });

  it('keeps explicit backoff at least one second', () => {
    const r = renderError(AppError.tooManyRequests('Rate limit exceeded', 0));
    expect(r.header).toHaveBeenCalledExactlyOnceWith('Retry-After', '1');
  });

  it.each([
    AppError.conflict('HOST_VERSION_CONFLICT', 'Ownership term changed'),
    AppError.tooManyRequests(),
  ])('does not invent backoff or clear counters without an explicit hint: $code', (error) => {
    const r = renderError(error);
    expect(r.header).not.toHaveBeenCalled();
    expect(r.removeHeader).not.toHaveBeenCalled();
  });
});
it('#891 carries 409 in-flight Retry-After through the app filter', () => {
  const header = vi.fn(),
    removeHeader = vi.fn(),
    send = vi.fn();
  const reply = { header, removeHeader, status: vi.fn().mockReturnValue({ send }) };
  new AppExceptionFilter().catch(
    new AppError('IDEMPOTENCY_IN_PROGRESS', 'Bootstrap in progress', 409, {
      retryable: true,
      retryAfterSeconds: 1,
    }),
    {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ id: 'i05', log: { info: vi.fn(), error: vi.fn() } }),
      }),
    } as never,
  );
  expect(header).toHaveBeenCalledWith('Retry-After', '1');
  expect(reply.status).toHaveBeenCalledWith(409);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS', retryable: true }),
  );
});

it.each([400, 415])(
  '#891 normalizes recovery parser error %s without credential echo',
  (statusCode) => {
    const send = vi.fn();
    const status = vi.fn().mockReturnValue({ send });
    for (const url of ['/v1/invite-attempt-contexts/csrf', '/v1/invite-attempt-contexts/csrf/']) {
      new AppExceptionFilter().catch(new HttpException('private-parser-body-marker', statusCode), {
        switchToHttp: () => ({
          getResponse: () => ({ status }),
          getRequest: () => ({ url, id: 'i05', log: { info: vi.fn(), error: vi.fn() } }),
        }),
      } as never);
      expect(status).toHaveBeenCalledWith(statusCode);
      expect(send).toHaveBeenLastCalledWith({
        code: statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_FAILED',
        message: expect.any(String),
        field_errors: [],
        request_id: 'i05',
        retryable: false,
      });
      expect(JSON.stringify(send.mock.calls)).not.toContain('private-parser-body-marker');
    }
  },
);
