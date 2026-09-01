/**
 * PR3 / COST-BE-003 (#336) — reading the accounting tables before and after.
 *
 * `provider_usage_daily` is the baseline's source of truth for call counts,
 * per the plan's §4 note ("ledger is the accounting source, Grafana the
 * cross-check"). This module does nothing but snapshot it, snapshot it again,
 * and subtract.
 *
 * The subtraction is what makes the number a *scenario's* cost rather than the
 * day's. The ledger is keyed by UTC day and accumulates every call the
 * environment makes; a baseline that read the row directly would be reporting
 * whatever else happened to be running, which is the contamination §4's quiet
 * window exists to bound and this diff exists to survive.
 *
 * One subtlety the flush interval forces: the ledger buffers in memory for
 * `COST_LEDGER_FLUSH_MS` before it upserts. Snapshotting `after` too early
 * reads a row the scenario's last calls have not reached yet, and the baseline
 * silently under-counts. Every caller therefore flushes before snapshotting —
 * `awaitFlush` below is the seam, and the runner refuses to proceed without
 * one.
 */

/**
 * The one thing this module needs from a database: run parameterised SQL, get
 * rows back.
 *
 * A port rather than `Db` because `scripts/` sits above the workspace packages
 * and cannot resolve `drizzle-orm` — and because a two-line seam makes the
 * snapshot arithmetic testable without a container. The caller supplies a
 * `pg` pool's `query`; nothing here knows what an ORM is.
 */
export type SqlRunner = (
  text: string,
  params: readonly unknown[],
) => Promise<Record<string, unknown>[]>;

export type UsageCounts = {
  operation: string;
  callsAttempted: number;
  callsSucceeded: number;
  billableUnits: number;
};

export type BudgetCounts = {
  scope: string;
  operation: string;
  reservedCalls: number;
  reservedUnits: number;
  reservedCostMicros: number;
};

export type LedgerSnapshot = {
  day: string;
  environment: string;
  usage: UsageCounts[];
  budget: BudgetCounts[];
  /** Newest `updated_at` across both tables — the freshness ADR-0012 asks for. */
  updatedAt: string | null;
};

export async function snapshotLedger(
  query: SqlRunner,
  environment: string,
  day: string,
): Promise<LedgerSnapshot> {
  const usageRows = await query(
    `select operation, calls_attempted, calls_succeeded, billable_units, updated_at
       from provider_usage_daily
      where environment = $1 and day = $2
      order by operation`,
    [environment, day],
  );
  // `provider_budget_daily` has no environment column: a reservation is scoped
  // by who is spending (`google.places.refresh`), and one database holds one
  // environment's budget. Filtering it by environment would silently return
  // nothing.
  const budgetRows = await query(
    `select scope, operation, reserved_calls, reserved_units, reserved_cost_micros, updated_at
       from provider_budget_daily
      where day = $1
      order by scope, operation`,
    [day],
  );

  let updatedAt: string | null = null;
  const note = (value: unknown) => {
    const at = new Date(value as string).toISOString();
    if (updatedAt === null || at > updatedAt) updatedAt = at;
  };

  const usage = usageRows.map((r) => {
    note(r.updated_at);
    return {
      operation: String(r.operation),
      callsAttempted: Number(r.calls_attempted),
      callsSucceeded: Number(r.calls_succeeded),
      billableUnits: Number(r.billable_units),
    };
  });

  const budget = budgetRows.map((r) => {
    note(r.updated_at);
    return {
      scope: String(r.scope),
      operation: String(r.operation),
      reservedCalls: Number(r.reserved_calls),
      reservedUnits: Number(r.reserved_units),
      reservedCostMicros: Number(r.reserved_cost_micros),
    };
  });

  return { day, environment, usage, budget, updatedAt };
}

/**
 * `after − before`, dropping rows that did not move.
 *
 * A negative delta is impossible against a monotonic ledger, so it is kept
 * rather than clamped: if one ever appears, the run straddled a UTC midnight
 * or someone truncated the table, and a clamp would turn a corrupt baseline
 * into a plausible one.
 */
export function diffLedger(
  before: LedgerSnapshot,
  after: LedgerSnapshot,
): {
  usage: UsageCounts[];
  budget: BudgetCounts[];
} {
  const priorUsage = new Map(before.usage.map((u) => [u.operation, u]));
  const usage = after.usage
    .map((u) => {
      const prior = priorUsage.get(u.operation);
      return {
        operation: u.operation,
        callsAttempted: u.callsAttempted - (prior?.callsAttempted ?? 0),
        callsSucceeded: u.callsSucceeded - (prior?.callsSucceeded ?? 0),
        billableUnits: u.billableUnits - (prior?.billableUnits ?? 0),
      };
    })
    .filter((u) => u.callsAttempted !== 0 || u.callsSucceeded !== 0 || u.billableUnits !== 0);

  const key = (b: { scope: string; operation: string }) => `${b.scope}|${b.operation}`;
  const priorBudget = new Map(before.budget.map((b) => [key(b), b]));
  const budget = after.budget
    .map((b) => {
      const prior = priorBudget.get(key(b));
      return {
        scope: b.scope,
        operation: b.operation,
        reservedCalls: b.reservedCalls - (prior?.reservedCalls ?? 0),
        reservedUnits: b.reservedUnits - (prior?.reservedUnits ?? 0),
        reservedCostMicros: b.reservedCostMicros - (prior?.reservedCostMicros ?? 0),
      };
    })
    .filter((b) => b.reservedCalls !== 0 || b.reservedUnits !== 0 || b.reservedCostMicros !== 0);

  return { usage, budget };
}
