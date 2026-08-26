import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * argon2id with OWASP baseline parameters (ADR-0003). verifyOrBurn keeps
 * login timing identical whether or not the account exists, defeating
 * user-enumeration by response timing.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  raw: false,
} as const;

// A real argon2id hash of an unknowable random value, used as the comparison
// target when the account does not exist.
const DUMMY_HASH_PROMISE = argon2.hash('gogo-dummy-' + Math.random().toString(36), ARGON2_OPTIONS);

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Constant-shape verify for missing accounts: always runs a real argon2 verify. */
  async verifyOrBurn(hash: string | null | undefined, plain: string): Promise<boolean> {
    if (hash) return this.verify(hash, plain);
    await this.verify(await DUMMY_HASH_PROMISE, plain);
    return false;
  }
}
