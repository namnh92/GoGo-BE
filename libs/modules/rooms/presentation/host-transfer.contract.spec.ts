import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { transferRoomHostSchema } from './dtos';
import { ROOM_EVENT_TYPES } from '../../realtime/domain/room-event';
import {
  effectivePush,
  DEFAULT_CATEGORIES,
  registration,
} from '../../notifications/domain/notification-registry';

const spec = parse(
  readFileSync(path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'),
);
const valid = { memberId: '8ff67cc7-8470-4a01-83ed-6bd448a4b50b', expectedHostVersion: 1 };
describe('host transfer contract (#879)', () => {
  it('requires a strict member ID and a positive integer host term', () => {
    expect(transferRoomHostSchema.parse(valid)).toEqual(valid);
    expect(
      transferRoomHostSchema.parse({ ...valid, memberId: valid.memberId.toUpperCase() }),
    ).toEqual(valid);
    for (const bad of [
      {},
      { ...valid, userId: valid.memberId },
      { ...valid, role: 'host' },
      { ...valid, expectedHostVersion: 0 },
      { ...valid, expectedHostVersion: 1.5 },
      { ...valid, memberId: 'not-a-uuid' },
    ])
      expect(transferRoomHostSchema.safeParse(bad).success).toBe(false);
  });
  it('publishes required key, receipt, snapshot fields and all error statuses', () => {
    const op = spec.paths['/rooms/{id}/host-transfer'].post;
    expect(op.operationId).toBe('transferRoomHost');
    expect(op.parameters.find((p: { name: string }) => p.name === 'Idempotency-Key').required).toBe(
      true,
    );
    expect(Object.keys(op.responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '410',
      '422',
      '429',
      '503',
    ]);
    const result = spec.components.schemas.TransferRoomHostResult;
    expect(Object.keys(result.properties).sort()).toEqual([
      'hostMemberId',
      'hostVersion',
      'previousHostMemberId',
      'roomId',
      'transferId',
      'transferredAt',
    ]);
    expect(result.required).toHaveLength(6);
    expect(spec.components.schemas.RoomSummary.required).toEqual(
      expect.arrayContaining(['hostMemberId', 'hostVersion']),
    );
    expect(spec.info.version).toBe('12.2.0-alpha.1');
    expect(spec.components.schemas.RoomEvent.properties.event_type.enum).toEqual(
      expect.arrayContaining([...ROOM_EVENT_TYPES]),
    );
    expect(ROOM_EVENT_TYPES).toContain('room.host_transferred');
  });
  it('uses the event recipient, category other and normal opt-out', () => {
    expect(registration('host_transferred')).toEqual({
      category: 'other',
      channels: ['in_app', 'push'],
      producer: 'room.host_transferred',
      audience: 'transferred_member',
    });
    expect(effectivePush('host_transferred', false, DEFAULT_CATEGORIES)).toBe(false);
    expect(effectivePush('host_transferred', true, DEFAULT_CATEGORIES)).toBe(true);
    expect(Object.keys(DEFAULT_CATEGORIES)).toHaveLength(5);
  });
});
