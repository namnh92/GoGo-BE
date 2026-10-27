import { describe, expect, it } from 'vitest';
import { mergeEditedValues, publicProposalStatus, validateProposalValues } from './proposal';
import type { AssistantProposalValue } from './assistant.types';

const now = new Date('2026-10-27T10:00:00Z');
const later = new Date('2026-10-27T10:30:00Z');
const earlier = new Date('2026-10-27T09:00:00Z');

describe('proposal state machine', () => {
  it('confirming reads as pending; a lapsed pending one reads expired', () => {
    expect(publicProposalStatus('confirming', later, now)).toBe('pending');
    expect(publicProposalStatus('pending', later, now)).toBe('pending');
    expect(publicProposalStatus('pending', earlier, now)).toBe('expired');
    expect(publicProposalStatus('confirming', earlier, now)).toBe('expired');
  });

  it('terminal states stay terminal regardless of expiry', () => {
    expect(publicProposalStatus('confirmed', earlier, now)).toBe('confirmed');
    expect(publicProposalStatus('dismissed', later, now)).toBe('dismissed');
    expect(publicProposalStatus('expired', later, now)).toBe('expired');
  });
});

describe('proposal values', () => {
  const room: AssistantProposalValue[] = [
    { field: 'type', value: 'couple', origin: 'explicit', editable: true },
    { field: 'participantCount', value: 2, origin: 'explicit', editable: true },
    { field: 'budgetMode', value: 'total', origin: 'assumed', editable: true },
    { field: 'budgetAmount', value: 500000, origin: 'explicit', editable: true },
  ];

  it('valid values pass; unknown fields and bad types are refused before any card is shown', () => {
    expect(validateProposalValues('create_room', room)).toEqual([]);
    const bad = validateProposalValues('create_room', [
      ...room,
      { field: 'hostUserId', value: 'x', origin: 'assumed', editable: true },
      { field: 'participantCount', value: 99, origin: 'assumed', editable: true },
    ]);
    expect(bad.map((e) => `${e.field}:${e.code}`)).toEqual([
      'hostUserId:unknown_field',
      'participantCount:duplicate',
      'participantCount:invalid',
    ]);
  });

  it('an edited value becomes explicit; unlisted fields keep the proposal', () => {
    const merged = mergeEditedValues('create_room', room, { budgetMode: 'per_person' });
    expect(merged.errors).toEqual([]);
    expect(merged.values.find((v) => v.field === 'budgetMode')).toEqual({
      field: 'budgetMode',
      value: 'per_person',
      origin: 'explicit',
      editable: true,
    });
    expect(merged.values.find((v) => v.field === 'budgetAmount')?.origin).toBe('explicit');
  });

  it('a field the kind does not define, or a non-editable one, is a 400-shaped error', () => {
    const invite: AssistantProposalValue[] = [
      {
        field: 'roomId',
        value: '7d3f0c2e-5b1a-4c8e-9f21-2a6b1c0d9e11',
        origin: 'explicit',
        editable: false,
      },
    ];
    const merged = mergeEditedValues('create_invite', invite, {
      roomId: '7d3f0c2e-5b1a-4c8e-9f21-2a6b1c0d9e12',
      role: 'host',
      maxUses: 0,
    });
    expect(merged.errors.map((e) => `${e.field}:${e.code}`)).toEqual([
      'roomId:not_editable',
      'role:unknown_field',
      'maxUses:invalid',
    ]);
  });

  it('`__proto__`-style keys are not fields', () => {
    const merged = mergeEditedValues(
      'cast_vote',
      [],
      JSON.parse('{"__proto__": 1, "constructor": 2}') as Record<string, unknown>,
    );
    expect(merged.errors.map((e) => e.code)).toEqual(['unknown_field', 'unknown_field']);
  });
});
