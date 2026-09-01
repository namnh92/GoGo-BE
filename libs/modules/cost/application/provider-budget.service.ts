import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { listCostMicros, pricingFor, utcDay } from '../domain/provider-pricing';

/**
 * PR2 / COST-BE-002 (#335) — the hard budget.
 *
 * This is the only mechanism that can stop GoGo spending money at Google. The
 * plan's §2.2 is explicit about what it is not, and the rejected list repeats
 * it: **Redis, Prometheus, Grafana and Cloud Billing alerts are not the
 * guard.** An alert fires after the money is gone; an in-memory counter forgets
 * on deploy and disagrees between replicas; Redis is a cache we already treat
 * as losable. Postgres holds the reservation because a row that survives a
 * restart, is visible to every replica, and can be taken inside a transaction
 * is the only shape a ceiling can have.
 *
 * Roles, unchanged from the plan:
 *
 * | Postgres reservation | hard internal guard (this file) |
 * | Google per-day quota | external safety net (INF-015) |
 * | Cloud Billing budget | alert only |
 * | Prometheus / Grafana | observability only |
 *
 * Three ceilings, all evaluated in the same transaction, all per scope:
 *
 * 1. absolute **calls/day** — the blunt one, and the one that holds even if
 *    the pricing registry is wrong;
 * 2. **units per operation** — a per-SKU ceiling, so one expensive tier
 *    cannot consume the whole allowance;
 * 3. worst-case **list-price cost** — cost-aware, because "1,000 calls" means
 *    $0 of liveness or $20 of Enterprise Details and a calls-only ceiling
 *    cannot tell those apart (§0.2 C7).
 *
 * And two rules that make it conservative by construction:
 *
 * - **No free-tier or volume-discount deduction.** Google aggregates free caps
 *   per billing account per SKU per month across every linked project; GoGo
 *   has no authoritative view of it. An over-generous estimate of "free tier
 *   remaining" would authorise a paid call, and whether the scheduler may
 *   spend money is a safety property, not an estimate.
 * - **An unknown price refuses.** A ceiling in dollars cannot bound an
 *   operation whose price nobody has verified (Routes per-element, Dynamic
 *   Maps). `price_unknown` is a refusal, not a zero.
 *
 * Reservation precedes the call and is never refunded. A call that failed
 * still consumed Google quota and may still have been billed; refunding it
 * would let a retry storm spend past the ceiling.
 */

/** Who is spending. Ceilings are per scope so one job cannot eat another's. */
export type BudgetScope = 'google.places.refresh' | 'google.places.import';

export type BudgetLimits = {
  /** Absolute calls per day for the scope. `null` = not configured. */
  maxCallsPerDay: number | null;
  /** Worst-case list-price ceiling for the scope, USD micros. `null` = not configured. */
  maxListCostMicrosPerDay: number | null;
  /** Per operation unit ceiling. A missing operation is not configured. */
  maxUnitsByOperation: Readonly<Record<string, number>>;
};

export type ReserveRequest = {
  scope: BudgetScope;
  /** Adapter `method` label — `google.details.liveness`, not the SKU. */
  operation: string;
  calls: number;
  units: number;
  /** Defaults to today (UTC). Injected in tests. */
  day?: string;
};

export type ReserveRefusal =
  /** No ceiling is configured for this scope. Default deny — see below. */
  | 'not_configured'
  /** No unit ceiling for this operation under this scope. */
  | 'operation_not_configured'
  /** The registry has no verified price, so no cost ceiling can bound it. */
  | 'price_unknown'
  | 'call_ceiling'
  | 'unit_ceiling'
  | 'cost_ceiling';

export type ReserveResult =
  | {
      ok: true;
      /** What this call consumed. */
      reserved: { calls: number; units: number; costMicros: number };
      /** Where the scope stands after it, for the caller's log line. */
      scopeTotals: { calls: number; costMicros: number };
      operationUnits: number;
    }
  | { ok: false; reason: ReserveRefusal };

export class ProviderBudgetService {
  constructor(private readonly db: Db) {}

