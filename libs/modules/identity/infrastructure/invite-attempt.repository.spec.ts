import { expect, it } from 'vitest';
import { InviteAttemptRepository, inviteTimestamp } from './invite-attempt.repository';
it('decodes raw pg timestamps, including exact expiry and malformed dependency data', () => {
  const value = inviteTimestamp('2026-11-12 00:00:00+00');
  expect(value.toISOString()).toBe('2026-11-12T00:00:00.000Z');
  expect(inviteTimestamp(value)).toBe(value);
  expect(() => inviteTimestamp(undefined)).toThrow('Invalid invite security timestamp');
});

it('decodes every raw context timestamp from the authoritative proof query', async () => {
  const repo = new InviteAttemptRepository({
    execute: async () => ({
      rows: [
        {
          id: 'context-id',
          proof_hash: 'hash',
          purpose: 'invite_attempts',
          transport: 'MOBILE_HEADER',
          created_at: '2026-11-12 00:00:00+00',
          expires_at: '2026-11-14 00:00:00+00',
          revoked_at: null,
          now: '2026-11-14 00:00:00+00',
        },
      ],
    }),
  } as never);
  const result = await repo.findProof('hash');
  expect(result.context?.expiresAt).toBeInstanceOf(Date);
  expect(result.context?.createdAt).toBeInstanceOf(Date);
  expect(result.context?.expiresAt.getTime()).toBe(result.now.getTime());
  expect(result.context?.revokedAt).toBeNull();
});
