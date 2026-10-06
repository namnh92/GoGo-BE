import type { LoggerService, LogLevel } from '@nestjs/common';
import type { AppLogger } from '@gogo/observability';

/**
 * Routes Nest's `Logger` into the application's pino logger.
 *
 * Without this, `new Logger(X.name).warn(...)` in a service goes to Nest's
 * console logger: plain text, outside `LOG_LEVEL`, outside the redaction and
 * serializers `createLogger` installs, and invisible to anything that reads
 * the structured stream. `main.ts` already hands pino to Fastify for request
 * logs; this hands the same instance to Nest, so one `LOG_LEVEL` and one
 * format cover boot, requests and services alike (GoGo-BE#680 review F-02).
 *
 * Nest's calling convention: `(message, ...optionalParams)`, where the last
 * string parameter is the context (the class name) and `error()` may carry a
 * stack string before it. Those become `context` and `stack` fields; an
 * `Error` instance anywhere in the parameters becomes `err`, which the pino
 * error serializer already knows how to print.
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /** `LOG_LEVEL` is pino's; Nest's per-level list is not a second source. */
  setLogLevels(_levels: LogLevel[]): void {}

  private write(
    level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace',
    message: unknown,
    params: unknown[],
  ): void {
    const fields: Record<string, unknown> = {};
    const rest = [...params];
    // Nest appends the context last. A stack trace, when present, sits just
    // before it and is a multi-line string.
    const last = rest.at(-1);
    if (typeof last === 'string' && !last.includes('\n')) {
      fields.context = rest.pop();
    }
    const stack = rest.at(-1);
    if (typeof stack === 'string' && stack.includes('\n')) {
      fields.stack = rest.pop();
    }
    const error = rest.find((p): p is Error => p instanceof Error);
    if (error) fields.err = error;
    if (message instanceof Error) {
      fields.err = message;
      this.logger[level](fields, message.message);
      return;
    }
    if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...(message as Record<string, unknown>) });
      return;
    }
    this.logger[level](fields, String(message));
  }
}
