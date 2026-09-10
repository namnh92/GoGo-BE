import { describe, expect, it } from 'vitest';

import { resolveR2AccountId } from './r2-account';

/**
 * GoGo-BE#548 — an empty account id used to produce the host
 * `.r2.cloudflarestorage.com`, signed and handed to a client as if it worked.
 */
describe('resolveR2AccountId', () => {
  it('prefers the explicit account id', () => {
    expect(
      resolveR2AccountId({
        accountId: 'abc123',
        endpoint: 'https://def456.r2.cloudflarestorage.com',
      }),
    ).toBe('abc123');
  });

  it('reads the account id out of the endpoint when none is set', () => {
    expect(resolveR2AccountId({ endpoint: 'https://def456.r2.cloudflarestorage.com' })).toBe(
      'def456',
    );
  });

  it('ignores a trailing path, query or fragment on the endpoint', () => {
    expect(
      resolveR2AccountId({ endpoint: 'https://def456.r2.cloudflarestorage.com/bucket?x=1' }),
    ).toBe('def456');
  });

  it('returns nothing for an endpoint that is not R2, rather than guessing a label', () => {
    expect(resolveR2AccountId({ endpoint: 'https://storage.example.com' })).toBe('');
    expect(resolveR2AccountId({ endpoint: 'def456' })).toBe('');
  });

  it('returns nothing when neither is set, so the caller can refuse', () => {
    expect(resolveR2AccountId({})).toBe('');
    expect(resolveR2AccountId({ accountId: '   ', endpoint: '' })).toBe('');
  });
});
