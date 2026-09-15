import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import { RoomsService } from './rooms.service';

/**
 * #600 — the service half of an idempotent start. The repository decides under
 * the row lock whether the room moved (rooms.int.spec.ts proves the one-event
 * rule against Postgres); this covers what the service does with that answer.
 */

const host: Actor = { type: 'user', id: 'user-host', sessionId: 'session-host' };
const roomId = '00000000-0000-4000-8000-000000000600';

function build(options: { status: string; moved: boolean; forbidden?: boolean }) {
  const repo = { updateStatus: vi.fn().mockResolvedValue(options.moved) };
  const policy = {
    requireHost: options.forbidden
      ? vi.fn().mockRejectedValue(AppError.forbidden('HOST_ONLY', 'Host only'))
      : vi.fn().mockResolvedValue({ room: { id: roomId, status: options.status } }),
  };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const service = new RoomsService(
    repo as never,
    policy as never,
    {} as never,
    {} as never,
    {} as never,
    events as never,
  );
  const summary = { id: roomId, status: 'active' };
  vi.spyOn(service, 'getRoomSummary').mockResolvedValue(summary as never);
  return { service, repo, events, summary };
}

describe('RoomsService.transition (#600)', () => {
  it('announces a start that moved the room', async () => {
    const { service, repo, events, summary } = build({ status: 'ready', moved: true });

    await expect(service.transition(host, roomId, 'active')).resolves.toBe(summary);

    expect(repo.updateStatus).toHaveBeenCalledWith(
      roomId,
      'active',
      expect.objectContaining({ eventType: 'room.status_active' }),
      false,
    );
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith({
      roomId,
      type: 'room.status_changed',
      payload: { from: 'ready', to: 'active' },
    });
  });

  it('answers a repeated start with the summary and publishes nothing', async () => {
    const { service, events, summary } = build({ status: 'active', moved: false });

    await expect(service.transition(host, roomId, 'active')).resolves.toBe(summary);

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('stays silent when a racing start won the lock after the policy read saw ready', async () => {
    const { service, events, summary } = build({ status: 'ready', moved: false });

    await expect(service.transition(host, roomId, 'active')).resolves.toBe(summary);

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('refuses a non-host before touching the room', async () => {
    const { service, repo, events } = build({ status: 'active', moved: false, forbidden: true });

    await expect(service.transition(host, roomId, 'active')).rejects.toMatchObject({
      code: 'HOST_ONLY',
    });

    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('still refuses restarting a finished date', async () => {
    const { service, repo } = build({ status: 'completed', moved: false });

    await expect(service.transition(host, roomId, 'active')).rejects.toMatchObject({
      code: 'INVALID_ROOM_TRANSITION',
    });

    expect(repo.updateStatus).not.toHaveBeenCalled();
  });
});
