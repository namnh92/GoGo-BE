import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';

type ErrorEnvelope = {
  code: string;
  message: string;
  field_errors: { field: string; code: string; message: string }[];
  request_id: string;
  retryable: boolean;
};

/**
 * Maps every failure to the public error envelope. Internal error details
 * (stack, cause, driver errors) never leak to clients; they go to logs only.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = String(request.id ?? 'unknown');

    let status = 500;
    let envelope: ErrorEnvelope = {
      code: 'INTERNAL',
      message: 'Internal server error',
      field_errors: [],
      request_id: requestId,
      retryable: true,
    };

    if (exception instanceof AppError) {
      status = exception.httpStatus;
      envelope = {
        code: exception.code,
        message: exception.message,
        field_errors: exception.options.fieldErrors ?? [],
        request_id: requestId,
        retryable: exception.options.retryable ?? false,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      envelope = {
        code: status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : `HTTP_${status}`,
        message: exception.message,
        field_errors: [],
        request_id: requestId,
        retryable: status >= 500,
      };
    }

    if (status >= 500) {
      request.log.error({ err: exception, request_id: requestId }, 'unhandled error');
      // No-op unless Sentry.init ran (SENTRY_DSN set).
      Sentry.captureException(exception, { extra: { request_id: requestId } });
    } else {
      request.log.info({ code: envelope.code, request_id: requestId }, 'request failed');
    }

    /*
     * GoGo-BE#631. Two limiters can speak on one response: the coarse
     * `@fastify/rate-limit` flood net, which sets `x-ratelimit-*` on its way
     * through, and the per-action / per-actor guard, which is what actually
     * refuses these. Before this, a guard 429 went out with no `Retry-After`
     * at all and carrying the flood net's counters — a rejected request
     * reporting `x-ratelimit-remaining: 1177`, which is true of that budget and
     * a lie about the caller's.
     *
     * So the wait comes from the window that refused, and the other limiter's
     * numbers are removed from this one response rather than left to mislead.
     * No limit changes, and every other response keeps its headers.
     */
    if (status === 429 && exception instanceof AppError) {
      const wait = exception.options.retryAfterSeconds;
      if (wait !== undefined) {
        void reply.header('Retry-After', String(Math.max(1, Math.ceil(wait))));
        for (const stale of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
          void reply.removeHeader(stale);
        }
      }
    }

    void reply.status(status).send(envelope);
  }
}
