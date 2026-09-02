import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { MetricsQueryPort } from '@gogo/providers';
import { writeAudit } from '../../shared/audit';
import { operationForSku } from '../domain/provider-pricing';
import { meterRowsFor } from './usage-ledger';

/**
 * COST-BE-021 (#380) — epic §25 (backfill) and §10 (accounting-safe usage).
 *
 * The one thing Prometheus is good for in accounting: recovering usage the
 * ledger never saw. The known case is DEV 2026-09-01/02 — ten Routes calls
 * made by an image that predated the ledger, visible only as
 * `places_provider_requests_total` in Grafana (ADR-0012 caveat).
 *
 * What comes out is labelled for what it is: `source = 'prometheus_backfill'`,
 * `confidence = 'LOW'`, quantities **floored to integers** — `increase()`
 * extrapolates, and 12.204 requests is not a count. It lands in
 * `provider_usage_meter_daily` under its own source, so the ledger's rows are
 * untouched and the estimator prices the two views separately (and `spend()`
 * never adds them). Nothing here reads or writes a cost row, and ACTUAL is
 * out of reach by construction.
 *
 * Explicit, bounded (≤ 62 days per call), idempotent (a re-run replaces the
 * same rows), and audited.
 */

export const BACKFILL_SOURCE = 'prometheus_backfill';
export const BACKFILL_MAX_DAYS = 62;

export type BackfillRange = { environment: string; from: string; to: string };

export type BackfillDay = {
  day: string;
  /** operation → counts read from Prometheus for that UTC day. */
  operations: Record<string, { attempted: number; succeeded: number; units: number }>;
};

export type BackfillResult = {
  environment: string;
  from: string;
  to: string;
  days: number;
  rowsWritten: number;
  /** Days on which Prometheus returned nothing at all — not written, listed. */
  emptyDays: string[];
};

const DAY_MS = 86_400_000;

function* days(from: string, to: string): Generator<string> {
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end) {
    yield new Date(t).toISOString().slice(0, 10);
    t += DAY_MS;
  }
}

/** The last point of a series, floored. `increase()` at the day's end is the day's count. */
function lastFloor(points: { t: number; v: number }[]): number {
  const last = points.at(-1);
  if (!last || !Number.isFinite(last.v)) return 0;
  return Math.max(0, Math.floor(last.v));
}

/**
 * Pure per-day reduction: series → operation counts. Exported so the shape
 * of what Prometheus hands back can be pinned without a store.
 */
export function reduceDay(
  day: string,
  requests: readonly { labels: Record<string, string>; points: { t: number; v: number }[] }[],
  costUnits: readonly { labels: Record<string, string>; points: { t: number; v: number }[] }[],
): BackfillDay {
  const operations: BackfillDay['operations'] = {};
  const slot = (op: string) => (operations[op] ??= { attempted: 0, succeeded: 0, units: 0 });
  for (const s of requests) {
    const method = s.labels['method'];
    if (!method) continue;
    const n = lastFloor(s.points);
    if (n === 0) continue;
    const c = slot(method);
    c.attempted += n;
    if ((s.labels['status'] ?? '').startsWith('2')) c.succeeded += n;
  }
  for (const s of costUnits) {
    const sku = s.labels['sku'];
    if (!sku) continue;
    const n = lastFloor(s.points);
    if (n === 0) continue;
    slot(operationForSku(sku)).units += n;
  }
  return { day, operations };
}

export class PrometheusBackfillService {
  constructor(
    private readonly db: Db,
    private readonly metrics: MetricsQueryPort,
  ) {}

  async run(
    range: BackfillRange,
    actor: { adminId: string | null } = { adminId: null },
  ): Promise<BackfillResult> {
    if (range.from > range.to)
      throw new Error(`backfill: from ${range.from} is after to ${range.to}`);
    const dayList = [...days(range.from, range.to)];
    if (dayList.length > BACKFILL_MAX_DAYS) {
      throw new Error(
        `backfill: ${dayList.length} days exceeds the ${BACKFILL_MAX_DAYS}-day bound`,
      );
    }
    const env = range.environment;
    let rowsWritten = 0;
    const emptyDays: string[] = [];
    const touched = new Set<string>();

    for (const day of dayList) {
      const start = new Date(`${day}T00:00:00Z`);
      const end = new Date(start.getTime() + DAY_MS);
      const [requests, costUnits] = await Promise.all([
        this.metrics.queryRange(
          `sum by (method, status) (increase(places_provider_requests_total{env="${env}"}[1d]))`,
          start,
          end,
          86_400,
        ),
        this.metrics.queryRange(
          `sum by (sku) (increase(places_provider_cost_units{env="${env}"}[1d]))`,
          start,
          end,
          86_400,
        ),
      ]);
      const reduced = reduceDay(day, requests, costUnits);
      const rows = Object.entries(reduced.operations).flatMap(([operation, counts]) =>
        meterRowsFor(day, env, operation, counts),
      );
      if (rows.length === 0) {
        emptyDays.push(day);
        continue;
      }
      for (const r of rows) touched.add(r.operationId);
      const values = rows.map(
        (r) =>
          sql`(${r.day}::date, ${r.environment}, ${r.providerId}, ${r.serviceId}, ${r.operationId}, ${r.metric}, ${r.billingSkuId}, ${r.quantity}, ${r.unit}, ${BACKFILL_SOURCE}, 'LOW', now(), now())`,
      );
      // Replace, not accumulate: a backfill is a re-derivation of the day.
      await this.db.execute(sql`
        insert into provider_usage_meter_daily
          (day, environment, provider_id, service_id, operation_id, usage_metric_id,
           billing_sku_id, quantity, unit, source, confidence, collected_at, updated_at)
        values ${sql.join(values, sql`, `)}
        on conflict (day, environment, provider_id, service_id, coalesce(operation_id, ''),
                     usage_metric_id, coalesce(billing_sku_id, ''), source)
        do update set quantity = excluded.quantity, collected_at = now(), updated_at = now()
      `);
      rowsWritten += rows.length;
    }

    await writeAudit(this.db, {
      actorType: actor.adminId ? 'admin' : 'system',
      actorId: actor.adminId,
      action: 'cost.backfill',
      resourceType: 'cost_backfill',
      resourceId: `${env}:${range.from}..${range.to}`,
      diff: {
        days: dayList.length,
        rowsWritten,
        emptyDays,
        operations: [...touched].sort(),
        source: BACKFILL_SOURCE,
      },
    });
    return {
      environment: env,
      from: range.from,
      to: range.to,
      days: dayList.length,
      rowsWritten,
      emptyDays,
    };
  }
}
