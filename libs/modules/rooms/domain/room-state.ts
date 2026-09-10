import { AppError } from '../../shared/app-error';

export type RoomStatus =
  'draft' | 'collecting' | 'matching' | 'ready' | 'active' | 'completed' | 'cancelled' | 'expired';

export type RoomType = 'couple' | 'group';
export type DecisionMode = 'match' | 'vote' | 'host';

/** SRS §7.2 room state machine. Every transition is validated here — nowhere else. */
const TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  draft: ['collecting', 'cancelled'],
  collecting: ['matching', 'collecting', 'expired', 'cancelled'],
  // Self-loop like `collecting`: a client expressing "start matching"
  // twice — a retry after a timeout — must not be an error.
  matching: ['ready', 'collecting', 'matching', 'cancelled'],
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

/**
 * GoGo-BE#559 — a couple's budget is a total for two.
 *
 * The couple flow asks "Ngân sách cho cả hai?" and the spec renders couple
 * prices as "cho 2 người" (GOGO_FEATURE_IMPROVEMENT_SPEC §23.3, §94); only the
 * group setup screen offers a unit. A couple room stored as `per_person` reads
 * back through `budgetPerPerson` as the amount itself, so the effective ceiling
 * is double what the person chose — MobileApp#189 shipped exactly that for
 * months, and a rule the client alone enforces is a rule the next client
 * forgets (RULE-CORE-005).
 *
 * Applied on write only. Rooms already stored as `per_person` keep their value
 * and keep working; nothing is converted behind anyone's back.
 */
export function assertBudgetMode(type: RoomType, mode: 'total' | 'per_person'): void {
  if (type === 'couple' && mode !== 'total') {
    throw AppError.badRequest('INVALID_BUDGET_MODE', 'A couple budget is a total for two people', [
      {
        field: 'constraint.budgetMode',
        code: 'invalid',
        message: "must be 'total' for a couple room",
      },
    ]);
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
