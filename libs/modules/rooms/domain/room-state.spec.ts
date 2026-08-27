import { describe, expect, it } from 'vitest';
import { assertConstraintsEditable, assertDecisionMode, assertTransition } from './room-state';

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
    expect(() => assertTransition('active', 'collecting')).toThrow();
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
