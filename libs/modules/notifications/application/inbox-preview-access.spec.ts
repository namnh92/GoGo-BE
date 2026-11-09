import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { inboxPreviewPayload } from './inbox-preview-access';

const payload = {
  roomId: 'room',
  _inviterMemberId: 'private-member',
  inviterName: 'Mai',
  inviterAvatar: { sourceType: 'gogo', mediaKey: `avatars/${'a'.repeat(32)}.webp` },
  reminder: { trigger: 'room_started' },
  planPreview: {
    planId: 'plan',
    stops: [
      {
        placeId: 'place',
        position: 0,
        name: { value: 'Venue' },
        addressText: { value: 'Address' },
        mediaId: 'media',
      },
    ],
  },
};

describe('live inbox preview access', () => {
  it('preserves historical payloads without querying or filling new fields', async () => {
    const execute = vi.fn();
    expect(
      await inboxPreviewPayload({ execute } as unknown as Db, 'user', { route: 'legacy' }),
    ).toEqual({ route: 'legacy' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('removes all sensitive facts after room access is revoked', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ allowed: false }] });
    expect(await inboxPreviewPayload({ execute } as unknown as Db, 'user', payload)).toEqual({
      roomId: 'room',
    });
  });
  it('never returns private member evidence; suppresses removed media and unpublished text without mutating the snapshot', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          allowed: true,
          inviter_allowed: true,
          plan_available: true,
          places: [],
          media: [],
          avatars: [],
        },
      ],
    });
    const result = await inboxPreviewPayload({ execute } as unknown as Db, 'user', payload);
    expect(result).toEqual({
      roomId: 'room',
      inviterName: 'Mai',
      reminder: payload.reminder,
      planPreview: { planId: 'plan', stops: [{ placeId: 'place', position: 0 }] },
    });
    expect(payload.planPreview.stops[0]).toHaveProperty('mediaId');
  });
  it('suppresses removed inviter and plan while preserving other authorized facts', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          allowed: true,
          inviter_allowed: false,
          plan_available: false,
          places: [],
          media: [],
          avatars: [],
        },
      ],
    });
    expect(await inboxPreviewPayload({ execute } as unknown as Db, 'user', payload)).toEqual({
      roomId: 'room',
      reminder: payload.reminder,
    });
  });
});
