import { describe, expect, it } from 'vitest';
import { seedScopes, type SeedReplayInput } from './seed-idempotency';
const input: SeedReplayInput = {
  key: 'seed-key-1234',
  actor: { type: 'user', id: 'user', sessionId: 'session' },
  operation: 'remove',
  roomId: 'room',
  placeIds: ['place'],
};
describe('#878 concrete replay identity', () => {
  it('binds room, deleted place, actor and method; normalized body hashes differ on another resource', () => {
    const first = seedScopes(input);
    for (const changed of [
      { roomId: 'other' },
      { placeIds: ['other'] },
      { operation: 'add' as const },
      { actor: { ...input.actor, id: 'other' } },
    ]) {
      const next = seedScopes({ ...input, ...changed });
      expect(next.concrete.storedKey).not.toBe(first.concrete.storedKey);
    }
    expect(seedScopes({ ...input, roomId: 'other' }).legacy.storedKey).toBe(first.legacy.storedKey);
    expect(seedScopes({ ...input, roomId: 'other' }).concrete.requestHash).not.toBe(
      first.concrete.requestHash,
    );
    expect(seedScopes({ ...input, actor: { ...input.actor, sessionId: 'new-session' } })).toEqual(
      first,
    );
  });
  it.each(['short', 'has spaces in key', 'x'.repeat(129)])('rejects malformed key', (key) => {
    expect(() => seedScopes({ ...input, key })).toThrowError(
      expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' }),
    );
  });
});
