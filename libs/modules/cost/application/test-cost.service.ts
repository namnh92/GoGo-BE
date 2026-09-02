import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import {
  PRICING_RULES,
  estimateMicros,
  ruleInForce,
  type PricingRule,
} from '../domain/pricing-rules';
import { utcDay } from '../domain/provider-pricing';

/**
 * COST-BE-019 (#378) — epic §28 (test-run cost model), §29 (test cost
 * budgets), §30 (test provider scoping), §43, §44.17.
 *
 *     start → snapshot → [the test runs] → finish → snapshot → deltas
 *
 * A snapshot is the sum of `provider_usage_meter_daily.quantity` per meter
 * key for the environment — every day, every source. Sums are monotonic while
 * a test runs (the ledger only adds), so the delta is exact whatever the
 * clock does at midnight, and a provider registered after this file was
 * written shows up in the delta with no change here: the keys are the
 * table's, not a list in code.
 *
 * Money on a delta is list price under the rule in force on the day the run
 * finished — not free-cap-adjusted, because a test should not read cheaper in
 * the first week of the month. Unknown price ⇒ `estimatedCostDelta: null`,
 * basis `UNKNOWN`. Actual stays `null` until an ACTUAL source exists.
 *
 * Budgets (§29) are optional and soft: an overrun sets `status =
 * 'over_budget'` and is reported; nothing here throws, and a CI gate on it is
 * the caller's decision once baselines are stable. Manual/fixed costs never
 * enter a delta (§27): they are not usage.
 */

export type MeterKey = {
  providerId: string;
  serviceId: string;
  operationId: string | null;
  usageMetricId: string;
  billingSkuId: string | null;
  unit: string;
};

export type MeterSnapshot = MeterKey & { quantity: number };

export type TestBudget = {
  /**
   * Sum of attempted provider calls: request-unit meters that carry no SKU
   * (`calls`). Billed `requests` are the same calls seen from the invoice and
   * must not be counted twice.
   */
  maxProviderCalls?: number;
  /** Per meter, keyed `<serviceId>/<metric>` — e.g. `upstash.redis/commands`. */
  maxProviderUsage?: Record<string, number>;
  /** Sum of known estimated deltas, micros. Unknown prices do not count. */
  maxEstimatedCostMicros?: number;
};

export type StartOptions = {
  environment: string;
  gitSha?: string | null;
  /** §30 — registry service ids the run declares relevant; `null` = all. */
  services?: readonly string[] | null;
  budget?: TestBudget | null;
  notes?: string | null;
};

export type TestRunDelta = MeterKey & {
  usageBefore: number;
  usageAfter: number;
  usageDelta: number;
  estimatedCostDelta: number | null;
  actualCostDelta: number | null;
  currency: string;
  basis: 'ESTIMATED' | 'UNKNOWN';
  confidence: 'MEDIUM' | 'LOW';
};

export type TestRunResult = {
  id: string;
  status: 'ok' | 'over_budget';
  deltas: TestRunDelta[];
  /** Sum of known estimated deltas; `null` when nothing was priceable. */
  estimatedCostMicros: number | null;
  /** Meters whose price is unknown — the reason a total may be a floor. */
  unpriced: string[];
  budgetViolations: string[];
};

const keyOf = (k: MeterKey) =>
  `${k.providerId}|${k.serviceId}|${k.operationId ?? ''}|${k.usageMetricId}|${k.billingSkuId ?? ''}`;

