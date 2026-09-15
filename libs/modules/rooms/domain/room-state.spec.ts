import { describe, expect, it } from 'vitest';
import {
  assertConstraintsEditable,
  assertDecisionMode,
  assertTransition,
  isNoOpTransition,
  type RoomStatus,
} from './room-state';

describe('room state machine (SRS §7.2)', () => {
  it('allows the documented happy path', () => {
    expect(() => assertTransition('draft', 'collecting')).not.toThrow();
    expect(() => assertTransition('collecting', 'matching')).not.toThrow();
    expect(() => assertTransition('matching', 'ready')).not.toThrow();
    expect(() => assertTransition('ready', 'active')).not.toThrow();
    expect(() => assertTransition('active', 'completed')).not.toThrow();
  });

  it('allows revise-constraints loop matching -> collecting', () => {
    expect(() => assertTransition('matching', 'collecting')).not.toThrow();
  });

  it('rejects skips and backwards moves', () => {
    expect(() => assertTransition('draft', 'active')).toThrow(/INVALID|Cannot/);
    expect(() => assertTransition('completed', 'active')).toThrow();
    expect(() => assertTransition('cancelled', 'active')).toThrow();
    expect(() => assertTransition('expired', 'active')).toThrow();
    expect(() => assertTransition('active', 'collecting')).toThrow();
  });

  it('re-sending the current state is an idempotent success (SRS §7.2, #600)', () => {
    expect(() => assertTransition('collecting', 'collecting')).not.toThrow();
    expect(() => assertTransition('matching', 'matching')).not.toThrow();
    expect(() => assertTransition('active', 'active')).not.toThrow();
  });

  it('only a repeated start is a no-op that records nothing (#600)', () => {
    expect(isNoOpTransition('active', 'active')).toBe(true);
    expect(isNoOpTransition('ready', 'active')).toBe(false);
    expect(isNoOpTransition('collecting', 'collecting')).toBe(false);
    expect(isNoOpTransition('matching', 'matching')).toBe(false);
  });

  it('a no-op is always a transition the machine allows', () => {
    const all: RoomStatus[] = [
      'draft',
      'collecting',
      'matching',
      'ready',
      'active',
      'completed',
      'cancelled',
      'expired',
    ];
    for (const from of all) {
      for (const to of all) {
        if (isNoOpTransition(from, to)) expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('decision mode is constrained by room type (FR-ROOM-002)', () => {
    expect(() => assertDecisionMode('couple', 'match')).not.toThrow();
    expect(() => assertDecisionMode('couple', 'host')).not.toThrow();
    expect(() => assertDecisionMode('couple', 'vote')).toThrow();
    expect(() => assertDecisionMode('group', 'vote')).not.toThrow();
    expect(() => assertDecisionMode('group', 'match')).toThrow();
  });

  it('constraints lock once the room is active (FR-ROOM-005)', () => {
    expect(() => assertConstraintsEditable('collecting')).not.toThrow();
    expect(() => assertConstraintsEditable('ready')).not.toThrow();
    expect(() => assertConstraintsEditable('active')).toThrow();
    expect(() => assertConstraintsEditable('completed')).toThrow();
  });
});
