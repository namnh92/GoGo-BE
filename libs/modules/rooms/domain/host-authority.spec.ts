import { describe, expect, it } from 'vitest';
import type { schema } from '@gogo/database';
import { requireHostWithin, type HostAuthority } from './host-authority';

const room = { id: 'room', hostUserId: 'a', hostVersion: 3 } as typeof schema.rooms.$inferSelect;
const authority: HostAuthority = {
  kind: 'host',
  actor: { type: 'user', id: 'a', sessionId: 's' },
  memberId: 'ma',
  hostVersion: 3,
};
const member = { id: 'ma', userId: 'a', guestSessionId: null, role: 'host' };
const tx = (row: unknown) =>
  ({ select: () => ({ from: () => ({ where: async () => (row ? [row] : []) }) }) }) as never;

describe('ownership at the locked write boundary (#879)', () => {
  it('permits the same active user, membership, role, pointer and term', async () => {
    await expect(requireHostWithin(tx(member), room, authority)).resolves.toEqual(member);
  });
  it.each([
    { ...member, role: 'member' },
    { ...member, userId: 'b' },
    { ...member, guestSessionId: 'guest' },
    { ...member, id: 'other' },
  ])('refuses a stale or inconsistent host membership: %j', async (row) => {
    await expect(requireHostWithin(tx(row), room, authority)).rejects.toMatchObject({
      code: 'HOST_ONLY',
      httpStatus: 403,
    });
  });
  it('refuses a caller removed during computation', async () => {
    await expect(requireHostWithin(tx(null), room, authority)).rejects.toMatchObject({
      code: 'NOT_A_MEMBER',
    });
  });
  it('rejects an old term even when A is host again (A→B→A)', async () => {
    await expect(
      requireHostWithin(tx(member), { ...room, hostVersion: 5 }, authority),
    ).rejects.toMatchObject({ code: 'HOST_VERSION_CONFLICT' });
  });
  it('checks guest scope before inspecting membership', async () => {
    await expect(
      requireHostWithin(tx(member), room, {
        ...authority,
        actor: { type: 'guest', id: 'g', roomId: 'elsewhere', sessionId: 'g' },
      }),
    ).rejects.toMatchObject({ code: 'ROOM_SCOPE_VIOLATION' });
  });
});
