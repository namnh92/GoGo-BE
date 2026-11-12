import { randomBytes, randomUUID, createHash, randomInt } from 'node:crypto';
import type * as CryptoModule from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { InviteCodeCrypto, loadInviteCodeCrypto, type InviteKeyConfig } from './invite-code-crypto';

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof CryptoModule>();
  return { ...crypto, randomInt: vi.fn((max: number) => crypto.randomInt(max)) };
});

export function keyConfig(): InviteKeyConfig {
  return {
    lookupKey: randomBytes(32).toString('hex'),
    replayKey: randomBytes(32).toString('hex'),
    bucketKey: randomBytes(32).toString('hex'),
    activeEncryptionVersion: 'v1',
    encryptionKeys: { v1: randomBytes(32).toString('hex') },
  };
}
const binding = () => ({ roomId: randomUUID(), generationId: randomUUID() });

describe('I03 credential crypto', () => {
  it('uses uniform randomInt over the full namespace and preserves zero/leading zeros', () => {
    const crypto = new InviteCodeCrypto(keyConfig());
    const generator = vi.mocked(randomInt as (max: number) => number);
    generator.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(999999);
    expect([crypto.generateCode(), crypto.generateCode(), crypto.generateCode()]).toEqual([
      '000000',
      '000001',
      '999999',
    ]);
    expect(generator).toHaveBeenCalledWith(1_000_000);
    for (const value of ['000000', '000001', '099999', '999999']) {
      const b = binding();
      expect(crypto.decryptCode(crypto.encryptCode(value, b), b)).toBe(value);
    }
    for (let n = 0; n < 100; n += 1) {
      expect(crypto.generateCode()).toMatch(/^[0-9]{6}$/);
      expect(Buffer.from(crypto.generateHostShareId(), 'base64url')).toHaveLength(16);
    }
  });
  it('HMACs with a separate purpose, secret and deterministic namespace', () => {
    const config = keyConfig();
    const crypto = new InviteCodeCrypto(config);
    const code = '000000';
    const data = Buffer.from(code);
    expect(crypto.lookupCode(code)).toBe(new InviteCodeCrypto(config).lookupCode(code));
    expect(crypto.lookupCode(code)).not.toBe(createHash('sha256').update(code).digest('hex'));
    expect(
      new Set([crypto.lookupCode(code), crypto.replayFingerprint(data), crypto.bucketDigest(data)])
        .size,
    ).toBe(3);
    expect(crypto.lookupCode(code)).not.toBe(new InviteCodeCrypto(keyConfig()).lookupCode(code));
    for (const invalid of ['12345', '1234567', ' 123456', '１２３４５６', '1e0000'])
      expect(() => crypto.lookupCode(invalid)).toThrow('INVALID_INPUT');
  });
  it('authenticates ciphertext, nonce, tag and room/generation binding without leaking native errors', () => {
    const crypto = new InviteCodeCrypto(keyConfig());
    const b = binding();
    const stored = crypto.encryptCode('000001', b);
    expect(stored.codeCiphertext).toHaveLength(46);
    expect(crypto.encryptCode('000001', b)).not.toEqual(stored);
    for (const offset of [0, 12, 28, 33]) {
      const bytes = Buffer.from(stored.codeCiphertext, 'base64url');
      bytes[offset]! ^= 1;
      expect(() =>
        crypto.decryptCode({ ...stored, codeCiphertext: bytes.toString('base64url') }, b),
      ).toThrow('CIPHERTEXT_INVALID');
    }
    for (const codeCiphertext of ['', stored.codeCiphertext + '=', '!'.repeat(46)])
      expect(() => crypto.decryptCode({ ...stored, codeCiphertext }, b)).toThrow(
        'CIPHERTEXT_INVALID',
      );
    expect(() => crypto.decryptCode(stored, { ...b, roomId: randomUUID() })).toThrow(
      'CIPHERTEXT_INVALID',
    );
    expect(() => crypto.decryptCode(stored, { ...b, generationId: randomUUID() })).toThrow(
      'CIPHERTEXT_INVALID',
    );
  });
  it('reads retained key versions after encryption rotation and fails closed for a removed version', () => {
    const config = keyConfig();
    const b = binding();
    const old = new InviteCodeCrypto(config).encryptCode('000000', b);
    const next: InviteKeyConfig = {
      ...config,
      activeEncryptionVersion: 'v2',
      encryptionKeys: { ...config.encryptionKeys, v2: randomBytes(32).toString('hex') },
    };
    const reader = new InviteCodeCrypto(next);
    expect(reader.decryptCode(old, b)).toBe('000000');
    expect(reader.encryptCode('000000', b).encryptionKeyVersion).toBe('v2');
    delete next.encryptionKeys.v1;
    expect(() => new InviteCodeCrypto(next).decryptCode(old, b)).toThrow('KEYS_NOT_READY');
  });
  it('refuses missing/malformed/reused keys; emits bounded readiness and hides material from inspection', () => {
    const config = keyConfig();
    const metrics = new NoopMetrics();
    const emit = vi.spyOn(metrics, 'increment');
    const crypto = loadInviteCodeCrypto(config, metrics);
    for (const invalid of [
      { ...config, lookupKey: '' },
      { ...config, bucketKey: config.lookupKey },
      { ...config, replayKey: config.lookupKey },
      { ...config, activeEncryptionVersion: 'missing' },
      { ...config, encryptionKeys: { v1: config.lookupKey } },
      { ...config, encryptionKeys: { v1: 'not-a-key' } },
    ])
      expect(() => loadInviteCodeCrypto(invalid, metrics)).toThrow('KEYS_NOT_READY');
    for (const secret of [
      config.lookupKey,
      config.replayKey,
      config.bucketKey,
      config.encryptionKeys.v1!,
    ]) {
      expect(inspect(crypto, { showHidden: true })).not.toContain(secret);
      expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
    }
    expect(emit).toHaveBeenCalledWith('room_invite_foundation_readiness_total', {
      operation: 'keys',
      result: 'unavailable',
    });
  });
});
