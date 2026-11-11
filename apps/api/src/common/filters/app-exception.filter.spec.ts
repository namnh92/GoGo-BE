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
  const send = vi.fn(),
    status = vi.fn().mockReturnValue({ send });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: 'r', log: { info: vi.fn(), error: vi.fn() } }),
    }),
  };
  new AppExceptionFilter().catch(
    new AppError(code, 'Refused', 409, { retryable: false, details: d as never }),
    host as never,
  );
  return { status, body: send.mock.calls[0]![0] };
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
