import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  PRICING_RULES,
  estimateMicros,
  newestEffectiveFrom,
  ruleInForce,
  type FreeAllowance,
  type PricingRule,
} from '../domain/pricing-rules';

/**
 * COST-BE-016 (#368) — the generic estimator (epic §7 `CostEstimator`, §11,
 * §13, §25).
 *
 * Reads billable meter rows from `provider_usage_meter_daily`, prices each
 * with the rule in force on its day, consumes free allowances chronologically
 * per allowance scope, and writes `provider_cost_daily` rows with
 * `basis = ESTIMATED`, `source = 'estimator'`. It knows no provider: the
 * meter row says which SKU it is, the rule says what that SKU costs, and
 * nothing in between asks whose SKU it was.
 *
 * Properties, all tested:
 *
 * 1. **Idempotent and bounded.** A recompute over `[from, to]` deletes the
 *    estimator's own rows in that range and rewrites them. Nothing else is
 *    touched — not another source's estimate and never an ACTUAL row
 *    (epic §25 "do NOT silently mutate ACTUAL provider data").
 * 2. **Unknown stays unknown.** A SKU whose rule has no verified price gets
 *    no row, and is named in the result so a dashboard can list it as a gap
 *    rather than print $0.
 * 3. **Allowance is consumed in date order within its period.** The day that
 *    crosses the cap is the day charges start; applying a monthly cap to each
 *    day independently would zero the month. The consumption walk starts at
 *    the period boundary even when `from` is later, so a mid-month recompute
 *    is priced against the month's real prior usage.
 * 4. **MEDIUM confidence, always.** The free cap is per billing account
 *    across projects; GoGo prices per environment (epic §10, ADR-0012).
 */

export type MeterUsageRow = {
  day: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string;
  billingSkuId: string;
  quantity: number;
  unit: string;
  source: string;
};

export type EstimatedCostRow = {
  day: string;
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string;
  billingSkuId: string;
  billableQuantity: number;
  billableUnit: string;
  amountMicros: number;
  currency: string;
  pricingVersion: string;
  /** Which usage source this estimate was priced from. */
  usageSource: string;
  metadata: { listMicros: number; allowancePriorQuantity: number; ruleId: string };
};

export type EstimatePlan = {
  rows: EstimatedCostRow[];
  /** SKUs seen in usage with no priced rule in force. Gaps, never zeros. */
  unpriced: { billingSkuId: string; day: string }[];
};

function periodKey(day: string, allowance: FreeAllowance): string {
  switch (allowance.period) {
    case 'DAY':
      return day;
    case 'MONTH':
      return day.slice(0, 7);
    case 'YEAR':
      return day.slice(0, 4);
  }
}

function scopeKey(row: MeterUsageRow, rule: PricingRule, allowance: FreeAllowance): string {
  switch (allowance.scope) {
    case 'SKU':
      return `sku:${row.billingSkuId}`;
    case 'SERVICE':
      return `service:${row.serviceId}`;
    case 'PROJECT':
    case 'ACCOUNT':
    case 'DAILY':
    case 'MONTHLY':
      // GoGo sees one project and one account per environment; the nearest
      // key it can honour is the provider. Labelled MEDIUM for this reason.
      return `provider:${rule.providerId}`;
  }
}

/**
 * Pure planning step: usage rows in → cost rows out. `rows` must cover the
 * whole allowance period up to `to`; only days in `[from, to]` are emitted.
 */
export function planEstimates(
  rows: readonly MeterUsageRow[],
  range: { from: string; to: string },
  rules: readonly PricingRule[] = PRICING_RULES,
  pricingVersion: string = newestEffectiveFrom(rules),
): EstimatePlan {
  const sorted = [...rows].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.billingSkuId.localeCompare(b.billingSkuId) ||
      a.source.localeCompare(b.source) ||
      (a.operationId ?? '').localeCompare(b.operationId ?? ''),
  );
  const consumed = new Map<string, number>();
  const out: EstimatedCostRow[] = [];
  const unpriced: EstimatePlan['unpriced'] = [];

  for (const row of sorted) {
    if (row.quantity <= 0) continue;
    const rule = ruleInForce(rules, { billingSkuId: row.billingSkuId }, row.day);
    if (rule === null) {
      if (row.day >= range.from && row.day <= range.to) {
        unpriced.push({ billingSkuId: row.billingSkuId, day: row.day });
      }
      continue;
    }
    // Allowance state is per (source): two collectors reporting the same SKU
    // are two views of the same spend and each is priced as a whole month.
    const allowance = rule.freeAllowance;
    const key =
      allowance === null
        ? null
        : `${row.source}|${scopeKey(row, rule, allowance)}|${periodKey(row.day, allowance)}`;
    const prior = key === null ? 0 : (consumed.get(key) ?? 0);
    const estimate = estimateMicros(rule, row.quantity, prior, row.day);
    if (key !== null) consumed.set(key, prior + row.quantity);
    if (!estimate.known) {
      if (row.day >= range.from && row.day <= range.to) {
        unpriced.push({ billingSkuId: row.billingSkuId, day: row.day });
      }
      continue;
    }
    if (row.day < range.from || row.day > range.to) continue;
    out.push({
      day: row.day,
      providerId: row.providerId,
      serviceId: row.serviceId,
      operationId: row.operationId,
      usageMetricId: row.usageMetricId,
      billingSkuId: row.billingSkuId,
      billableQuantity: row.quantity,
      billableUnit: row.unit,
      amountMicros: estimate.freeAdjustedMicros,
      currency: rule.currency,
      pricingVersion,
      usageSource: row.source,
      metadata: { listMicros: estimate.listMicros, allowancePriorQuantity: prior, ruleId: rule.id },
    });
  }
  return { rows: out, unpriced };
}

