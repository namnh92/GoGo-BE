import { AppError } from '../../shared/app-error';

export type RoomStatus =
  'draft' | 'collecting' | 'matching' | 'ready' | 'active' | 'completed' | 'cancelled' | 'expired';

export type RoomType = 'couple' | 'group';
export type DecisionMode = 'match' | 'vote' | 'host';

/** SRS §7.2 room state machine. Every transition is validated here — nowhere else. */
const TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  draft: ['collecting', 'cancelled'],
  collecting: ['matching', 'collecting', 'expired', 'cancelled'],
  matching: ['ready', 'collecting', 'cancelled'],
  ready: ['active', 'matching', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  expired: [],
};

export function assertTransition(from: RoomStatus, to: RoomStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw AppError.conflict('INVALID_ROOM_TRANSITION', `Cannot move room from ${from} to ${to}`);
  }
}

/** FR-ROOM-002 — decision mode must match the room type. */
export function assertDecisionMode(type: RoomType, mode: DecisionMode): void {
  const allowed: Record<RoomType, DecisionMode[]> = {
    couple: ['match', 'host'],
    group: ['vote', 'host'],
  };
  if (!allowed[type].includes(mode)) {
    throw AppError.badRequest(
      'INVALID_DECISION_MODE',
      `Decision mode ${mode} is not valid for a ${type} room`,
      [{ field: 'decisionMode', code: 'invalid', message: `allowed: ${allowed[type].join(', ')}` }],
    );
  }
}

/** Constraint edits are allowed until the plan goes active (FR-ROOM-005). */
export function assertConstraintsEditable(status: RoomStatus): void {
  if (!['draft', 'collecting', 'matching', 'ready'].includes(status)) {
    throw AppError.conflict(
      'ROOM_NOT_EDITABLE',
      `Constraints cannot change while room is ${status}`,
    );
  }
}
