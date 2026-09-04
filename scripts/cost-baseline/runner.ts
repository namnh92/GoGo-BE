/**
 * PR3 / COST-BE-003 (#336) — run the pinned scenarios and freeze what they cost.
 *
 * The measurement sandwich, per scenario:
 *
 *   flush → snapshot(ledger, /metrics) → run the scenario → flush → snapshot
 *
 * The flushes are not optional and not a sleep. `DbUsageLedger` buffers counts
 * in memory for `COST_LEDGER_FLUSH_MS` before it upserts (ADR-0012), so a
 * snapshot taken without one reads a row the scenario's last calls have not
 * reached, and the baseline quietly under-counts by however much was in
 * flight. Waiting five seconds instead would make the run slower *and* still
 * racy. `flush` is awaited, so the boundary is exact.
 *
 * Per scenario, not per run, because §4's columns are per scenario: ten text
 * searches and a twenty-row bulk import have different latencies, different
 * error surfaces and different operation mixes, and one row of totals would
 * describe neither.
 */

import { execFileSync } from 'node:child_process';
import {
  BASELINE_SCHEMA_VERSION,
  type BaselineArtifact,
  type BaselineTransport,
  type CrossCheckRow,
  type ScenarioReport,
} from './artifact';
import { diffLedger, snapshotLedger, type SqlRunner } from './ledger';
import { diffSnapshots, quantileOf, type MetricsSnapshot } from './metrics-text';
import { preflight } from './preflight';
import { operationRows, providerErrorRate, totalRows } from './report';
import {
  PRICING_CURRENCY,
  PRICING_VERSION,
  staticCostGaps,
} from '../../libs/cost-observability/pricing/provider-pricing';
import { percentile, type HttpTarget } from './http-target';
import { SCENARIOS, type BaselineActors, type Fixtures, type Scenario } from './scenarios';

/** Reads Grafana back, if there is a Grafana to read. */
export type GrafanaProbe = {
  /** `increase(places_provider_requests_total{env,method}[window])`, per method. */
  callsByOperation(windowSeconds: number): Promise<Map<string, number> | null>;
  /** The §4 quiet-window check. `null` when unreachable. */
  recentProviderTraffic(): Promise<number | null>;
};

export type RunnerOptions = {
  /**
   * COST-BE-019 (#378): when a database is available, record the run as a
   * `cost_test_runs` row with per-meter deltas (epic §28). The JSON artifact
   * is unchanged — files stay the frozen evidence, the table is the queryable
   * record. Absent in stub runs without a database.
   */
  testCost?: {
    start(
      name: string,
      opts: { environment: string; gitSha?: string | null; notes?: string | null },
    ): Promise<string>;
    finish(id: string): Promise<unknown>;
    fail(id: string, notes?: string): Promise<void>;
  };
  name: string;
  transport: BaselineTransport;
  environment: string;
  providerMode: 'google' | 'fake';
  /** Parameterised SQL against the environment holding the ledger. */
  query: SqlRunner;
  http: HttpTarget;
  actors: BaselineActors;
  fixtures: Fixtures;
  fixturesDir: string;
  /** Awaited before every snapshot. Never a timer. */
  flush(): Promise<void>;
  /** Let the import worker drain. See `ScenarioContext.advanceWorker`. */
  advanceWorker(): Promise<void>;
  /** The process's own `/metrics`, or null when it cannot be read. */
  scrape(): Promise<MetricsSnapshot | null>;
  grafana?: GrafanaProbe | null;
  ledgerEnabled: boolean;
  day: string;
  /** Overridable so a test can run one scenario. */
  scenarios?: readonly Scenario[];
  /** Extra caveats for this run — merged with the standing ones. */
  limitations?: string[];
};

