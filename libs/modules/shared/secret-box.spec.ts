import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

describe('SecretBox (#62)', () => {
  const box = new SecretBox('a-key-that-is-long-enough-for-tests');

  it('round-trips a secret', () => {
    const sealed = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(box.decrypt(sealed)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never puts the plaintext in the ciphertext', () => {
    expect(box.encrypt('JBSWY3DPEHPK3PXP')).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext each time', () => {
    // A deterministic ciphertext would leak that two admins share a secret.
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('refuses a payload encrypted under another key', () => {
    const other = new SecretBox('a-different-key-entirely');
    expect(() => box.decrypt(other.encrypt('secret'))).toThrow();
  });

  it('refuses a tampered ciphertext instead of returning noise', () => {
    const sealed = box.encrypt('secret');
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString('base64url');
    // Authenticated: tampering fails here rather than producing garbage that
    // then fails a TOTP check for a misleading reason.
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  it('refuses an unversioned or truncated payload', () => {
    expect(() => box.decrypt('not-a-payload')).toThrow('not readable');
    expect(() => box.decrypt('v2.a.b.c')).toThrow('not readable');
  });

  it('refuses to build without key material', () => {
    expect(() => new SecretBox('')).toThrow();
  });
});
