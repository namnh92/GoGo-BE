import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@gogo/modules';
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
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, header, removeHeader }),
      getRequest: () => ({ id: 'r', log: { info: vi.fn(), error: vi.fn() } }),
    }),
  };
  new AppExceptionFilter().catch(error, host as never);
  return { status, body: send.mock.calls[0]![0], header, removeHeader };
}
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