export async function runBaseline(options: RunnerOptions): Promise<BaselineArtifact> {
  const git = gitState();
  const scenarios = options.scenarios ?? SCENARIOS;

  const checks = await preflight({
    query: options.query,
    transport: options.transport,
    environment: options.environment,
    ledgerEnabled: options.ledgerEnabled,
    recentProviderTraffic: (await options.grafana?.recentProviderTraffic()) ?? null,
    gitSha: git.sha,
    gitClean: git.clean,
  });

  const reports: ScenarioReport[] = [];
  const runId = options.testCost
    ? await options.testCost.start(options.name, {
        environment: options.environment,
        gitSha: git.sha,
        notes: `transport=${options.transport} providerMode=${options.providerMode}`,
      })
    : null;
  try {
    for (const scenario of scenarios) {
      reports.push(await runScenario(scenario, options));
    }
  } catch (err) {
    if (runId !== null)
      await options.testCost!.fail(runId, err instanceof Error ? err.message : 'failed');
    throw err;
  }
  if (runId !== null) await options.testCost!.finish(runId);

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: options.name,
    kind: 'BEFORE',
    createdAt: new Date().toISOString(),
    run: {
      transport: options.transport,
      environment: options.environment,
      providerMode: options.providerMode,
      gitSha: git.sha,
      day: options.day,
      pricingVersion: PRICING_VERSION,
      currency: PRICING_CURRENCY,
      basis: 'ESTIMATED',
      confidence: 'MEDIUM',
    },
    preflight: checks,
    scenarios: reports,
    totals: totalRows(
      reports.map((r) => r.operations),
      options.day,
    ),
    gaps: staticCostGaps(options.day),
    limitations: [...standingLimitations(options.transport), ...(options.limitations ?? [])],
  };
}

async function runScenario(scenario: Scenario, options: RunnerOptions): Promise<ScenarioReport> {
  await options.flush();
  const ledgerBefore = await snapshotLedger(options.query, options.environment, options.day);
  const metricsBefore = await options.scrape();
  const startedAt = Date.now();

  const outcome = await scenario.run({
    http: options.http,
    fixtures: options.fixtures,
    actors: options.actors,
    fixturesDir: options.fixturesDir,
    advanceWorker: options.advanceWorker,
  });

  await options.flush();
  const ledgerAfter = await snapshotLedger(options.query, options.environment, options.day);
  const metricsAfter = await options.scrape();
  const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));

  const ledgerDiff = diffLedger(ledgerBefore, ledgerAfter);
  const metricsDiff =
    metricsBefore && metricsAfter ? diffSnapshots(metricsBefore, metricsAfter) : null;

  const operations = operationRows({
    usage: ledgerDiff.usage,
    metrics: metricsDiff,
    day: options.day,
  });

  return {
    id: scenario.id,
    title: scenario.title,
    pinnedInput: scenario.pinnedInput,
    operations,
    noNetworkResolutions: outcome.noNetworkResolutions,
    reservations: ledgerDiff.budget,
    crossCheck: await crossCheck(options, ledgerDiff.usage, elapsedSeconds),
    latency: {
      apiP50Ms: percentile(outcome.apiDurationsMs, 0.5),
      apiP95Ms: percentile(outcome.apiDurationsMs, 0.95),
      providerP50Ms: providerLatency(metricsDiff, 0.5),
      providerP95Ms: providerLatency(metricsDiff, 0.95),
      measuresRealNetwork: options.transport === 'live',
    },
    errors: {
      ...(metricsDiff
        ? providerErrorRate(metricsDiff)
        : { providerRequests: 0, providerFailures: 0, providerErrorRate: null }),
      apiNon2xx: outcome.apiNon2xx,
    },
    functional: {
      assertions: outcome.assertions,
      rowsCreated: outcome.rowsCreated,
      rowsDeduped: outcome.rowsDeduped,
      rowsRejected: outcome.rowsRejected,
      duplicatePlaceRate: await duplicatePlaceRate(options.query),
    },
    redis: {
      commands: null,
      method:
        'not measured per scenario: the Developer API stats endpoint (collector upstash_redis, #384) reports a database-wide daily total, not a per-run delta. A per-run figure is daily_net_commands read before/after the run by hand, plus one MONITOR sample via redis-diag; a number here would be invented (plan §4).',
    },
  };
}