/** Earliest day the allowance walk must start from to price `from` correctly. */
export function allowanceWalkStart(
  from: string,
  rules: readonly PricingRule[] = PRICING_RULES,
): string {
  let start = from;
  for (const rule of rules) {
    const a = rule.freeAllowance;
    if (a === null) continue;
    const candidate =
      a.period === 'DAY'
        ? from
        : a.period === 'MONTH'
          ? `${from.slice(0, 7)}-01`
          : `${from.slice(0, 4)}-01-01`;
    if (candidate < start) start = candidate;
  }
  return start;
}

export const ESTIMATOR_SOURCE = 'estimator';

export type RecomputeResult = {
  from: string;
  to: string;
  rowsWritten: number;
  rowsDeleted: number;
  unpriced: { billingSkuId: string; day: string }[];
};

export class CostEstimatorService {
  constructor(
    private readonly db: Db,
    private readonly options: {
      environment: string;
      rules?: readonly PricingRule[];
      pricingVersion?: string;
    },
  ) {}

  /**
   * Recompute the estimator's rows for `[from, to]` (UTC days, inclusive).
   * One transaction: delete own rows in range, insert the new plan. Other
   * sources and every non-ESTIMATED basis are untouched by construction —
   * the delete names `source` and `basis`.
   */
  async recompute(range: { from: string; to: string }): Promise<RecomputeResult> {
    if (range.from > range.to)
      throw new Error(`recompute: from ${range.from} is after to ${range.to}`);
    const rules = this.options.rules ?? PRICING_RULES;
    const walkFrom = allowanceWalkStart(range.from, rules);
    const usage = await this.usageRows(walkFrom, range.to);
    const plan = planEstimates(usage, range, rules, this.options.pricingVersion);

    const env = this.options.environment;
    let rowsDeleted = 0;
    await this.db.transaction(async (tx) => {
      const deleted = await tx.execute(sql`
        delete from provider_cost_daily
        where environment = ${env}
          and source = ${ESTIMATOR_SOURCE}
          and basis = 'ESTIMATED'
          and day >= ${range.from}::date
          and day <= ${range.to}::date
      `);
      rowsDeleted = Number((deleted as { rowCount?: number }).rowCount ?? 0);
      if (plan.rows.length === 0) return;
      const values = plan.rows.map(
        (r) =>
          sql`(${r.day}::date, ${env}, ${r.providerId}, ${r.serviceId}, ${r.operationId}, ${r.usageMetricId}, ${r.billingSkuId}, ${r.billableQuantity}, ${r.billableUnit}, ${r.amountMicros}, ${r.currency}, 'ESTIMATED', 'MEDIUM', ${ESTIMATOR_SOURCE}, ${r.pricingVersion}, now(), ${JSON.stringify({ ...r.metadata, usageSource: r.usageSource })}::jsonb)`,
      );
      await tx.execute(sql`
        insert into provider_cost_daily
          (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
           billable_quantity, billable_unit, amount_micros, currency, basis, confidence, source,
           pricing_version, collected_at, metadata)
        values ${sql.join(values, sql`, `)}
      `);
    });
    return {
      from: range.from,
      to: range.to,
      rowsWritten: plan.rows.length,
      rowsDeleted,
      unpriced: plan.unpriced,
    };
  }

  private async usageRows(from: string, to: string): Promise<MeterUsageRow[]> {
    const result = await this.db.execute(sql`
      select
        to_char(day, 'YYYY-MM-DD') as day,
        provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
        quantity, unit, source
      from provider_usage_meter_daily
      where environment = ${this.options.environment}
        and billing_sku_id is not null
        and day >= ${from}::date
        and day <= ${to}::date
      order by day asc, billing_sku_id asc, source asc
    `);
    return (
      result.rows as unknown as {
        day: string;
        provider_id: string;
        service_id: string;
        operation_id: string | null;
        usage_metric_id: string;
        billing_sku_id: string;
        quantity: number | string;
        unit: string;
        source: string;
      }[]
    ).map((r) => ({
      day: r.day,
      providerId: r.provider_id,
      serviceId: r.service_id,
      operationId: r.operation_id,
      usageMetricId: r.usage_metric_id,
      billingSkuId: r.billing_sku_id,
      quantity: Number(r.quantity),
      unit: r.unit,
      source: r.source,
    }));
  }
}

/** The range a periodic tick recomputes: this month and the previous one, UTC. */
export function defaultRecomputeRange(now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { from: prev.toISOString().slice(0, 10), to };
}
