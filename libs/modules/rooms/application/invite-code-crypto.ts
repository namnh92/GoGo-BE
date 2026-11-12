import type { MetricsPort } from '@gogo/observability';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'node:crypto';

export type InviteFoundationFailure =
  | 'KEYS_NOT_READY'
  | 'CIPHERTEXT_INVALID'
  | 'INVALID_INPUT'
  | 'SCHEMA_NOT_READY'
  | 'STORAGE_UNAVAILABLE'
  | 'COLLISIONS_EXHAUSTED'
  | 'OPEN_GENERATION_EXISTS'
  | 'HOST_REQUIRED'
  | 'ROOM_NOT_ELIGIBLE'
  | 'INVITATION_STATE_CHANGED'
  | 'INVITATIONS_REISSUE_REQUIRED'
  | 'AUTOMATIC_ISSUANCE_SUPPRESSED'
  | 'USER_NOT_FOUND';

/** Fixed messages only: never attach a driver/crypto error, parameters, or config. */
export class InviteFoundationError extends Error {
  constructor(readonly code: InviteFoundationFailure) {
    super(code);
  }
}

/** Supplied by the process's config/secret-manager adapter, before any DB transaction. */
export type InviteKeyConfig = {
  lookupKey: string;
  replayKey: string;
  bucketKey: string;
  activeEncryptionVersion: string;
  encryptionKeys: Record<string, string>;
};
export type InviteCiphertext = { codeCiphertext: string; encryptionKeyVersion: string };
export type InviteCodeBinding = { roomId: string; generationId: string };

const codePattern = /^[0-9]{6}$/;
const versionPattern = /^[A-Za-z0-9_-]{1,64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertInviteCode(code: string): void {
  if (!codePattern.test(code)) throw new InviteFoundationError('INVALID_INPUT');
}

export class InviteCodeCrypto {
  // Private slots also keep accidental logger/JSON inspection from exposing material.
  #lookup: Buffer;
  #replay: Buffer;
  #bucket: Buffer;
  #encryption = new Map<string, Buffer>();
  #active: string;

  constructor(config: InviteKeyConfig) {
    const key = (value: string): Buffer => {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        throw new InviteFoundationError('KEYS_NOT_READY');
      return Buffer.from(value, 'hex');
    };
    this.#lookup = key(config.lookupKey);
    this.#replay = key(config.replayKey);
    this.#bucket = key(config.bucketKey);
    this.#active = config.activeEncryptionVersion;
    if (!versionPattern.test(this.#active)) throw new InviteFoundationError('KEYS_NOT_READY');
    for (const [version, value] of Object.entries(config.encryptionKeys)) {
      if (!versionPattern.test(version)) throw new InviteFoundationError('KEYS_NOT_READY');
      this.#encryption.set(version, key(value));
    }
    const all = [this.#lookup, this.#replay, this.#bucket, ...this.#encryption.values()];
    if (
      !this.#encryption.has(this.#active) ||
      new Set(all.map((v) => v.toString('hex'))).size !== all.length
    )
      throw new InviteFoundationError('KEYS_NOT_READY');
  }

  /** node:crypto.randomInt uses rejection sampling; zero is a valid value. */
  generateCode(): string {
    return randomInt(1_000_000).toString().padStart(6, '0');
  }
  generateHostShareId(): string {
    return randomBytes(16).toString('base64url');
  }
  lookupCode(code: string): string {
    assertInviteCode(code);
    return createHmac('sha256', this.#lookup)
      .update('gogo.invite.lookup.v1\0')
      .update(code)
      .digest('hex');
  }
  replayFingerprint(input: Buffer): string {
    return createHmac('sha256', this.#replay)
      .update('gogo.invite.replay.v1\0')
      .update(input)
      .digest('hex');
  }
  bucketDigest(input: Buffer): string {
    return createHmac('sha256', this.#bucket)
      .update('gogo.invite.bucket.v1\0')
      .update(input)
      .digest('hex');
  }
  encryptCode(code: string, binding: InviteCodeBinding): InviteCiphertext {
    assertInviteCode(code);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#encryption.get(this.#active)!, nonce);
    cipher.setAAD(aad(binding));
    const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return {
      codeCiphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url'),
      encryptionKeyVersion: this.#active,
    };
  }
  decryptCode(stored: InviteCiphertext, binding: InviteCodeBinding): string {
    const key = this.#encryption.get(stored.encryptionKeyVersion);
    if (!key) throw new InviteFoundationError('KEYS_NOT_READY');
    try {
      const data = Buffer.from(stored.codeCiphertext, 'base64url');
      if (data.length !== 34 || data.toString('base64url') !== stored.codeCiphertext)
        throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(data.subarray(12, 28));
      const code = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
      if (!codePattern.test(code)) throw new Error();
      return code;
    } catch {
      throw new InviteFoundationError('CIPHERTEXT_INVALID');
    }
  }
}
function aad(binding: InviteCodeBinding): Buffer {
  if (!uuidPattern.test(binding.roomId) || !uuidPattern.test(binding.generationId))
    throw new InviteFoundationError('INVALID_INPUT');
  return Buffer.from(
    JSON.stringify([
      'gogo.room-invite.code',
      1,
      binding.roomId.toLowerCase(),
      binding.generationId.toLowerCase(),
    ]),
  );
}

/** Config loading happens in the composition root, outside database transactions. */
export function loadInviteCodeCrypto(
  config: InviteKeyConfig,
  metrics: MetricsPort,
): InviteCodeCrypto {
  try {
    const crypto = new InviteCodeCrypto(config);
    metrics.increment('room_invite_foundation_readiness_total', {
      operation: 'keys',
      result: 'ready',
    });
    return crypto;
  } catch {
    metrics.increment('room_invite_foundation_readiness_total', {
      operation: 'keys',
      result: 'unavailable',
    });
    throw new InviteFoundationError('KEYS_NOT_READY');
  }
}