/** Grafana beside the ledger, per operation — never merged into it. */
async function crossCheck(
  options: RunnerOptions,
  usage: { operation: string; callsAttempted: number }[],
  elapsedSeconds: number,
): Promise<CrossCheckRow[]> {
  const grafana = options.grafana ? await options.grafana.callsByOperation(elapsedSeconds) : null;
  return usage.map((row) => {
    const seen = grafana?.get(row.operation) ?? null;
    return {
      operation: row.operation,
      ledgerCalls: row.callsAttempted,
      grafanaCalls: seen,
      // `null`, not `false`: an unreachable Grafana is an unverified claim,
      // and reporting it as a failed check would train readers to ignore the
      // column on every stub run.
      agreesWithinOne: seen === null ? null : Math.abs(seen - row.callsAttempted) <= 1,
    };
  });
}

function providerLatency(diff: MetricsSnapshot | null, q: number): number | null {
  if (!diff) return null;
  const seconds = quantileOf(diff, 'place_provider_request_duration_seconds', () => true, q);
  return seconds === null ? null : Math.round(seconds * 1000);
}

/**
 * `places` rows per distinct Google id — §4's duplicate-place rate.
 *
 * After #334 there is one canonical provider row per id, so anything above
 * 1.0 means an identity split that PR4's DB-first path would then serve from
 * the wrong row.
 */
async function duplicatePlaceRate(query: SqlRunner): Promise<number | null> {
  // `GOOGLE_PROVIDER` is `'google_places'` (libs/modules/shared/google-provenance.ts),
  // not `'google'`. Getting it wrong returns no rows, and no rows reads as
  // `null` — an unmeasured duplicate rate rather than a wrong one, which is
  // the right failure mode but still the wrong answer.
  const rows = await query(
    `select count(*)::int as rows, count(distinct external_id)::int as ids
       from place_provider_sources where provider = $1`,
    ['google_places'],
  );
  const row = rows[0] as { rows?: number; ids?: number } | undefined;
  if (!row?.ids) return null;
  return Number(row.rows) / Number(row.ids);
}

function standingLimitations(transport: BaselineTransport): string[] {
  const shared = [
    'Money is an ESTIMATE at Google list price, never an invoice. No field in this artifact is a billed amount.',
    'Redis commands are reported as null rather than guessed: the Developer API daily total (collector upstash_redis, #384) is database-wide, and a per-scenario delta is a hand step (daily_net_commands before/after the run + one MONITOR sample).',
    'Maps SDK map loads are a MEASUREMENT GAP: the SDK renders on the handset and this process sees nothing. Never read the absence as zero.',
    'API latency is client-side wall clock from the runner. There is no server-side HTTP duration histogram in this codebase (metric-labels.ts has a provider histogram only), so the number includes the runner’s own overhead.',
    'google.routeMatrix has exact units and no verified per-element price, so its money columns are null by construction (price_unknown), not zero.',
  ];
  if (transport === 'stub') {
    return [
      'TRANSPORT=stub: the real adapters, masks, resolver and ledger ran; only the HTTP transport was a pinned response table. Call counts are real, latency and error rate are not — they measure this machine. Billable units are what GoGo would be charged for, as counted by our own adapter, not as counted by Google.',
      ...shared,
    ];
  }
  return [
    'TRANSPORT=live: real Google over the network. Counts, latency and error rate are all real; the quiet window in preflight is what bounds contamination.',
    ...shared,
  ];
}

function gitState(): { sha: string; clean: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { sha, clean: status === '' };
  } catch {
    return { sha: 'unknown', clean: false };
  }
}
