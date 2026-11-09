import { describe, expect, it, vi } from 'vitest';
import {
  buildPlanPreview,
  captureInviterFacts,
  capturePlanPreview,
  captureRoomStartedFacts,
  inviterDisplayFacts,
  roomStartedFacts,
  sourcedNotificationText,
} from './notification-event-facts';
import type { Tx } from './outbox';
import { PgDialect } from 'drizzle-orm/pg-core';

const at = '2026-11-09T09:00:00.000Z';
const evidence = {
  source_type: 'editorial',
  source_reference: 'Merchant interview, in person',
  verified_at: at,
  collected_at: at,
};
const row = {
  plan_id: 'plan-1',
  plan_version: 2,
  constraint_version: 3,
  captured_at: at,
  start_at: '2026-11-09T19:00:00+07:00',
  stop_count: 5,
  stops: Array.from({ length: 5 }, (_, position) => ({
    position,
    place_id: `place-${position}`,
    arrive_at: '2026-11-09T19:15:00+07:00',
    name: 'GoGo venue',
    address_text: 'Independently collected address',
    name_provenance: evidence,
    address_provenance: evidence,
    media_id: null,
    lat: 10,
    rating: 5,
    photo: 'never copy',
  })),
};

describe('event-time notification fact builders (#811 PR3)', () => {
  it('bounds ordered previews and projects only sourced facts, with distinct start/arrival times', () => {
    const preview = buildPlanPreview({ ...row, stops: [...row.stops].reverse() });
    expect(preview).toMatchObject({
      planId: 'plan-1',
      planVersion: 2,
      constraintVersion: 3,
      capturedAt: at,
      startAt: '2026-11-09T12:00:00.000Z',
      startAtSource: 'room_constraints',
      stopCount: 5,
    });
    expect(preview.stops.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(preview.stops[0]).toEqual({
      position: 0,
      placeId: 'place-0',
      arriveAt: '2026-11-09T12:15:00.000Z',
      name: {
        value: 'GoGo venue',
        sourceType: 'gogo',
        originType: 'editorial',
        verifiedAt: at,
        collectedAt: at,
      },
      addressText: {
        value: 'Independently collected address',
        sourceType: 'gogo',
        originType: 'editorial',
        verifiedAt: at,
        collectedAt: at,
      },
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /source_reference|sourceReference|actor|rating|photo|lat/,
    );
    expect(buildPlanPreview({ ...row, start_at: null })).not.toHaveProperty('startAt');
    expect(buildPlanPreview({ ...row, start_at: null })).not.toHaveProperty('startAtSource');
  });
  it.each([
    null,
    { ...evidence, source_type: 'google_derived' },
    { ...evidence, source_type: 'unknown' },
    { ...evidence, source_reference: null },
    { ...evidence, source_reference: 'https://maps.google.com/place/123' },
    { ...evidence, source_reference: 'row 123' },
    { ...evidence, source_type: 'provider', collected_at: null },
    { ...evidence, verified_at: 'invalid' },
  ])('omits unproven text (%j)', (provenance) => {
    expect(sourcedNotificationText('canonical is no proof', provenance, 'name')).toBeUndefined();
    expect(
      sourcedNotificationText('canonical is no proof', provenance, 'address_text'),
    ).toBeUndefined();
  });
  it('uses ADR-0031 for address ownership and requires independent provider evidence', () => {
    expect(
      sourcedNotificationText('Address', { ...evidence, collected_at: null }, 'address_text'),
    ).toBeUndefined();
    expect(
      sourcedNotificationText('Name', { ...evidence, collected_at: null }, 'name'),
    ).toMatchObject({ sourceType: 'gogo' });
    expect(
      sourcedNotificationText(
        'Name',
        {
          ...evidence,
          source_type: 'provider',
          source_reference: 'https://museum.example.org/open-data',
        },
        'name',
      ),
    ).toMatchObject({ originType: 'provider', collectedAt: at });
    expect(sourcedNotificationText('', evidence, 'name')).toBeUndefined();
  });
  it('never implies an advance reminder or invents start from a date or stop', () => {
    expect(roomStartedFacts(at, null)).toEqual({
      trigger: 'room_started',
      triggeredAt: at,
      scheduledFor: null,
      startsAt: null,
    });
    expect(roomStartedFacts(at, row.start_at)).toEqual({
      trigger: 'room_started',
      triggeredAt: at,
      scheduledFor: null,
      startsAt: '2026-11-09T12:00:00.000Z',
    });
  });
  it('accepts only the processed GoGo avatar namespace', () => {
    const mediaKey = `avatars/${'a'.repeat(32)}.webp`;
    expect(inviterDisplayFacts('Mai', mediaKey)).toEqual({
      inviterName: 'Mai',
      inviterAvatar: { sourceType: 'gogo', mediaKey },
    });
    for (const key of [
      null,
      'https://google.com/avatar.jpg',
      'avatars/../../a.webp',
      'unowned.webp',
    ])
      expect(inviterDisplayFacts('Mai', key)).toEqual({ inviterName: 'Mai' });
  });
  it('captures from the supplied transaction, names the new plan, and joins exact current constraints', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [row] });
    expect(await capturePlanPreview({ execute } as unknown as Tx, 'room', 'new-plan')).toEqual(
      buildPlanPreview(row),
    );
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.params).toEqual(['room', 'new-plan']);
    expect(query.sql).toContain('rc.version = r.constraint_version');
    expect(query.sql).toContain('rc.version = p.constraint_version');
    expect(query.sql).toContain('m.provider_photo is null');
    expect(query.sql).toContain('limit 3');
  });
  it('captures absent-plan room starts and absent inviters without inventing facts', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ triggered_at: at, start_at: null }] })
      .mockResolvedValue({ rows: [] });
    const tx = { execute } as unknown as Tx;
    expect(await captureRoomStartedFacts(tx, 'room')).toEqual({
      reminder: roomStartedFacts(at, null),
    });
    expect(await captureInviterFacts(tx, 'room', undefined)).toEqual({});
    expect(await captureInviterFacts(tx, 'room', 'member')).toEqual({});
  });
});