/** Pure: two snapshots → deltas priced at list on `day`. */
export function diffSnapshots(
  before: readonly MeterSnapshot[],
  after: readonly MeterSnapshot[],
  day: string,
  rules: readonly PricingRule[] = PRICING_RULES,
  services: readonly string[] | null = null,
): TestRunDelta[] {
  const prior = new Map(before.map((s) => [keyOf(s), s.quantity]));
  const seen = new Set<string>();
  const out: TestRunDelta[] = [];
  const consider = (s: MeterSnapshot, afterQty: number) => {
    if (services !== null && !services.includes(s.serviceId)) return;
    const k = keyOf(s);
    if (seen.has(k)) return;
    seen.add(k);
    const beforeQty = prior.get(k) ?? 0;
    const delta = afterQty - beforeQty;
    if (delta === 0) return;
    const rule =
      s.billingSkuId === null ? null : ruleInForce(rules, { billingSkuId: s.billingSkuId }, day);
    const estimate = rule === null ? null : estimateMicros(rule, Math.max(0, delta));
    const known = estimate !== null && estimate.known;
    out.push({
      providerId: s.providerId,
      serviceId: s.serviceId,
      operationId: s.operationId,
      usageMetricId: s.usageMetricId,
      billingSkuId: s.billingSkuId,
      unit: s.unit,
      usageBefore: beforeQty,
      usageAfter: afterQty,
      usageDelta: delta,
      estimatedCostDelta: known ? estimate.listMicros : null,
      actualCostDelta: null,
      currency: rule?.currency ?? 'USD',
      basis: known ? 'ESTIMATED' : 'UNKNOWN',
      // A billed meter with a known price is a list-price estimate; an
      // unbilled meter (calls) or an unknown price says less.
      confidence: known ? 'MEDIUM' : 'LOW',
    });
  };
  for (const s of after) consider(s, s.quantity);
  // A meter present before and absent after cannot happen (sums only grow),
  // but a snapshot taken before the row existed is the common case: covered
  // by `prior.get(k) ?? 0` above.
  return out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** Pure: §29 budget check over deltas. */
export function checkBudget(
  deltas: readonly TestRunDelta[],
  budget: TestBudget | null | undefined,
): string[] {
  if (!budget) return [];
  const violations: string[] = [];
  if (budget.maxProviderCalls !== undefined) {
    const calls = deltas
      .filter((d) => d.unit === 'request' && d.billingSkuId === null)
      .reduce((n, d) => n + d.usageDelta, 0);
    if (calls > budget.maxProviderCalls)
      violations.push(`provider calls ${calls} > ${budget.maxProviderCalls}`);
  }
  if (budget.maxProviderUsage) {
    for (const [meter, max] of Object.entries(budget.maxProviderUsage)) {
      const used = deltas
        .filter((d) => `${d.serviceId}/${d.usageMetricId}` === meter)
        .reduce((n, d) => n + d.usageDelta, 0);
      if (used > max) violations.push(`${meter} ${used} > ${max}`);
    }
  }
  if (budget.maxEstimatedCostMicros !== undefined) {
    const known = deltas.reduce((n, d) => n + (d.estimatedCostDelta ?? 0), 0);
    if (known > budget.maxEstimatedCostMicros) {
      violations.push(`estimated cost ${known} micros > ${budget.maxEstimatedCostMicros}`);
    }
  }
  return violations;
}

export class TestCostService {
  constructor(
    private readonly db: Db,
    private readonly options: { rules?: readonly PricingRule[]; now?: () => Date } = {},
  ) {}

  /** Snapshot now and open a run. Returns the run id. */
  async start(name: string, opts: StartOptions): Promise<string> {
    const now = (this.options.now ?? (() => new Date()))();
    const before = await this.snapshot(opts.environment);
    const { rows } = await this.db.execute(sql`
      insert into cost_test_runs
        (name, environment, started_at, baseline_snapshot_at, git_sha, status, services, budget, notes)
      values (${name}, ${opts.environment}, ${now.toISOString()}, ${now.toISOString()}, ${opts.gitSha ?? null},
              'running', ${opts.services ? JSON.stringify(opts.services) : null}::jsonb,
              ${opts.budget ? JSON.stringify(opts.budget) : null}::jsonb, ${opts.notes ?? null})
      returning id
    `);
    const id = (rows[0] as { id: string }).id;
    // The before-snapshot is kept in the row's notes-free companion: stored as
    // deltas with usage_after = usage_before until finish rewrites them, so a
    // crashed run still shows what it started from.
    await this.writeDeltas(
      id,
      before.map((s) => ({
        ...s,
        usageBefore: s.quantity,
        usageAfter: s.quantity,
        usageDelta: 0,
        estimatedCostDelta: null,
        actualCostDelta: null,
        currency: 'USD',
        basis: 'UNKNOWN' as const,
        confidence: 'LOW' as const,
      })),
    );
    return id;
  }

  /** Snapshot again, compute deltas, price them, check the budget, close the run. */
  async finish(id: string): Promise<TestRunResult> {
    const now = (this.options.now ?? (() => new Date()))();
    const run = await this.run(id);
    if (run === null) throw new Error(`cost test run ${id} not found`);
    const before = await this.storedBefore(id);
    const after = await this.snapshot(run.environment);
    const deltas = diffSnapshots(
      before,
      after,
      utcDay(now),
      this.options.rules ?? PRICING_RULES,
      run.services,
    );
    const violations = checkBudget(deltas, run.budget);
    const status: TestRunResult['status'] = violations.length > 0 ? 'over_budget' : 'ok';
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`delete from cost_test_run_deltas where test_run_id = ${id}`);
      await tx.execute(sql`
        update cost_test_runs
        set ended_at = ${now.toISOString()}, final_snapshot_at = ${now.toISOString()}, status = ${status},
            updated_at = now()
        where id = ${id}
      `);
      await this.writeDeltas(id, deltas, tx);
    });
    const priced = deltas.filter((d) => d.estimatedCostDelta !== null);
    return {
      id,
      status,
      deltas,
      estimatedCostMicros:
        priced.length === 0 ? null : priced.reduce((n, d) => n + (d.estimatedCostDelta ?? 0), 0),
      unpriced: deltas
        .filter((d) => d.billingSkuId !== null && d.estimatedCostDelta === null)
        .map((d) => `${d.serviceId}/${d.usageMetricId}`),
      budgetViolations: violations,
    };
  }

  /** Mark a run that did not reach `finish` (the caller's test threw). */
  async fail(id: string, notes?: string): Promise<void> {
    await this.db.execute(sql`
      update cost_test_runs
      set status = 'failed', ended_at = now(), notes = coalesce(${notes ?? null}, notes), updated_at = now()
      where id = ${id}
    `);
  }

  async snapshot(environment: string): Promise<MeterSnapshot[]> {
    const { rows } = await this.db.execute(sql`
      select provider_id, service_id, operation_id, usage_metric_id, billing_sku_id, unit,
             sum(quantity)::bigint as quantity
      from provider_usage_meter_daily
      where environment = ${environment}
      group by provider_id, service_id, operation_id, usage_metric_id, billing_sku_id, unit
      order by provider_id, service_id, operation_id, usage_metric_id
    `);
    return (
      rows as unknown as {
        provider_id: string;
        service_id: string;
        operation_id: string | null;
        usage_metric_id: string;
        billing_sku_id: string | null;
        unit: string;
        quantity: number | string;
      }[]
    ).map((r) => ({
      providerId: r.provider_id,
      serviceId: r.service_id,
      operationId: r.operation_id,
      usageMetricId: r.usage_metric_id,
      billingSkuId: r.billing_sku_id,
      unit: r.unit,
      quantity: Number(r.quantity),
    }));
  }

  private async run(
    id: string,
  ): Promise<{ environment: string; services: string[] | null; budget: TestBudget | null } | null> {
    const { rows } = await this.db.execute(sql`
      select environment, services, budget from cost_test_runs where id = ${id}
    `);
    const row = rows[0] as
      { environment: string; services: string[] | null; budget: TestBudget | null } | undefined;
    return row ?? null;
  }

  private async storedBefore(id: string): Promise<MeterSnapshot[]> {
    const { rows } = await this.db.execute(sql`
      select provider_id, service_id, operation_id, usage_metric_id, billing_sku_id, unit, usage_before
      from cost_test_run_deltas where test_run_id = ${id}
    `);
    return (
      rows as unknown as {
        provider_id: string;
        service_id: string;
        operation_id: string | null;
        usage_metric_id: string;
        billing_sku_id: string | null;
        unit: string;
        usage_before: number | string;
      }[]
    ).map((r) => ({
      providerId: r.provider_id,
      serviceId: r.service_id,
      operationId: r.operation_id,
      usageMetricId: r.usage_metric_id,
      billingSkuId: r.billing_sku_id,
      unit: r.unit,
      quantity: Number(r.usage_before),
    }));
  }

  private async writeDeltas(
    id: string,
    deltas: readonly TestRunDelta[],
    exec: Pick<Db, 'execute'> = this.db,
  ): Promise<void> {
    if (deltas.length === 0) return;
    const values = deltas.map(
      (d) =>
        sql`(${id}, ${d.providerId}, ${d.serviceId}, ${d.operationId}, ${d.usageMetricId}, ${d.billingSkuId}, ${d.unit}, ${d.usageBefore}, ${d.usageAfter}, ${d.usageDelta}, ${d.estimatedCostDelta}, ${d.actualCostDelta}, ${d.currency}, ${d.basis}, ${d.confidence})`,
    );
    await exec.execute(sql`
      insert into cost_test_run_deltas
        (test_run_id, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id, unit,
         usage_before, usage_after, usage_delta, estimated_cost_delta, actual_cost_delta, currency, basis, confidence)
      values ${sql.join(values, sql`, `)}
    `);
  }
}
