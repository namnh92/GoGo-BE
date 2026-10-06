import { describe, expect, it } from 'vitest';
import { FakeStorage } from '@gogo/providers';
import { privacyExportStorageFor } from './export-storage';

const none = { R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '' };
const creds = { R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' };

/**
 * PR #677 S-F-13 — privacy cleanup never runs against a fake outside tests:
 * a fake delete "succeeds", the artifact is recorded as cleaned, and the real
 * object outlives every reference to it.
 */
describe('privacyExportStorageFor (GoGo-BE#256, PR #677 S-F-13)', () => {
  it('is null — not the general fake — when the private bucket is not configured', () => {
    const general = new FakeStorage();
    expect(privacyExportStorageFor({ NODE_ENV: 'production', ...none }, general)).toBeNull();
    expect(privacyExportStorageFor({ NODE_ENV: 'development', ...none }, general)).toBeNull();
  });

  it('is the shared fake under test only', () => {
    const general = new FakeStorage();
    expect(privacyExportStorageFor({ NODE_ENV: 'test', ...none }, general)).toBe(general);
  });

  it('is the real adapter whenever the bucket is configured', () => {
    const general = new FakeStorage(); // stands in for the R2 adapter the general token holds
    expect(privacyExportStorageFor({ NODE_ENV: 'production', ...creds }, general)).toBe(general);
  });
});
