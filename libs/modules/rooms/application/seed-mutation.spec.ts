import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoomsService } from './rooms.service';
import { AppError } from '../../shared/app-error';
import { runWithRequestContext } from '../../shared/request-context';
import type { Actor } from '../../identity/domain/actor';
const actor: Actor = { type: 'user', id: 'account-secret', sessionId: 'session-secret' };
function fixture(outcome = 'changed') {
  const body = {
    seedPlaces: [{ placeId: 'place', name: 'Catalog', position: 0, addedByMemberId: 'membership' }],
    constraintVersion: 2,
  };
  const event = {
    roomId: 'room',
    type: 'room.seed_places_changed',
    actorId: 'membership',
    payload: {
      operation: 'add',
      addedPlaceIds: ['place'],
      removedPlaceIds: [],
      constraintVersion: 2,
    },
  };
  const repo = {
    mutateSeedPlaces: vi.fn().mockResolvedValue({
      body,
      outcome,
      role: 'member',
      event: outcome === 'changed' ? event : null,
    }),
  };
  const bus = { publish: vi.fn().mockResolvedValue({}) };
  const metrics = { increment: vi.fn(), observe: vi.fn() };
  const policy = {
    requireHost: vi.fn().mockRejectedValue(AppError.forbidden('HOST_ONLY', 'Only host')),
  };
  const service = new RoomsService(
    repo as never,
    policy as never,
    {} as never,
    {} as never,
    {} as never,
    bus as never,
    undefined,
    metrics as never,
  );
  return { repo, bus, metrics, service, body, event };
}
describe('#878 seed application', () => {
  it('allows account member contribution through transactional policy and publishes only the committed result', async () => {
    const f = fixture();
    f.bus.publish.mockImplementation(async (event) => {
      expect(f.repo.mutateSeedPlaces).toHaveResolvedWith(expect.objectContaining({ body: f.body }));
      expect(event).toEqual(f.event);
    });
    expect(await f.service.addSeedPlaces(actor, 'room', ['place'], 'client-key')).toEqual(f.body);
    expect(f.repo.mutateSeedPlaces).toHaveBeenCalledWith({
      actor,
      roomId: 'room',
      placeIds: ['place'],
      operation: 'add',
      key: 'client-key',
    });
  });
  it.each(['noop', 'replay'])('%s publishes no new event', async (outcome) => {
    const f = fixture(outcome);
    await f.service.removeSeedPlace(actor, 'room', 'place');
    expect(f.bus.publish).not.toHaveBeenCalled();
    expect(f.metrics.increment).toHaveBeenCalledWith(
      'room_seed_mutation_total',
      expect.objectContaining({ outcome }),
    );
  });
  it('Redis failure preserves committed success and records a bounded metric', async () => {
    const f = fixture();
    f.bus.publish.mockRejectedValue(new Error('Redis unavailable'));
    expect(await f.service.addSeedPlaces(actor, 'room', ['place'])).toEqual(f.body);
    expect(f.metrics.increment).toHaveBeenCalledWith('room_seed_sse_publish_failed_total');
    expect(JSON.stringify(f.metrics.increment.mock.calls)).not.toMatch(
      /account-secret|session-secret|client-key|placeId|roomId/,
    );
  });
  it('failed transaction never publishes; finite outcome and latency contain no actor/resource identifiers', async () => {
    const f = fixture();
    f.repo.mutateSeedPlaces.mockRejectedValue(AppError.conflict('ROOM_NOT_EDITABLE', 'Closed'));
    await expect(
      runWithRequestContext({ requestId: 'correlation' }, () =>
        f.service.addSeedPlaces(actor, 'room', ['place'], 'client-key'),
      ),
    ).rejects.toMatchObject({ code: 'ROOM_NOT_EDITABLE' });
    expect(f.bus.publish).not.toHaveBeenCalled();
    expect(f.metrics.increment).toHaveBeenCalledWith('room_seed_mutation_total', {
      operation: 'add',
      actor_kind: 'user',
      role: 'none',
      outcome: 'not_editable',
    });
    expect(f.metrics.observe).toHaveBeenCalledWith(
      'room_seed_mutation_duration_seconds',
      expect.any(Number),
      expect.any(Object),
    );
  });
  it('authorization logging contains only a reason and request correlation', async () => {
    const logged = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const f = fixture();
      f.repo.mutateSeedPlaces.mockRejectedValue(AppError.forbidden('NOT_A_MEMBER', 'Not a member'));
      await expect(
        runWithRequestContext({ requestId: 'correlation', ip: 'private-ip' }, () =>
          f.service.addSeedPlaces(actor, 'private-room', ['private-place'], 'private-key'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
      expect(logged).toHaveBeenCalledWith({
        event: 'room_seed_authorization_failed',
        reason: 'NOT_A_MEMBER',
        requestId: 'correlation',
      });
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(
        /account-secret|session-secret|private-ip|private-room|private-place|private-key/,
      );
    } finally {
      logged.mockRestore();
    }
  });
});
