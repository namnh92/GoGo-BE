import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * SEC-004 (#62) — authenticated encryption for secrets that must survive in
 * the database but must not survive a database leak.
 *
 * AES-256-GCM: the TOTP secret has to come back out to verify a code, so this
 * is encryption rather than hashing, and it is authenticated so a tampered
 * ciphertext fails loudly instead of decrypting to noise that then fails a
 * TOTP check for the wrong reason.
 *
 * Format `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is
 * there so a future key rotation or algorithm change can be told apart from
 * corruption rather than guessed at.
 */
const VERSION = 'v1';

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    if (!keyMaterial) throw new Error('SecretBox requires key material');
    // Accepts a passphrase or a base64 key: hashed to exactly 32 bytes either
    // way, so a short or mistyped key cannot silently produce a weak cipher.
    this.key = createHash('sha256').update(keyMaterial, 'utf8').digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split('.');
    if (version !== VERSION || !iv || !tag || !ciphertext) {
      throw new Error('secret payload is not readable');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
