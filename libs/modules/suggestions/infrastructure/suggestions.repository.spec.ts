import { describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@gogo/database';
import type { HostAuthority } from '../../rooms/domain/host-authority';
import type { DomainEventInput } from '../../shared/outbox';
import { preferenceRevision } from '../domain/preference-revision';
import type { RoomSnapshot } from '../domain/types';
import { SuggestionsRepository } from './suggestions.repository';

const authority: HostAuthority = {
  kind: 'host',
  actor: { type: 'user', id: 'host', sessionId: 'session' },
  memberId: 'host-member',
  hostVersion: 1,
};
const event: DomainEventInput = {
  eventType: 'suggestions.generated',
  resourceType: 'room',
  resourceId: 'room',
  payload: {},
};

function harness(
  options: { constraintVersion?: number; status?: string; hostUserId?: string } = {},
) {
  const room = {
    id: 'room',
    status: 'collecting',
    constraintVersion: 1,
    hostUserId: 'host',
    hostVersion: 1,
    ...options,
  };
  const member = {
    id: 'host-member',
    memberId: 'host-member',
    userId: 'host',
    guestSessionId: null,
    role: 'host',
    removedAt: null,
    selectionStatus: 'completed',
    version: 1,
    isDraft: false,
  };
  const snapshot: RoomSnapshot = {
    roomId: 'room',
    constraintVersion: 1,
    preferenceRevision: preferenceRevision([member]),
    type: 'group',
    decisionMode: 'vote',
    participantCount: 3,
    budget: { mode: 'per_person', amount: 300000, currency: 'VND' },
    timeWindow: { startAt: null, endAt: null },
    origin: null,
    radiusM: null,
    dietaryKeys: [],
    accessibilityKeys: [],
    memberPreferences: [],
    seedPlaceIds: [],
  };
  const lock = vi.fn().mockResolvedValue([room]);
  const update = vi.fn().mockReturnValue({
    set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
  });
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          leftJoin: () => query,
          where: () =>
            Object.assign(Promise.resolve(table === schema.rooms ? [room] : [member]), {
              for: lock,
            }),
        };
        return query;
      },
    }),
    update,
    insert,
  };
  const db = { transaction: async (fn: (handle: typeof tx) => unknown) => fn(tx) };
  return {
    repo: new SuggestionsRepository(db as unknown as Db),
    snapshot,
    room,
    member,
    update,
    insert,
    lock,
  };
}

describe('persistScores stale fence and host authority (#902/#879)', () => {
  it.each(['inputs then transfer', 'transfer then inputs'] as const)(
    'rejects the old host with HOST_ONLY when %s commit before the room lock',
    async (order) => {
      const h = harness();
      const changeInputs = () => {
        h.room.constraintVersion = 2;
      };
      const transfer = () => {
        h.room.hostUserId = 'new-host';
        h.room.hostVersion = 2;
        h.member.role = 'member';
      };
      const changes =
        order === 'inputs then transfer' ? [changeInputs, transfer] : [transfer, changeInputs];
      h.lock.mockImplementation(async () => {
        for (const change of changes) change();
        return [h.room];
      });
      await expect(
        h.repo.persistScores('run', 'room', [], event, h.snapshot, authority),
      ).rejects.toMatchObject({ code: 'HOST_ONLY' });
      expect(h.lock).toHaveBeenCalledWith('update');
      expect(h.update).not.toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
    },
  );

  it.each(['constraints', 'preferences', 'terminal state'] as const)(
    'fences changed %s for the valid current host without writes',
    async (change) => {
      const h = harness();
      if (change === 'constraints') h.room.constraintVersion = 2;
      if (change === 'preferences') h.snapshot.preferenceRevision = 'old-preferences';
      if (change === 'terminal state') h.room.status = 'ready';
      await expect(
        h.repo.persistScores('run', 'room', [], event, h.snapshot, authority),
      ).rejects.toMatchObject({ code: 'STALE_SUGGESTIONS' });
      expect(h.lock).toHaveBeenCalledWith('update');
      expect(h.update).not.toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
    },
  );

  describe.each(['fresh', 'stale'] as const)('%s inputs', (inputs) => {
    it.each([
      ['missing authority', undefined],
      ['non-host member', { ...authority, memberId: 'other-member' }],
      ['old host version', { ...authority, hostVersion: 0 }],
      ['demoted host', authority],
      ['changed host pointer', authority],
    ] as const)('rejects %s with HOST_ONLY without writes', async (condition, actor) => {
      const h = harness({ constraintVersion: inputs === 'stale' ? 2 : 1 });
      if (condition === 'demoted host') h.member.role = 'member';
      if (condition === 'changed host pointer') h.room.hostUserId = 'new-host';
      await expect(
        h.repo.persistScores('run', 'room', [], event, h.snapshot, actor),
      ).rejects.toMatchObject({ code: 'HOST_ONLY' });
      if (actor) expect(h.lock).toHaveBeenCalledWith('update');
      expect(h.update).not.toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
    });
  });

  it('requires a snapshot even with valid host authority', async () => {
    const h = harness();
    await expect(
      h.repo.persistScores('run', 'room', [], event, undefined, authority),
    ).rejects.toMatchObject({ code: 'HOST_ONLY' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('writes scores and the outbox event for the current host and current inputs', async () => {
    const h = harness();
    await h.repo.persistScores(
      'run',
      'room',
      [{ placeId: 'place', rank: 1, scoreMicros: 1, components: {}, reasonCodes: [] }],
      event,
      h.snapshot,
      authority,
    );
    expect(h.lock).toHaveBeenCalledWith('update');
    expect(h.update).toHaveBeenCalledWith(schema.candidateScores);
    expect(h.insert).toHaveBeenCalledWith(schema.candidateScores);
    expect(h.insert).toHaveBeenCalledWith(schema.outboxEvents);
  });
});
