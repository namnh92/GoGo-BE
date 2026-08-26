import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

const service = new PasswordService();

describe('PasswordService', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await service.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await service.verify(hash, 'wrong')).toBe(false);
  });

  it('verifyOrBurn returns false for missing hash but still does real work', async () => {
    const start = performance.now();
    const result = await service.verifyOrBurn(null, 'anything');
    const elapsed = performance.now() - start;
    expect(result).toBe(false);
    // A real argon2 verify ran (guards against enumeration-by-timing).
    expect(elapsed).toBeGreaterThan(5);
  });

  it('verify tolerates malformed hashes without throwing', async () => {
    expect(await service.verify('not-a-hash', 'x')).toBe(false);
  });
});
