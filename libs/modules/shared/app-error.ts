export type FieldError = { field: string; code: string; message: string };

/**
 * Canonical application error. Maps 1:1 to the public error envelope
 * `{ code, message, field_errors, request_id, retryable }`.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    override readonly message: string,
    readonly httpStatus: number,
    readonly options: {
      fieldErrors?: FieldError[];
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, fieldErrors?: FieldError[]): AppError {
    return new AppError(code, message, 400, { ...(fieldErrors ? { fieldErrors } : {}) });
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required'): AppError {
    return new AppError(code, message, 401);
  }

  static forbidden(code = 'FORBIDDEN', message = 'Not allowed'): AppError {
    return new AppError(code, message, 403);
  }

  static notFound(code = 'NOT_FOUND', message = 'Resource not found'): AppError {
    return new AppError(code, message, 404);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(code, message, 409);
  }

  static gone(code: string, message: string): AppError {
    return new AppError(code, message, 410);
  }

  static tooManyRequests(message = 'Rate limit exceeded'): AppError {
    return new AppError('RATE_LIMITED', message, 429, { retryable: true });
  }

  static internal(message = 'Internal server error'): AppError {
    return new AppError('INTERNAL', message, 500, { retryable: true });
  }

  /**
   * A dependency this route needs is not answering, or was never configured.
   * `retryable` separates the two: a provider outage clears on its own, a
   * missing configuration never does, and a client that keeps retrying the
   * second is generating load instead of a support ticket.
   */
  static serviceUnavailable(code: string, message: string, retryable = true): AppError {
    return new AppError(code, message, 503, { retryable });
  }
}
