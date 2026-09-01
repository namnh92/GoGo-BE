import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * COST-BE-002 (#335) — what Google actually cost us, and what we are still
 * allowed to spend.
 *
 * Two tables, deliberately not one. They answer different questions and have
 * different truth conditions:
 *
 * - `provider_usage_daily` is **accounting**: what happened. It is written
 *   after the fact, tolerates a bounded gap on a hard kill, and is reconciled
 *   against Grafana. Being slightly behind is acceptable.
 * - `provider_budget_daily` is **a safety property**: what has been authorised.
 *   It is written before the call, in one atomic statement, and being wrong in
 *   the optimistic direction means an unbudgeted invoice. Nothing here is
 *   estimated, and no free-tier credit is ever deducted from it.
 *
 * Merging them would force one of those two contracts onto the other.
 */

/**
 * Usage, per UTC day, per environment, per billed operation.
 *
 * `operation` is the **billing** label — the value on
 * `places_provider_cost_units{sku}` — not the request label. The two differ
 * for Routes (`routes.computeRouteMatrix` bills, `google.routeMatrix`
 * requests), and keying on the request label would file the calls and the
 * money as different rows. See `billingOperationOf`.
 *
 * `calls_attempted` counts every response, `calls_succeeded` only the ones
 * Google billed for. Both matter: a day of 500s costs nothing and must not
 * read as a quiet day.
 */
export const providerUsageDaily = pgTable(
  'provider_usage_daily',
  {
    day: date('day').notNull(),
    /**
     * The deployment, so DEV traffic cannot be read as production spend.
     * Google aggregates per billing account, not per environment, so this is
     * GoGo's own split and is labelled as such wherever it is reported.
     */
    environment: text('environment').notNull(),
    operation: text('operation').notNull(),
    callsAttempted: integer('calls_attempted').notNull().default(0),
    callsSucceeded: integer('calls_succeeded').notNull().default(0),
    /**
     * What an invoice is computed from: 1 per successful Places call, one per
     * matrix **element** for Routes, 0 for Sheets. `bigint` because elements
     * multiply — a 20×20 matrix is 400 of these from one call.
     */
    billableUnits: bigint('billable_units', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.environment, t.operation] }),
    index('provider_usage_daily_day_idx').on(t.day),
  ],
);

/**
 * Reservations, per UTC day, per scope, per operation.
 *
 * A row is written **before** the provider call and is never refunded when the
 * call fails — the conservative direction. A budget that gives credit back on
 * failure lets a broken retry loop run forever inside its ceiling, which is
 * the failure mode a hard budget exists to prevent.
 *
 * `reserved_cost_micros` is list price × units with **no free-tier or
 * volume-discount deduction**. Google aggregates free caps per billing account
 * per SKU per month across every linked project, and GoGo has no authoritative
 * view of that. A wrong "you still have free calls left" estimate must never
 * be able to authorise a paid call, so the guard prices everything as if
 * nothing were free. Free-cap arithmetic lives in reporting, where being
 * optimistic costs nothing.
 */
export const providerBudgetDaily = pgTable(
  'provider_budget_daily',
  {
    day: date('day').notNull(),
    /** Which spender: `google.places.refresh`, `google.places.import`, … */
    scope: text('scope').notNull(),
    operation: text('operation').notNull(),
    reservedCalls: integer('reserved_calls').notNull().default(0),
    reservedUnits: bigint('reserved_units', { mode: 'number' }).notNull().default(0),
    /** USD micros at list price. Integer money; no floats near this. */
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope, t.operation] })],
);
