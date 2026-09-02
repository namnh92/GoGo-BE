import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * PR2 / COST-BE-002 (#335) — provider usage accounting and the hard budget.
 *
 * **Two tables, deliberately.** The plan's §0.2 C5 and its rejected list both
 * say so, and the reason is that they answer different questions with
 * different failure modes:
 *
 * - `provider_usage_daily` is **what happened**. It is trend and accounting
 *   data, written after the fact by a buffered ledger, and losing one flush
 *   window to a SIGKILL costs a few counts that Grafana can reconcile.
 * - `provider_budget_daily` is **what we allow**. It is a safety interlock
 *   written *before* the call inside one atomic statement, and losing a row
 *   would authorise spend. It is never derived from the other, and no row in
 *   it is ever released — a call that failed still consumed its reservation.
 *
 * Collapsing them into one table makes the accounting write a prerequisite of
 * the provider call, which is exactly the coupling §2.3 rejects.
 */

/**
 * What happened, per UTC day, per environment, per operation.
 *
 * `operation` is the adapter's own `method` label — `google.details.quality`,
 * `google.routeMatrix` — not the billing SKU. Routes is the one operation
 * whose SKU string differs, and `operationForSku` folds it here so one
 * operation is one row (#332).
 *
 * `calls_attempted` and `calls_succeeded` are tracked apart because they are
 * charged apart: Google bills a served response, and a 429 or a breaker trip
 * is a call that happened and cost nothing. `billable_units` is a third,
 * independent quantity — 1 per successful Places call, one per *matrix
 * element* for Routes, 0 for Sheets — so a row with 3 calls and 25 units is
 * not a contradiction.
 */
export const providerUsageDaily = pgTable(
  'provider_usage_daily',
  {
    day: date('day').notNull(),
    /** `dev` | `staging` | `prod`. One Grafana stack and one database hold several. */
    environment: text('environment').notNull(),
    operation: text('operation').notNull(),
    callsAttempted: integer('calls_attempted').notNull().default(0),
    callsSucceeded: integer('calls_succeeded').notNull().default(0),
    /** bigint: Routes counts elements, and a matrix is quadratic in stops. */
    billableUnits: bigint('billable_units', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.environment, t.operation] })],
);

/**
 * What we allow, per UTC day, per scope, per operation.
 *
 * A reservation is taken **before** the provider call and is never refunded:
 * a failed call still burned quota at Google and may still have been billed,
 * so refunding it would let a retry storm spend past the ceiling. Conservative
 * by construction is the whole point of the table.
 *
 * `reserved_cost_micros` is list price × units with **no free-tier and no
 * volume-discount deduction**. Google aggregates free caps per billing account
 * per SKU per month across every linked project; GoGo cannot see that, and a
 * wrong "we still have free tier left" estimate must never be the thing that
 * authorises a paid call. Free-cap arithmetic belongs to reporting.
 */
export const providerBudgetDaily = pgTable(
  'provider_budget_daily',
  {
    day: date('day').notNull(),
    /** `google.places.refresh` | `google.places.import` | … — who is spending. */
    scope: text('scope').notNull(),
    operation: text('operation').notNull(),
    reservedCalls: integer('reserved_calls').notNull().default(0),
    reservedUnits: bigint('reserved_units', { mode: 'number' }).notNull().default(0),
    /** USD micros at list price. Never free-cap adjusted. */
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope, t.operation] })],
);

/**
 * COST-BE-016 (#368) — epic §9, the canonical usage model.
 *
 * One row per (day, environment, provider, service, operation, meter, SKU,
 * source). Where `provider_usage_daily` above knows three fixed quantities
 * per Google operation, this knows *what is being counted*: `usage_metric_id`
 * is the meter's short metric (`calls`, `billable_elements`, `commands`) and
 * `unit` says what one of it is. Several meters for one runtime operation is
 * the point — Routes writes `calls` and `billable_elements` for one call.
 *
 * `source` is which collector wrote the row (`ledger` for the in-process
 * metrics ledger). Two sources never share a row and never sum.
 */
export const providerUsageMeterDaily = pgTable(
  'provider_usage_meter_daily',
  {
    day: date('day').notNull(),
    environment: text('environment').notNull(),
    providerId: text('provider_id').notNull(),
    serviceId: text('service_id').notNull(),
    operationId: text('operation_id'),
    usageMetricId: text('usage_metric_id').notNull(),
    billingSkuId: text('billing_sku_id'),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
    unit: text('unit').notNull(),
    source: text('source').notNull(),
    /** HIGH | MEDIUM | LOW — a check constraint in the migration. */
    confidence: text('confidence').notNull(),
    sourceAsOf: timestamp('source_as_of', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('provider_usage_meter_daily_key').on(
      t.day,
      t.environment,
      t.providerId,
      t.serviceId,
      sql`coalesce(${t.operationId}, '')`,
      t.usageMetricId,
      sql`coalesce(${t.billingSkuId}, '')`,
      t.source,
    ),
    index('provider_usage_meter_daily_env_day_idx').on(t.environment, t.day),
  ],
);

/**
 * COST-BE-016 (#368) — epic §11, the canonical cost model. Money, apart from
 * usage (epic §8).
 *
 * A row is an amount in its original currency with a `basis` — ACTUAL from a
 * provider invoice, ESTIMATED from usage × a pricing rule, FIXED, MANUAL —
 * a `confidence`, a `source`, and for estimates the `pricing_version` they
 * were computed under. **Unknown cost is the absence of a row**, never an
 * amount of 0. Two bases for the same spend are two rows; readers apply
 * ACTUAL > ESTIMATED > UNKNOWN (epic §12) and never add them.
 */
export const providerCostDaily = pgTable(
  'provider_cost_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    day: date('day').notNull(),
    environment: text('environment').notNull(),
    providerId: text('provider_id').notNull(),
    serviceId: text('service_id').notNull(),
    operationId: text('operation_id'),
    usageMetricId: text('usage_metric_id'),
    billingSkuId: text('billing_sku_id'),
    billableQuantity: bigint('billable_quantity', { mode: 'number' }),
    billableUnit: text('billable_unit'),
    /** Original billing currency micros; never FX-converted in place. */
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    /** ACTUAL | ESTIMATED | FIXED | MANUAL — check constraint in the migration. */
    basis: text('basis').notNull(),
    confidence: text('confidence').notNull(),
    source: text('source').notNull(),
    pricingVersion: text('pricing_version'),
    sourceAsOf: timestamp('source_as_of', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('provider_cost_daily_key').on(
      t.day,
      t.environment,
      t.providerId,
      t.serviceId,
      sql`coalesce(${t.operationId}, '')`,
      sql`coalesce(${t.usageMetricId}, '')`,
      sql`coalesce(${t.billingSkuId}, '')`,
      t.source,
      t.basis,
    ),
    index('provider_cost_daily_env_day_idx').on(t.environment, t.day),
  ],
);
