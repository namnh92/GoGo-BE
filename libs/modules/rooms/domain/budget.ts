/**
 * Budget math (core rule #4): money is integer minor units; `total` and
 * `per_person` modes convert consistently everywhere through these two
 * functions — no ad-hoc arithmetic in services or DTOs.
 */

export type BudgetMode = 'total' | 'per_person';

export type Budget = {
  mode: BudgetMode;
  amount: number; // integer minor units
  currency: string;
};

function assertValid(budget: Budget, participantCount: number): void {
  if (!Number.isSafeInteger(budget.amount) || budget.amount < 0) {
    throw new Error(`invalid budget amount: ${budget.amount}`);
  }
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    throw new Error(`invalid participant count: ${participantCount}`);
  }
}

/** Total budget for the whole room. per_person → multiply. */
export function budgetTotal(budget: Budget, participantCount: number): number {
  assertValid(budget, participantCount);
  return budget.mode === 'total' ? budget.amount : budget.amount * participantCount;
}

/**
 * Per-person budget. total → floor division: the room can rely on every
 * member spending at most this amount without exceeding the total.
 */
export function budgetPerPerson(budget: Budget, participantCount: number): number {
  assertValid(budget, participantCount);
  return budget.mode === 'per_person'
    ? budget.amount
    : Math.floor(budget.amount / participantCount);
}

/** FR-SUG-006: over budget iff the UPPER bound exceeds the total budget. */
export function isOverBudget(
  costUpperBound: number,
  budget: Budget,
  participantCount: number,
): boolean {
  return costUpperBound > budgetTotal(budget, participantCount);
}
