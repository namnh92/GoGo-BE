import { describe, expect, it } from 'vitest';
import { toProviderStatus } from './provider-status';

describe('toProviderStatus (#360)', () => {
  it('turns the json_build_object text timestamp into ISO-8601', () => {
    expect(toProviderStatus({ status: 'closed', fetchedAt: '2026-09-01T07:00:00+07:00' })).toEqual({
      status: 'closed',
      fetchedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('is absent when there is no provider row', () => {
    expect(toProviderStatus(null)).toBeUndefined();
    expect(toProviderStatus(undefined)).toBeUndefined();
  });

  it('is absent rather than half-filled when a field is unusable', () => {
    expect(toProviderStatus({ status: 1, fetchedAt: '2026-09-01T00:00:00Z' })).toBeUndefined();
    expect(toProviderStatus({ status: 'active', fetchedAt: null })).toBeUndefined();
    expect(toProviderStatus({ status: 'active', fetchedAt: 'not a date' })).toBeUndefined();
  });
});
