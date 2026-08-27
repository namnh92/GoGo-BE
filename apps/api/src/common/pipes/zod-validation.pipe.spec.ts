import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const schema = z.object({ name: z.string().min(1), count: z.number().int() });
  const pipe = new ZodValidationPipe(schema);

  it('returns parsed value on success', () => {
    expect(pipe.transform({ name: 'a', count: 2 })).toEqual({ name: 'a', count: 2 });
  });

  it('throws AppError with field_errors on failure', () => {
    try {
      pipe.transform({ name: '', count: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('VALIDATION_FAILED');
      expect(appErr.httpStatus).toBe(400);
      const fields = appErr.options.fieldErrors?.map((f) => f.field);
      expect(fields).toContain('name');
      expect(fields).toContain('count');
    }
  });
});
