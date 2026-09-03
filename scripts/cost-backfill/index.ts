// Static, not `await import()` — see scripts/cost-baseline/index.ts for why.
import { closeDb, createDb } from '../../libs/database/src/client';
import { PrometheusQueryAdapter } from '../../libs/providers/src/prometheus-query.adapter';
import { PrometheusBackfillService } from '../../libs/cost-observability/application/prometheus-backfill.service';
import { ReconciliationService } from '../../libs/cost-observability/application/reconciliation.service';
// #388 — the package declares what it needs written; the composer supplies the
// writer. A CLI has no request context, so the row carries no request id or IP,
// exactly as it did before the port existed.
import { writeAudit } from '../../libs/modules/shared/audit';

/**
 * COST-BE-021 (#380) — the operator's door to backfill and reconciliation.
 *
 *   pnpm cost:backfill --env dev --from 2026-09-01 --to 2026-09-02
 *   pnpm cost:backfill --env dev --reconcile 2026-09 [--mark]
 *
 * Backfill reads Prometheus `increase()` per UTC day and writes
 * `provider_usage_meter_daily` rows under `source = prometheus_backfill`,
 * confidence LOW — explicit, bounded to 62 days, idempotent,
 * audited. Reconcile prints estimated vs actual per service for a month;
 * `--mark` stamps `reconciled_at` on matched pairs (never changes an amount).
 *
 * Environment: DATABASE_URL, GRAFANA_PROM_URL, GRAFANA_PROM_USER,
 * GRAFANA_READ_TOKEN (the same read-only credential the API uses).
 */

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const USAGE = `pnpm cost:backfill --env <dev|staging|prod> --from YYYY-MM-DD --to YYYY-MM-DD
pnpm cost:backfill --env <env> --reconcile YYYY-MM [--mark]

Environment: DATABASE_URL, GRAFANA_PROM_URL, GRAFANA_PROM_USER, GRAFANA_READ_TOKEN`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = typeof args.env === 'string' ? args.env : process.env.APP_ENV;
  if (!env) throw new Error(`--env is required\n${USAGE}`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const { db, pool } = createDb(databaseUrl);
  try {
    if (typeof args.reconcile === 'string') {
      if (!MONTH.test(args.reconcile)) throw new Error(`--reconcile expects YYYY-MM\n${USAGE}`);
      const svc = new ReconciliationService(db, { environment: env });
      const lines = await svc.compute(args.reconcile);
      for (const l of lines) {
        const est = (l.estimatedMicros / 1_000_000).toFixed(4);
        const act = l.actualMicros === null ? '—' : (l.actualMicros / 1_000_000).toFixed(4);
        const v = l.varianceMicros === null ? '—' : (l.varianceMicros / 1_000_000).toFixed(4);
        const pct = l.variancePct === null ? '—' : `${(l.variancePct * 100).toFixed(2)}%`;
        console.log(
          `${l.serviceId.padEnd(28)} est ${est.padStart(10)}  actual ${act.padStart(10)}  variance ${v.padStart(10)}  ${pct.padStart(8)}  matched ${l.matchedKeys}`,
        );
      }
      if (lines.length === 0) console.log('(no ESTIMATED/ACTUAL rows in that month)');
      if (args.mark === true) {
        const n = await svc.markReconciled(args.reconcile);
        console.log(`reconciled_at stamped on ${n} rows`);
      }
      return;
    }

    const from = typeof args.from === 'string' ? args.from : '';
    const to = typeof args.to === 'string' ? args.to : from;
    if (!DAY.test(from) || !DAY.test(to))
      throw new Error(`--from/--to expect YYYY-MM-DD\n${USAGE}`);
    const url = process.env.GRAFANA_PROM_URL;
    const username = process.env.GRAFANA_PROM_USER;
    const token = process.env.GRAFANA_READ_TOKEN;
    if (!url || !username || !token) {
      throw new Error(
        'GRAFANA_PROM_URL, GRAFANA_PROM_USER and GRAFANA_READ_TOKEN are required for a backfill',
      );
    }
    const metrics = new PrometheusQueryAdapter({ url, username, token });
    const result = await new PrometheusBackfillService(db, metrics, writeAudit).run({
      environment: env,
      from,
      to,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb(pool);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
