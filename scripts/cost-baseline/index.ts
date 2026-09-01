/**
 * PR3 / COST-BE-003 (#336) — `pnpm cost:baseline`.
 *
 * Two jobs, and they are deliberately the same command:
 *
 *   pnpm cost:baseline --name before-dev            # measure and freeze
 *   pnpm cost:baseline --compare a.json b.json      # do two runs agree?
 *
 * The second is the plan's acceptance criterion ("two consecutive runs must
 * agree within ±1 call per operation"), so it lives where the person who just
 * produced a run will find it, not in a separate tool they have to be told
 * about.
 *
 * **This command drives a running API against real Google.** The deterministic
 * BEFORE — real adapters, real masks, real ledger, pinned transport — is
 * produced by `apps/api/test/cost-baseline.int.spec.ts`, because that is where
 * the Postgres and the app boot already live, and duplicating them in a CLI
 * would give the program two harnesses that could drift. The committed
 * artifact under `docs/cost-baselines/` comes from there.
 *
 * A live run needs its own fixture set. The committed fixtures are synthetic
 * ids that only the stub answers; against real Google an operator points
 * `--fixtures` at a directory of real Place IDs. Place IDs may be stored
 * (plan §7); names, addresses, ratings and hours may not, so a live fixture
 * file carries ids and URLs and nothing else.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Static, not `await import()`. A dynamic import resolves as ESM under
// `moduleResolution: nodenext` and would need a `.js` specifier, which
// `@swc-node/register` cannot load from a `.ts` file at runtime. These two
// modules pull `pg` and `drizzle-orm`, which `scripts/` cannot resolve on its
// own — but they can, relative to themselves.
import { closeDb, createDb } from '../../libs/database/src/client';
import { PrometheusQueryAdapter } from '../../libs/providers/src/prometheus-query.adapter';
import { compareBaselines, formatComparison } from './compare';
import type { BaselineArtifact } from './artifact';
import { fetchTarget } from './http-target';
import type { SqlRunner } from './ledger';
import { loadFixtures } from './scenarios';
import { parseMetricsText } from './metrics-text';
import { runBaseline, type GrafanaProbe } from './runner';
import { utcDay } from '../../libs/modules/cost/domain/provider-pricing';
import { FIXTURES_DIR } from './stub-google';

type Args = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const values: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) values.push(argv[++i]!);
    out[key] = values.length === 0 ? true : values.length === 1 ? values[0]! : values;
  }
  return out;
}

const USAGE = `pnpm cost:baseline --name <run> [--out docs/cost-baselines] [--fixtures <dir>]
pnpm cost:baseline --compare <before.json> <after.json> [--tolerance 1]

Environment for a measuring run:
  DATABASE_URL              the environment's Postgres (the ledger lives here)
  COST_BASELINE_API_URL     base URL of the running API, e.g. https://api.dev…
  COST_BASELINE_USER_TOKEN      access token for a normal user (submissions)
  COST_BASELINE_MODERATOR_TOKEN CMS moderator (submission decisions)
  COST_BASELINE_OPS_TOKEN       CMS ops admin (bulk import + publish)
  COST_BASELINE_TUNNEL_QUIET=true   operator's declaration that no handset is on the tunnel
  METRICS_TOKEN             bearer for the API's /metrics scrape endpoint
  APP_ENV                   which environment's ledger rows to read (default dev)
  GRAFANA_QUERY_URL / GRAFANA_USER / GRAFANA_TOKEN   optional cross-check`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    const files = Array.isArray(args.compare) ? args.compare : [String(args.compare)];
    if (files.length !== 2) throw new Error(USAGE);
    const [a, b] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as BaselineArtifact) as [
      BaselineArtifact,
      BaselineArtifact,
    ];
    const result = compareBaselines(a, b, Number(args.tolerance ?? 1));
    process.stdout.write(`${formatComparison(result)}\n`);
    process.exitCode = result.agrees ? 0 : 1;
    return;
  }

  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new Error(USAGE);

  const apiUrl = required('COST_BASELINE_API_URL');
  const databaseUrl = required('DATABASE_URL');
  const environment = process.env.APP_ENV ?? 'dev';
  const fixturesDir = typeof args.fixtures === 'string' ? args.fixtures : FIXTURES_DIR;

  const { pool } = createDb(databaseUrl);
  const query: SqlRunner = async (text, params) =>
    (await pool.query(text, params as unknown[])).rows as Record<string, unknown>[];
  const http = fetchTarget(apiUrl);

  try {
    const artifact = await runBaseline({
      name,
      transport: 'live',
      environment,
      providerMode: 'google',
      query,
      http,
      actors: {
        user: required('COST_BASELINE_USER_TOKEN'),
        moderator: required('COST_BASELINE_MODERATOR_TOKEN'),
        ops: required('COST_BASELINE_OPS_TOKEN'),
      },
      fixtures: loadFixtures(fixturesDir),
      fixturesDir,
      // The API flushes its own ledger on its own interval; a client cannot
      // reach into it. Waiting out one full interval plus a margin is the only
      // honest option across a network, and it is why the in-process harness —
      // which can await the real `flush()` — is the deterministic path.
      flush: () => sleep(Number(process.env.COST_LEDGER_FLUSH_MS ?? 5000) * 2),
      // Against a deployed environment the worker is a different process on
      // its own poll interval, so "let the worker run" is a wait. The
      // in-process harness calls `processPendingJobs` directly and does not
      // have this caveat.
      advanceWorker: () => sleep(Number(process.env.PLACE_IMPORT_POLL_MS ?? 5000) * 4),
      scrape: () => scrapeMetrics(apiUrl),
      grafana: grafanaProbe(environment),
      ledgerEnabled: process.env.COST_LEDGER_ENABLED !== 'false',
      day: utcDay(),
      limitations: [
        'Ledger flushes were waited out over the network (two flush intervals) rather than awaited, so a count may lag by at most one interval. The in-process harness awaits the real drain and does not have this caveat.',
        'The bulk import was advanced by waiting out the worker poll interval, not by observing the worker. A job still running when the wait expires would leave its remaining provider calls in the next scenario’s window; the ledger-versus-scrape columns are what surface that.',
      ],
    });

    const outDir = typeof args.out === 'string' ? args.out : 'docs/cost-baselines';
    const file = path.join(outDir, `${artifact.createdAt.slice(0, 10)}-${name}.json`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`${file}\n`);
    if (!artifact.preflight.quiet) {
      process.stdout.write(
        'preflight: a required contamination control did not hold — see the artifact\n',
      );
      process.exitCode = 1;
    }
  } finally {
    await closeDb(pool);
  }
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required\n\n${USAGE}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeMetrics(apiUrl: string) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return null;
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/metrics`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return parseMetricsText(await res.text());
}

/**
 * The §4 cross-check. Absent credentials it is `null` everywhere rather than
 * zero — "Grafana says zero calls" and "nobody asked Grafana" are different
 * claims and only one of them is evidence.
 */
function grafanaProbe(environment: string): GrafanaProbe | null {
  const url = process.env.GRAFANA_QUERY_URL;
  const username = process.env.GRAFANA_USER;
  const token = process.env.GRAFANA_TOKEN;
  if (!url || !username || !token) return null;

  const adapter = new PrometheusQueryAdapter({ url, username, token });
  const query = async (promql: string) => {
    try {
      return await adapter.query(promql);
    } catch {
      return null;
    }
  };

  return {
    async callsByOperation(windowSeconds) {
      // The window is the scenario's own elapsed time, rounded up. A fixed
      // window would either miss a long bulk import or sweep in the scenario
      // before it.
      const samples = await query(
        `sum by (method) (increase(places_provider_requests_total{env="${environment}"}[${windowSeconds}s]))`,
      );
      if (samples === null) return null;
      const out = new Map<string, number>();
      for (const s of samples) {
        const method = s.labels?.method;
        if (method) out.set(method, Math.round(s.value));
      }
      return out;
    },
    async recentProviderTraffic() {
      const samples = await query(
        `sum(increase(places_provider_requests_total{env="${environment}"}[10m]))`,
      );
      if (samples === null) return null;
      return Math.round(samples.reduce((total, sample) => total + sample.value, 0));
    },
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
