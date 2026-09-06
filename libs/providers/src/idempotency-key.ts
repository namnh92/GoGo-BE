import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * NTF-BE-002 (#193) — a provider-side dedupe key derived from *what caused the
 * send*, never from the attempt.
 *
 * OneSignal accepts any RFC 9562 UUID as `idempotency_key` and treats a repeat
 * within 30 days as a replay of the first send. The outbox event id is already
 * a UUID and passes through untouched; every other source (a campaign's
 * `campaign:{dispatchKey}:{userId}` dedupe key, a chunk index) is hashed into a
 * version-8 UUID — the RFC's designation for a value whose bits are defined by
 * the application, which a hash-derived id is. Deterministic on purpose: the
 * same cause on a retry must present the same key, or the key guards nothing.
 */
export function idempotencyKeyFrom(source: string): string {
  if (UUID.test(source)) return source.toLowerCase();
  const digest = createHash('sha256').update(source).digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80; // version 8
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
