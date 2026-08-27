import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
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
    } else {
      request.log.info({ code: envelope.code, request_id: requestId }, 'request failed');
    }

    void reply.status(status).send(envelope);
  }
}
