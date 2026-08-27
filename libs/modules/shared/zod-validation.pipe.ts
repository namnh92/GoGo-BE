import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import { AppError } from './app-error';

/** Validates request input against a zod schema → standard error envelope. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  // Input type is unknown so schemas with coercion/transform/refine all fit.
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    // Fastify hands `undefined` for a body-less request. Endpoints whose
    // fields are all optional must still accept that (POST without a body),
    // so normalize to {} and let the schema decide — a schema with required
    // fields still fails, but with per-field errors instead of "(root)".
    const input = value === undefined ? {} : value;
    const result = this.schema.safeParse(input);
    if (!result.success) {
      throw AppError.badRequest(
        'VALIDATION_FAILED',
        'Request validation failed',
        result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