  /**
   * Reserve budget for a call that has not been made yet.
   *
   * **Default deny.** A scope with no configured ceiling refuses rather than
   * allowing: an unset environment variable is the most likely way this guard
   * ever ends up absent in production, and "no limit configured" must not read
   * as "no limit". Nothing in this PR reserves — PR7's refresh job is the first
   * caller — so a deny-by-default cannot regress a live path.
   *
   * Atomicity is a transaction-scoped advisory lock on `(day, scope)` plus one
   * conditional upsert. The lock, not `FOR UPDATE`, because the check is an
   * aggregate over the scope's rows and the row that would break the ceiling
   * may not exist yet — `SELECT … FOR UPDATE` locks rows that are there and is
   * blind to the phantom a concurrent reserver is about to insert. (Postgres
   * also refuses `FOR UPDATE` in a query with aggregates outright.) The lock
   * releases with the transaction on commit, rollback, crash or disconnect.
   */
  async reserve(request: ReserveRequest, limits: BudgetLimits): Promise<ReserveResult> {
    const day = request.day ?? utcDay();
    const { scope, operation } = request;
    const calls = Math.max(0, Math.trunc(request.calls));
    const units = Math.max(0, Math.trunc(request.units));

    const maxCalls = limits.maxCallsPerDay;
    const maxCostMicros = limits.maxListCostMicrosPerDay;
    if (maxCalls === null || maxCostMicros === null) {
      return { ok: false, reason: 'not_configured' };
    }
    const maxUnits = limits.maxUnitsByOperation[operation];
    if (maxUnits === undefined) return { ok: false, reason: 'operation_not_configured' };

    // Priced at list, on the day of the call. `null` here is the registry
    // saying it does not know — which is a refusal, not a free pass.
    const costMicros = listCostMicros(operation, day, units);
    if (costMicros === null) return { ok: false, reason: 'price_unknown' };

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${day}|${scope}`}, 0))`,
      );

      const [current] = (
        await tx.execute(sql`
          select
            coalesce(sum(reserved_calls), 0)::bigint       as calls,
            coalesce(sum(reserved_cost_micros), 0)::bigint as cost,
            coalesce(sum(reserved_units) filter (where operation = ${operation}), 0)::bigint as units
          from provider_budget_daily
          where day = ${day}::date and scope = ${scope}
        `)
      ).rows as unknown as {
        calls: string | number;
        cost: string | number;
        units: string | number;
      }[];

      const usedCalls = Number(current?.calls ?? 0);
      const usedCost = Number(current?.cost ?? 0);
      const usedUnits = Number(current?.units ?? 0);

      // Checked in the order an operator would want to read them: the blunt
      // ceiling first, then the SKU one, then the money.
      if (usedCalls + calls > maxCalls) {
        return { ok: false, reason: 'call_ceiling' } as const;
      }
      if (usedUnits + units > maxUnits) {
        return { ok: false, reason: 'unit_ceiling' } as const;
      }
      if (usedCost + costMicros > maxCostMicros) {
        return { ok: false, reason: 'cost_ceiling' } as const;
      }

      await tx.execute(sql`
        insert into provider_budget_daily
          (day, scope, operation, reserved_calls, reserved_units, reserved_cost_micros, updated_at)
        values (${day}::date, ${scope}, ${operation}, ${calls}, ${units}, ${costMicros}, now())
        on conflict (day, scope, operation) do update set
          reserved_calls       = provider_budget_daily.reserved_calls + excluded.reserved_calls,
          reserved_units       = provider_budget_daily.reserved_units + excluded.reserved_units,
          reserved_cost_micros = provider_budget_daily.reserved_cost_micros + excluded.reserved_cost_micros,
          updated_at           = now()
      `);

