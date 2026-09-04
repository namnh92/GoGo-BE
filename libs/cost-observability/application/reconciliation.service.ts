import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { CostRow } from '../domain/budget';

/**
 * COST-BE-021 (#380) — epic §26, the reconciliation engine.
 *
 *     variance    = actual − estimated
 *     variancePct = (actual − estimated) / actual      when actual ≠ 0
 *
 * Per provider and service, per period. Where there is no ACTUAL row the
 * variance is `null` — the epic's "do not invent reconciliation values" is
 * the whole design. This computes; it does not decide, and it does not add
 * an estimate to an actual (that is `spend()`'s rule, epic §12).
 *
 * `markReconciled` stamps `reconciled_at` on the ESTIMATED and ACTUAL rows
 * that share a day and meter key, so a report can say which estimates have
 * been checked against a bill and which are still only estimates.
 */

export type ReconciliationLine = {
  providerId: string;
  serviceId: string;
  estimatedMicros: number;
  actualMicros: number | null;
  varianceMicros: number | null;
  /** Fraction, 4 decimals: 0.0134 = 1.34 %. `null` when no actual, or actual is 0. */
  variancePct: number | null;
  currency: string | null;
  /** How many (day, meter) pairs had both an estimate and an actual. */
  matchedKeys: number;
};

const keyOf = (r: CostRow) =>
  `${r.day}|${r.providerId}|${r.serviceId}|${r.operationId ?? ''}|${r.usageMetricId ?? ''}|${r.billingSkuId ?? ''}`;

const CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
const best = (rows: CostRow[]): CostRow =>
  [...rows].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      a.source.localeCompare(b.source),
  )[0]!;

/** Pure: cost rows for a period → one line per (provider, service). */
export function reconcile(rows: readonly CostRow[]): ReconciliationLine[] {
  const byService = new Map<string, CostRow[]>();
  for (const r of rows) {
    if (r.basis !== 'ESTIMATED' && r.basis !== 'ACTUAL') continue;
    const k = `${r.providerId}|${r.serviceId}`;
    const g = byService.get(k);
    if (g) g.push(r);
    else byService.set(k, [r]);
  }
  const out: ReconciliationLine[] = [];
  for (const [k, group] of byService) {
    const [providerId, serviceId] = k.split('|') as [string, string];
    const byKey = new Map<string, CostRow[]>();
    for (const r of group) {
      const kk = keyOf(r);
      const g = byKey.get(kk);
      if (g) g.push(r);
      else byKey.set(kk, [r]);
    }
    let estimated = 0;
    let actual = 0;
    let hasActual = false;
    let matched = 0;
    const currencies = new Set<string>();
    for (const g of byKey.values()) {
      const est = g.filter((r) => r.basis === 'ESTIMATED');
      const act = g.filter((r) => r.basis === 'ACTUAL');
      if (est.length > 0) estimated += best(est).amountMicros;
      if (act.length > 0) {
        hasActual = true;
        actual += best(act).amountMicros;
      }
      if (est.length > 0 && act.length > 0) matched += 1;
      for (const r of g) currencies.add(r.currency);
    }
    const variance = hasActual ? actual - estimated : null;
    out.push({
      providerId,
      serviceId,
      estimatedMicros: estimated,
      actualMicros: hasActual ? actual : null,
      varianceMicros: variance,
      variancePct:
        variance === null || actual === 0
          ? null
          : Math.round((variance / actual) * 10_000) / 10_000,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      matchedKeys: matched,
    });
  }
  return out.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}

export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly options: { environment: string },
  ) {}

  /** `month` = `YYYY-MM` (UTC). */
  async compute(month: string): Promise<ReconciliationLine[]> {
    return reconcile(await this.rows(month));
  }

  /**
   * Stamp `reconciled_at` on every ESTIMATED/ACTUAL pair sharing a day and
   * meter key in `month`. Idempotent; never changes an amount.
   */
  async markReconciled(month: string, now: Date = new Date()): Promise<number> {
    const from = `${month}-01`;
    const env = this.options.environment;
    const result = await this.db.execute(sql`
      update provider_cost_daily c
      set reconciled_at = ${now.toISOString()}, updated_at = now()
      where c.environment = ${env}
        and c.day >= ${from}::date and c.day < (${from}::date + interval '1 month')
        and c.basis in ('ESTIMATED', 'ACTUAL')
        and c.reconciled_at is null
        and exists (
          select 1 from provider_cost_daily o
          where o.environment = c.environment and o.day = c.day
            and o.provider_id = c.provider_id and o.service_id = c.service_id
            and coalesce(o.operation_id, '') = coalesce(c.operation_id, '')
            and coalesce(o.usage_metric_id, '') = coalesce(c.usage_metric_id, '')
            and coalesce(o.billing_sku_id, '') = coalesce(c.billing_sku_id, '')
            and o.basis = case when c.basis = 'ESTIMATED' then 'ACTUAL' else 'ESTIMATED' end
        )
    `);
    return Number((result as { rowCount?: number }).rowCount ?? 0);
  }

  private async rows(month: string): Promise<CostRow[]> {
    const from = `${month}-01`;
    const { rows } = await this.db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, provider_id, service_id, operation_id, usage_metric_id,
             billing_sku_id, amount_micros, currency, basis, confidence, source
      from provider_cost_daily
      where environment = ${this.options.environment}
        and day >= ${from}::date and day < (${from}::date + interval '1 month')
        and basis in ('ESTIMATED', 'ACTUAL')
    `);
    return (
      rows as unknown as {
        day: string;
        provider_id: string;
        service_id: string;
        operation_id: string | null;
        usage_metric_id: string | null;
        billing_sku_id: string | null;
        amount_micros: number | string;
        currency: string;
        basis: CostRow['basis'];
        confidence: CostRow['confidence'];
        source: string;
      }[]
    ).map((r) => ({
      day: r.day,
      providerId: r.provider_id,
      serviceId: r.service_id,
      operationId: r.operation_id,
      usageMetricId: r.usage_metric_id,
      billingSkuId: r.billing_sku_id,
      amountMicros: Number(r.amount_micros),
      currency: r.currency.trim(),
      basis: r.basis,
      confidence: r.confidence,
      source: r.source,
    }));
  }
}
