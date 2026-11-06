import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { loginSchema, registerSchema } from './dtos';

const pipe = new ZodValidationPipe(registerSchema);
const registration = (password: string) => ({
  email: 'policy@gogo.id.vn',
  password,
  displayName: 'An',
});

describe('consumer registration password policy (owner 2026-11-06, Mobile#482)', () => {
  it.each([
    ['7 characters', 'Abcde1!'],
    ['8 without uppercase', 'abcdef1!'],
    ['8 without lowercase', 'ABCDEF1!'],
    ['8 without digit', 'Abcdefg!'],
    ['8 without special', 'Abcdef12'],
    ['long without uppercase', 'abcdefghij1!'],
    ['long without lowercase', 'ABCDEFGHIJ1!'],
    ['long without digit', 'Abcdefghijk!'],
    ['long without special', 'Abcdefghij12'],
    ['129 characters', `Aa1!${'x'.repeat(125)}`],
    ['supplementary characters exceeding the UTF-16 cap', `Aa1!${'😀'.repeat(124)}`],
    ['uncased letters are not uppercase', '中文ăbcde1!'],
    ['Unicode letters are not special', 'Abcdef1Đ'],
    ['combining marks are not special', 'Abcdef1\u0306'],
    ['Unicode numbers are not special', 'Abcdef1²'],
  ])('rejects %s with the existing password field error', (_label, password) => {
    let error: unknown;
    try {
      pipe.transform(registration(password));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    const failure = error as AppError;
    expect(failure.httpStatus).toBe(400);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.options.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
    );
    expect(JSON.stringify(failure)).not.toContain(password);
  });

  it.each([
    ['8 characters', 'Abcdef1!'],
    ['128 characters', `Aa1!${'x'.repeat(124)}`],
    ['Vietnamese uppercase and lowercase', 'Đăbcde1!'],
    ['Vietnamese lowercase only', 'Aăăăăă1!'],
    ['other Unicode cased letters', 'Ωжbcde1!'],
    ['decomposed Vietnamese letters', 'Đa\u0306bcd1!'],
    ['emoji special character', 'Abcde1!😀'],
    ['128 UTF-16 units including emoji', `Aa1!${'😀'.repeat(62)}`],
    ['whitespace special character', 'Abcdef1 '],
  ])('accepts %s without changing the password', (_label, password) => {
    expect(pipe.transform(registration(password)).password).toBe(password);
  });

  it('keeps legacy passwords valid for login input', () => {
    expect(loginSchema.parse({ email: 'old@gogo.id.vn', password: 'old' }).password).toBe('old');
  });
});
