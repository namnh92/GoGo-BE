import { describe, expect, it } from 'vitest';
import { idempotencyKeyFrom } from './idempotency-key';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('idempotencyKeyFrom', () => {
  it('passes a UUID through unchanged (lower-cased)', () => {
    const id = '0F2C7A10-4E2B-4A7C-9B1D-3E5F6A7B8C9D';
    expect(idempotencyKeyFrom(id)).toBe(id.toLowerCase());
  });

  it('derives a stable RFC 9562 version-8 UUID from any other string', () => {
    const a = idempotencyKeyFrom('campaign:abc:user-1');
    expect(a).toMatch(UUID);
    expect(idempotencyKeyFrom('campaign:abc:user-1')).toBe(a);
    expect(idempotencyKeyFrom('campaign:abc:user-2')).not.toBe(a);
  });
});
