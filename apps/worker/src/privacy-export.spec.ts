import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { R2StorageAdapter } from '@gogo/providers';
import { privacyExportFromEnv } from './privacy-export';

const bucket = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'k',
  R2_SECRET_ACCESS_KEY: 's',
  R2_BUCKET: 'gogo-dev-assets',
};
const key = { EXPORT_WRAPPING_KEY_V1: randomBytes(32).toString('base64') };

/**
 * PR #677 S-F-11 — the bucket and the wrapping keys are two decisions. A
 * worker that has the bucket but no key must still sweep (expiry, deletion,
 * dead-letter alerts, redrive); only generation waits for a key.
 */
describe('privacy export wiring (GoGo-BE#256, PR #677 S-F-11)', () => {
  it('binds the bucket without a wrapping key, so the sweep can register alone', () => {
    const wiring = privacyExportFromEnv(bucket);
    expect(wiring.storage).toBeInstanceOf(R2StorageAdapter);
    expect(wiring.keyring).toBeNull();
    expect(wiring.missing).toEqual({ storage: [], keyring: ['EXPORT_WRAPPING_KEY_V1'] });
  });

  it('names every missing bucket value and binds no fake', () => {
    const wiring = privacyExportFromEnv({ ...key, R2_ACCOUNT_ID: 'acct' });
    expect(wiring.storage).toBeNull();
    expect(wiring.keyring?.activeVersion).toBe(1);
    expect(wiring.missing).toEqual({
      storage: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'],
      keyring: [],
    });
  });

  it('binds both when both are present', () => {
    const wiring = privacyExportFromEnv({ ...bucket, ...key });
    expect(wiring.storage).toBeInstanceOf(R2StorageAdapter);
    expect(wiring.keyring?.activeVersion).toBe(1);
    expect(wiring.missing).toEqual({ storage: [], keyring: [] });
  });

  it('refuses to boot on a malformed key rather than sweeping around it', () => {
    expect(() => privacyExportFromEnv({ ...bucket, EXPORT_WRAPPING_KEY_V1: 'short' })).toThrow();
  });
});
