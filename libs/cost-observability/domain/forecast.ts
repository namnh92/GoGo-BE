import {
  daysInMonth,
  elapsedDays,
  FORECAST_MIN_ELAPSED_DAYS,
  spend,
  usageProjectionMicros,
  winningRows,
  type BillingCadence,
  type CostKind,
  type CostRow,
  type ScopeProjection,
} from './budget';
import { isManualCostSource } from './manual-cost-source';

/**
 * COST-BE-034 (#415) — epic §33 as amended by ADR-0015: a forecast built
 * from billing semantics, not from "the month so far ÷ the days so far".
 *
 * Three numbers, kept apart because they answer three questions:
 *
 * - **Month actual** — what has been recognised up to today: every winning
 *   row of the month, by kind. A one-off that landed is in it; an annual fee
 *   whose renewal is in another month is not.
 * - **End-of-month cash forecast** — what the month's invoices will add up
 *   to: the USAGE projection (the only extrapolated part) + every RECURRING
 *   charge whose billing date falls in the month + every ONE_TIME charge of
 *   the month, landed or still scheduled. An annual fee is here only in its
 *   renewal month.
 * - **Normalised monthly run-rate** — what a typical month costs: the USAGE
 *   projection + every active MONTHLY fee + every active ANNUAL fee ÷ 12.
 *   ONE_TIME charges never enter it.
 *
 * Inputs are the month's cost rows (each classified by `costKind`), and the
 * *schedule* of what is known to be coming — the charge dates of manual items
 * (`manualSchedule`) — because a fee billed on the 15th has no row on the
 * 10th and a forecast that only reads rows would miss it. Everything is pure.
 */

export type ScheduledCharge = {
  /** The row source it will land under (`manual_cost_items:<id>`, `monitoring_cost_model|…`). */
  key: string;
  providerId: string;
  serviceId: string;
  name: string | null;
  kind: Exclude<CostKind, 'USAGE'>;
  cadence: BillingCadence | null;
  /** The cash date; `null` for a model that accrues across the month with no single billing day. */
  day: string | null;
  amountMicros: number;
  currency: string;
};

/** A recurring fee active in the month — a run-rate input, whatever its billing date. */
export type Commitment = {
  key: string;
  providerId: string;
  serviceId: string;
  name: string | null;
  cadence: BillingCadence;
  periodAmountMicros: number;
  currency: string;
};

export type MonthSchedule = {
  /** Charges whose cash date falls inside the month. */
  charges: ScheduledCharge[];
  /** Recurring fees active during the month. */
  commitments: Commitment[];
};

export const EMPTY_SCHEDULE: MonthSchedule = { charges: [], commitments: [] };

export type UsageProjectionReason =
  /** Fewer than `FORECAST_MIN_ELAPSED_DAYS` days of usage behind us. */
  | 'INSUFFICIENT_HISTORY'
  /** Something in scope can produce usage, and nothing has been priced yet. */
  | 'NO_USAGE_ROWS'
  /** Nothing in scope produces usage (a manual-only provider): the usage half is a known 0. */
  | 'NOT_APPLICABLE';

export type MonthForecast = {
  month: string;
  today: string;
  elapsedDays: number;
  daysInMonth: number;
  minElapsedDays: number;
  /** Recognised so far this month, after §12 precedence. */
  actual: {
    micros: number;
    byKind: Record<CostKind, number>;
  };
  usage: {
    mtdMicros: number;
    /** MTD usage ÷ elapsed days × days in month; `null` with a `reason`. */
    projectedMicros: number | null;
    reason: UsageProjectionReason | null;
  };
  recurring: {
    landedMicros: number;
    /** Still to be billed this month — from the schedule, never from an average. */
    scheduledMicros: number;
    /** Landed + scheduled: what the month's recurring invoices will total. */
    committedMicros: number;
  };
  oneTime: {
    landedMicros: number;
    scheduledMicros: number;
  };
  /** Charges of this month that have not landed yet, soonest first. */
  scheduled: ScheduledCharge[];
  cash: {
    /** `usage.projectedMicros + recurring.committedMicros + oneTime`; `null` while the usage half is. */
    micros: number | null;
    /** The known part: recurring committed + one-time. Always a number. */
    floorMicros: number;
    /** `true` when `micros` is null because the usage half cannot be projected yet. */
    partial: boolean;
  };
  runRate: {
    /** `usageMicros + recurringMonthlyMicros + annualEquivalentMicros`; `null` while the usage half is. */
    micros: number | null;
    usageMicros: number | null;
    recurringMonthlyMicros: number;
    /** Active ANNUAL fees ÷ 12 — shown as run-rate, never added to cash. */
    annualEquivalentMicros: number;
    /** What the month's one-offs would have added had they been treated as run-rate. Informational. */
    oneTimeExcludedMicros: number;
  };
  currency: string | null;
  /** More than one currency across rows and schedule: the totals are `null`, the parts are still listed. */
  mixedCurrency: boolean;
};

