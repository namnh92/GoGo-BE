import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '../../shared/app-error';

export const inviteContextRequired = () =>
  AppError.unauthorized('INVITE_CONTEXT_REQUIRED', 'Invite context required');
export const inviteLookupUnavailable = () =>
  AppError.serviceUnavailable('INVITE_LOOKUP_UNAVAILABLE', 'Invite security unavailable');
export type InviteTransport = 'MOBILE_HEADER' | 'BROWSER_COOKIE';
export const CONTEXT_TTL_MS = 48 * 3600 * 1000;
const PROOF = /^[A-Za-z0-9_-]{43}$/;

export class InviteAttemptCrypto {
  constructor(private readonly secret: string) {}

  assertConfigured(): void {
    if (this.secret.length < 32) throw inviteLookupUnavailable();
  }

  private key(purpose: string): Buffer {
    this.assertConfigured();
    return Buffer.from(hkdfSync('sha256', this.secret, 'gogo-invite-attempts-v1', purpose, 32));
  }

  digest(purpose: string, ...parts: string[]): string {
    return createHmac('sha256', this.key(purpose)).update(JSON.stringify(parts)).digest('hex');
  }

  proofHash(token: string): string {
    if (!PROOF.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) {
      throw inviteContextRequired();
    }
    return createHash('sha256').update(token).digest('hex');
  }

  token(): string {
    return randomBytes(32).toString('base64url');
  }
  csrf(id: string): string {
    return this.digest('csrf', id);
  }
  matchesCsrf(id: string, value: string | undefined): boolean {
    return (
      typeof value === 'string' &&
      /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(this.csrf(id), 'hex'), Buffer.from(value, 'hex'))
    );
  }

  seal(token: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key('replay-encryption'), iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  open(ciphertext: string, aad: string): string {
    try {
      const bytes = Buffer.from(ciphertext, 'base64url');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key('replay-encryption'),
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw inviteLookupUnavailable();
    }
  }
}