      return {
        ok: true,
        reserved: { calls, units, costMicros },
        scopeTotals: { calls: usedCalls + calls, costMicros: usedCost + costMicros },
        operationUnits: usedUnits + units,
      } as const;
    });
  }

  /** What a scope has consumed today, for a runbook or an ops screen. */
  async consumed(
    scope: BudgetScope,
    day: string = utcDay(),
  ): Promise<{ operation: string; calls: number; units: number; costMicros: number }[]> {
    const result = await this.db.execute(sql`
      select operation, reserved_calls, reserved_units, reserved_cost_micros
      from provider_budget_daily
      where day = ${day}::date and scope = ${scope}
      order by operation
    `);
    return (
      result.rows as unknown as {
        operation: string;
        reserved_calls: number | string;
        reserved_units: number | string;
        reserved_cost_micros: number | string;
      }[]
    ).map((row) => ({
      operation: row.operation,
      calls: Number(row.reserved_calls),
      units: Number(row.reserved_units),
      costMicros: Number(row.reserved_cost_micros),
    }));
  }
}

/**
 * Environment-variable prefix per scope.
 *
 * `PLACE_REFRESH_DAILY_MAX_CALLS`, `PLACE_REFRESH_DAILY_MAX_LIST_COST_USD`,
 * `PLACE_REFRESH_DAILY_MAX_UNITS_<OPERATION>` (plan §2.2). A scope that is not
 * in this map has no ceilings and therefore reserves nothing.
 */
const SCOPE_ENV_PREFIX: Readonly<Record<BudgetScope, string>> = {
  'google.places.refresh': 'PLACE_REFRESH',
  'google.places.import': 'PLACE_IMPORT',
};

/** `google.details.liveness` → `GOOGLE_DETAILS_LIVENESS`. */
export function operationEnvSuffix(operation: string): string {
  return operation.replace(/[.-]/g, '_').toUpperCase();
}

export function unitsEnvKey(scope: BudgetScope, operation: string): string {
  return `${SCOPE_ENV_PREFIX[scope]}_DAILY_MAX_UNITS_${operationEnvSuffix(operation)}`;
}

/**
 * Read a scope's ceilings out of a validated environment.
 *
 * Pure, so the mapping from names to numbers is testable without a process.
 * A missing or unparseable value is `null`, and `null` means refuse — never
 * "unlimited". The USD ceiling is given in dollars because that is what an
 * operator writes in a manifest; it is converted to micros here so nothing
 * downstream has to remember the unit.
 */
export function budgetLimitsFrom(
  scope: BudgetScope,
  env: Readonly<Record<string, string | number | boolean | undefined>>,
): BudgetLimits {
  const prefix = SCOPE_ENV_PREFIX[scope];
  const maxUnitsByOperation: Record<string, number> = {};
  const unitsPrefix = `${prefix}_DAILY_MAX_UNITS_`;
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(unitsPrefix)) continue;
    const suffix = key.slice(unitsPrefix.length);
    const operation = PROVIDER_OPERATION_BY_ENV_SUFFIX[suffix];
    if (operation === undefined) continue;
    const parsed = nonNegativeInt(value);
    if (parsed !== null) maxUnitsByOperation[operation] = parsed;
  }
  const usd = nonNegativeNumber(env[`${prefix}_DAILY_MAX_LIST_COST_USD`]);
  return {
    maxCallsPerDay: nonNegativeInt(env[`${prefix}_DAILY_MAX_CALLS`]),
    maxListCostMicrosPerDay: usd === null ? null : Math.floor(usd * 1_000_000),
    maxUnitsByOperation,
  };
}

/**
 * The reverse of `operationEnvSuffix`, built from the pricing registry.
 *
 * An env var naming an operation the registry has never heard of is ignored
 * rather than trusted: a typo in a manifest must not silently create a ceiling
 * for an operation that does not exist, because the operation that *does*
 * exist would then have none and refuse everything.
 */
const PROVIDER_OPERATION_BY_ENV_SUFFIX: Readonly<Record<string, string>> = Object.fromEntries(
  [
    'google.searchText',
    'google.details.liveness',
    'google.details.core',
    'google.details.quality',
    'google.details.detail',
    'google.autocomplete',
    'google.routeMatrix',
    'google.expand',
  ].map((operation) => [operationEnvSuffix(operation), operation]),
);

function nonNegativeInt(value: string | number | boolean | undefined): number | null {
  const n = nonNegativeNumber(value);
  return n === null ? null : Math.floor(n);
}

function nonNegativeNumber(value: string | number | boolean | undefined): number | null {
  if (value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Re-exported so a caller can check a price exists before planning a batch. */
export { pricingFor };
