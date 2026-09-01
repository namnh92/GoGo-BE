import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { DB } from '../../shared/tokens';
import { listCostMicros, utcDay } from '../domain/provider-pricing';

/**
 * COST-BE-002 (#335) — the hard daily ceiling on paid Google calls.
 *
 * This is a safety property, not a metric. Three roles, and only the first one
 * can actually stop a call:
 *
 * ```text
 * Postgres reservation (here)      hard internal guard
 * Google per-day API quota         external safety net (INF-015)
 * Cloud Billing budget alert       observability only — it notifies, it never blocks
 * Prometheus / Grafana             observability only
 * ```
 *
 * Redis and in-memory counters were rejected: a ceiling that resets on deploy,
 * or that each replica keeps its own copy of, is not a ceiling.
 *
 * Three limits are checked in **one** statement, because checking them in
 * three would let two callers each pass a check the other invalidated:
 *
 * 1. calls per day, per scope (summed over every operation)
 * 2. units per day, per scope **and** operation
 * 3. worst-case list cost per day, per scope
 *
 * Reservation happens *before* the call and is never refunded when the call
 * fails. That is deliberate and conservative: refunding on failure lets a
 * broken retry loop spin forever inside its own ceiling, which is the exact
 * scenario a hard budget exists to prevent.
 */

export type BudgetScope = 'google.places.refresh' | 'google.places.import';

export type BudgetLimits = {
  maxCallsPerDay: number;
  maxUnitsPerOperation: number;
  maxListCostMicrosPerDay: number;
};

export type ReservationRequest = {
  scope: BudgetScope;
  /** Billing label — the same vocabulary the pricing registry is keyed on. */
  operation: string;
  calls: number;
  units: number;
  limits: BudgetLimits;
  /** Overridable so a test can pin the day without touching the clock. */
  day?: string;
};

export type ReservationResult =
  | { granted: true; reservedCalls: number; reservedUnits: number; reservedCostMicros: number }
  | { granted: false; reason: 'CALLS' | 'UNITS' | 'COST' | 'UNPRICEABLE' };

@Injectable()
export class ProviderBudgetService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Reserves budget, or refuses. There is no third answer and no partial grant
   * — a caller that asked for 20 calls and got 12 would have to unpick which
   * of its work to drop, and every caller would unpick it differently.
   */
  async reserve(input: ReservationRequest): Promise<ReservationResult> {
    const day = input.day ?? utcDay();
    const cost = listCostMicros(input.operation, day, input.units);
    if (cost === null) {
      // No price means no way to know what this would cost. Refusing is the
      // only safe answer: treating an unpriced operation as free is how an
      // unmetered SKU runs up an invoice nobody budgeted for.
      return { granted: false, reason: 'UNPRICEABLE' };
    }

    // One transaction, serialised on a lock keyed to (day, scope).
    //
    // The obvious shape — aggregate the scope's rows `FOR UPDATE` and insert
    // conditionally in one statement — is not available: Postgres rejects row
    // locking combined with aggregation (`0A000`, CheckSelectLocking). Locking
    // the rows in a CTE and aggregating over that does parse, but it locks
    // *existing* rows only, so the first two reservations of a day have
    // nothing to contend on and both pass the same empty read. That is exactly
    // the window a budget must not have.
    //
    // An advisory lock has no such gap: it exists whether or not a row does,
    // it is held to the end of the transaction, and it is scoped narrowly
    // enough that two different scopes never wait on each other.
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${day}|${input.scope}`}, 0))`,
      );

      const current = await tx.execute(sql`
        select coalesce(sum(reserved_calls), 0)::bigint as calls,
               coalesce(sum(reserved_cost_micros), 0)::bigint as cost,
               coalesce(sum(reserved_units) filter (where operation = ${input.operation}), 0)::bigint as units
          from provider_budget_daily
         where day = ${day}::date and scope = ${input.scope}
      `);
      const row = current.rows[0] as { calls: string; cost: string; units: string };
      const calls = Number(row.calls);
      const units = Number(row.units);
      const spent = Number(row.cost);

      // Checked in the order an operator would want named: the crude ceiling
      // first, then the per-SKU one, then money.
      if (calls + input.calls > input.limits.maxCallsPerDay) {
        return { granted: false, reason: 'CALLS' } as const;
      }
      if (units + input.units > input.limits.maxUnitsPerOperation) {
        return { granted: false, reason: 'UNITS' } as const;
      }
      if (spent + cost > input.limits.maxListCostMicrosPerDay) {
        return { granted: false, reason: 'COST' } as const;
      }

      const inserted = await tx.execute(sql`
        insert into provider_budget_daily as b
          (day, scope, operation, reserved_calls, reserved_units, reserved_cost_micros, updated_at)
        values (${day}::date, ${input.scope}, ${input.operation},
                ${input.calls}, ${input.units}, ${cost}, now())
        on conflict (day, scope, operation) do update
          set reserved_calls = b.reserved_calls + excluded.reserved_calls,
              reserved_units = b.reserved_units + excluded.reserved_units,
              reserved_cost_micros = b.reserved_cost_micros + excluded.reserved_cost_micros,
              updated_at = now()
        returning reserved_calls, reserved_units, reserved_cost_micros
      `);
      const written = inserted.rows[0] as {
        reserved_calls: number;
        reserved_units: string | number;
        reserved_cost_micros: string | number;
      };
      return {
        granted: true,
        reservedCalls: Number(written.reserved_calls),
        reservedUnits: Number(written.reserved_units),
        reservedCostMicros: Number(written.reserved_cost_micros),
      } as const;
    });
  }

  /** What a scope has reserved today — for the ops view and for tests. */
  async reservedToday(scope: BudgetScope, day: string = utcDay()) {
    const rows = await this.db
      .select()
      .from(schema.providerBudgetDaily)
      .where(
        sql`${schema.providerBudgetDaily.day} = ${day}::date and ${schema.providerBudgetDaily.scope} = ${scope}`,
      );
    return rows.map((r) => ({
      operation: r.operation,
      calls: Number(r.reservedCalls),
      units: Number(r.reservedUnits),
      costMicros: Number(r.reservedCostMicros),
    }));
  }
}
