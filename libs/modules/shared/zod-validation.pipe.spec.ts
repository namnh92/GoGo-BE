import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe missing inputs', () => {
  it('preserves omitted optional query values', () => {
    const pipe = new ZodValidationPipe(z.string().max(2048).optional());
    expect(pipe.transform(undefined, { type: 'query', data: 'cursor' })).toBeUndefined();
  });

  it('lets query preprocessing supply the default and still rejects invalid kinds', () => {
    const pipe = new ZodValidationPipe(
      z.preprocess(
        (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
        z.array(z.enum(['invite', 'plan_ready'])),
      ),
    );
    const metadata = { type: 'query' as const, data: 'kinds' };
    expect(pipe.transform(undefined, metadata)).toEqual([]);
    expect(pipe.transform('invite', metadata)).toEqual(['invite']);
    expect(pipe.transform(['plan_ready', 'invite'], metadata)).toEqual(['plan_ready', 'invite']);
    expect(() => pipe.transform('unknown', metadata)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', httpStatus: 400 }),
    );
  });

  it('still normalizes an omitted body for optional fields and rejects missing required fields', () => {
    const optional = new ZodValidationPipe(z.object({ enabled: z.boolean().default(true) }));
    expect(optional.transform(undefined, { type: 'body' })).toEqual({ enabled: true });
    const required = new ZodValidationPipe(z.object({ through: z.string() }));
    expect(() => required.transform(undefined, { type: 'body' })).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        options: { fieldErrors: [expect.objectContaining({ field: 'through' })] },
      }),
    );
  });
});
