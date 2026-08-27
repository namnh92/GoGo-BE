import type { PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { AppError } from '../errors/app-error';

/**
 * Validates request bodies/queries/params against a zod schema and converts
 * failures into the standard error envelope with per-field errors.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
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
