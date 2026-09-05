import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { CostSample, UsageSample } from '../ports/collectors.port';

/**
 * COST-BE-029 (#388) — the write path every collector shares.
 *
 * These three lived in `cloudflare.collector.ts` and `aws.collector.ts`
 * because that is where the first collector to need them was written. Once the
 * package split providers into `providers/<provider>/`, that placement said
 * something false: Neon, Upstash and GitHub were importing *from Cloudflare*,
 * and GitHub from AWS, for code that has nothing to do with either vendor.
 *
 * Same functions, same SQL, same semantics — moved to where they belong so a
 * provider folder contains only that provider.
 */

/** UTC day before `day`. */
export function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Replace-semantics upsert on the canonical meter table. The conflict target
 * is the table's unique key; `quantity` is set, not added (see the header).
 */
export async function upsertUsageSamples(db: Db, samples: readonly UsageSample[]): Promise<number> {
  if (samples.length === 0) return 0;
  const values = samples.map(
    (s) =>
      sql`(${s.day}::date, ${s.environment}, ${s.providerId}, ${s.serviceId}, ${s.operationId}, ${s.usageMetricId}, ${s.billingSkuId}, ${s.quantity}, ${s.unit}, ${s.source}, ${s.confidence}, ${s.sourceAsOf?.toISOString() ?? null}, now(), ${JSON.stringify(s.metadata ?? {})}::jsonb, now())`,
  );
  await db.execute(sql`
    insert into provider_usage_meter_daily
      (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
       quantity, unit, source, confidence, source_as_of, collected_at, metadata, updated_at)
    values ${sql.join(values, sql`, `)}
    on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                 usage_metric_id, coalesce(billing_sku_id, ''), source)
    do update set
      quantity     = excluded.quantity,
      unit         = excluded.unit,
      confidence   = excluded.confidence,
      source_as_of = excluded.source_as_of,
      metadata     = excluded.metadata,
      collected_at = now(),
      updated_at   = now()
  `);
  return samples.length;
}

/**
 * Replace-upsert of ACTUAL/FIXED/MANUAL cost rows, on the same key the
 * estimator and the manual-cost service use. Replace, not add: the provider
 * reports the day's total and a re-read of the same day must not double it.
 */
export async function upsertCostSamples(db: Db, samples: readonly CostSample[]): Promise<number> {
  if (samples.length === 0) return 0;
  const values = samples.map(
    (s) =>
      sql`(${s.day}::date, ${s.environment}, ${s.providerId}, ${s.serviceId}, ${s.operationId}, ${s.usageMetricId}, ${s.billingSkuId}, ${s.billableQuantity}, ${s.billableUnit}, ${s.amountMicros}, ${s.currency}, ${s.basis}, ${s.confidence}, ${s.source}, ${s.costKind}, ${s.costKind === 'RECURRING' ? (s.billingCadence ?? 'MONTHLY') : null}, ${s.costKind === 'RECURRING' ? (s.periodAmountMicros ?? s.amountMicros) : null}, ${s.sourceAsOf?.toISOString() ?? null}, now(), ${JSON.stringify(s.metadata ?? {})}::jsonb, now())`,
  );
  await db.execute(sql`
    insert into provider_cost_daily
      (day, environment, provider_id, service_id, operation_id, usage_metric_id, billing_sku_id,
       billable_quantity, billable_unit, amount_micros, currency, basis, confidence, source,
       cost_kind, billing_cadence, period_amount_micros, source_as_of, collected_at, metadata, updated_at)
    values ${sql.join(values, sql`, `)}
    on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                 coalesce(usage_metric_id, ''), coalesce(billing_sku_id, ''), source, basis)
    do update set
      billable_quantity = excluded.billable_quantity,
      billable_unit     = excluded.billable_unit,
      amount_micros     = excluded.amount_micros,
      currency          = excluded.currency,
      confidence        = excluded.confidence,
      cost_kind         = excluded.cost_kind,
      billing_cadence   = excluded.billing_cadence,
      period_amount_micros = excluded.period_amount_micros,
      source_as_of      = excluded.source_as_of,
      metadata          = excluded.metadata,
      collected_at      = now(),
      updated_at        = now()
  `);
  return samples.length;
}