export type ForecastInput = {
  month: string;
  today: string;
  /** The month's rows (all on or before `today`). */
  rows: readonly CostRow[];
  schedule: MonthSchedule;
  /** Whether anything in scope can produce USAGE rows. `false` makes an absent usage half a known 0. */
  usageExpected: boolean;
};

const rowKey = (r: CostRow) => `${r.source}|${r.providerId}|${r.serviceId}`;

export function monthForecast(input: ForecastInput): MonthForecast {
  const { month, today, schedule } = input;
  const rows = input.rows.filter((r) => r.day.startsWith(month));
  const all = spend(rows);

  // ── usage: the only extrapolated part ────────────────────────────────────
  const usageRows = rows.filter((r) => r.costKind === 'USAGE');
  const usageMtd = spend(usageRows).micros;
  let usageProjected = usageProjectionMicros(usageMtd, month, today, usageRows.length > 0);
  let usageReason: UsageProjectionReason | null = null;
  if (usageProjected === null) {
    if (usageRows.length === 0 && !input.usageExpected) {
      usageProjected = 0;
      usageReason = 'NOT_APPLICABLE';
    } else if (usageRows.length === 0) usageReason = 'NO_USAGE_ROWS';
    else usageReason = 'INSUFFICIENT_HISTORY';
  }

  // ── recurring: landed rows against the period's known charge ─────────────
  const landedByKey = new Map<string, number>();
  const latestByKey = new Map<string, CostRow>();
  for (const r of spendRows(rows, 'RECURRING')) {
    const scheduled = schedule.charges.some((c) => c.kind === 'RECURRING' && c.key === r.source);
    const key = scheduled ? r.source : rowKey(r);
    landedByKey.set(key, (landedByKey.get(key) ?? 0) + r.amountMicros);
    // A manual row is always described by its item's schedule; one whose
    // item charges nothing this month is a row the materialiser has not
    // rebuilt yet (a moved anchor, a pre-ADR-0015 daily share). It landed,
    // and that is all it says — it declares no commitment of its own.
    if (!scheduled && isManualCostSource(r.source)) continue;
    const prev = latestByKey.get(key);
    if (!prev || prev.day < r.day) latestByKey.set(key, r);
  }
  const recurringCharges = new Map<string, ScheduledCharge>();
  for (const c of schedule.charges) {
    if (c.kind === 'RECURRING') recurringCharges.set(c.key, c);
  }
  // A RECURRING source with no schedule entry (the monitoring model, a
  // collector-reported subscription) declares its own period amount on the
  // row; that is its commitment for the month.
  for (const [key, row] of latestByKey) {
    if (recurringCharges.has(key)) continue;
    recurringCharges.set(key, {
      key,
      providerId: row.providerId,
      serviceId: row.serviceId,
      name: null,
      kind: 'RECURRING',
      cadence: row.billingCadence ?? 'MONTHLY',
      day: null,
      amountMicros: row.periodAmountMicros ?? row.amountMicros,
      currency: row.currency,
    });
  }
  let recurringLanded = 0;
  let recurringScheduled = 0;
  const pending: ScheduledCharge[] = [];
  for (const [key, charge] of recurringCharges) {
    const landed = landedByKey.get(key) ?? 0;
    const remaining = Math.max(0, charge.amountMicros - landed);
    recurringLanded += landed;
    recurringScheduled += remaining;
    if (remaining > 0) pending.push({ ...charge, amountMicros: remaining });
  }
  // Landed recurring money under a key that has neither a schedule entry nor
  // a period amount is still money that landed.
  for (const [key, landed] of landedByKey) {
    if (!recurringCharges.has(key)) recurringLanded += landed;
  }

  // ── one-time: counted once, never averaged ───────────────────────────────
  const oneTimeRows = spendRows(rows, 'ONE_TIME');
  const oneTimeLanded = oneTimeRows.reduce((n, r) => n + r.amountMicros, 0);
  const landedOneTimeKeys = new Set(oneTimeRows.map((r) => r.source));
  let oneTimeScheduled = 0;
  for (const c of schedule.charges) {
    if (c.kind !== 'ONE_TIME' || landedOneTimeKeys.has(c.key)) continue;
    oneTimeScheduled += c.amountMicros;
    pending.push(c);
  }
  pending.sort(
    (a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999') || a.key.localeCompare(b.key),
  );

  // ── run-rate: active fees, normalised ────────────────────────────────────
  const commitments = new Map<string, Commitment>();
  for (const c of schedule.commitments) commitments.set(c.key, c);
  for (const [key, row] of latestByKey) {
    if (commitments.has(key) || schedule.charges.some((c) => c.key === key)) continue;
    commitments.set(key, {
      key,
      providerId: row.providerId,
      serviceId: row.serviceId,
      name: null,
      cadence: row.billingCadence ?? 'MONTHLY',
      periodAmountMicros: row.periodAmountMicros ?? row.amountMicros,
      currency: row.currency,
    });
  }
  let recurringMonthly = 0;
  let annualEquivalent = 0;
  for (const c of commitments.values()) {
    if (c.cadence === 'MONTHLY') recurringMonthly += c.periodAmountMicros;
    else annualEquivalent += Math.round(c.periodAmountMicros / 12);
  }

  // ── currency ─────────────────────────────────────────────────────────────
  const currencies = new Set<string>();
  for (const r of rows) currencies.add(r.currency);
  for (const c of schedule.charges) currencies.add(c.currency);
  for (const c of schedule.commitments) currencies.add(c.currency);
  const mixedCurrency = currencies.size > 1;
  const currency = currencies.size === 1 ? [...currencies][0]! : null;

  const recurringCommitted = recurringLanded + recurringScheduled;
  const floor = recurringCommitted + oneTimeLanded + oneTimeScheduled;
  const cashMicros = mixedCurrency || usageProjected === null ? null : usageProjected + floor;
  const runRateMicros =
    mixedCurrency || usageProjected === null
      ? null
      : usageProjected + recurringMonthly + annualEquivalent;

  return {
    month,
    today,
    elapsedDays: elapsedDays(month, today),
    daysInMonth: daysInMonth(month),
    minElapsedDays: FORECAST_MIN_ELAPSED_DAYS,
    actual: { micros: all.micros, byKind: all.byKind },
    usage: { mtdMicros: usageMtd, projectedMicros: usageProjected, reason: usageReason },
    recurring: {
      landedMicros: recurringLanded,
      scheduledMicros: recurringScheduled,
      committedMicros: recurringCommitted,
    },
    oneTime: { landedMicros: oneTimeLanded, scheduledMicros: oneTimeScheduled },
    scheduled: pending,
    cash: { micros: cashMicros, floorMicros: floor, partial: cashMicros === null },
    runRate: {
      micros: runRateMicros,
      usageMicros: usageProjected,
      recurringMonthlyMicros: recurringMonthly,
      annualEquivalentMicros: annualEquivalent,
      oneTimeExcludedMicros: oneTimeLanded + oneTimeScheduled,
    },
    currency,
    mixedCurrency,
  };
}

/** The winning rows of one kind — `spend()`'s selection, filtered. */
function spendRows(rows: readonly CostRow[], kind: CostKind): CostRow[] {
  return winningRows(rows).filter((r) => r.costKind === kind);
}

/** The three numbers a budget compares itself against. */
export function scopeProjection(f: MonthForecast): ScopeProjection {
  return {
    cashMicros: f.cash.micros,
    cashFloorMicros: f.cash.floorMicros,
    runRateMicros: f.runRate.micros,
  };
}
