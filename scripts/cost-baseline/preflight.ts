/**
 * PR3 / COST-BE-003 (#336) — the contamination controls of plan §4, executed
 * instead of remembered.
 *
 * "Declared quiet window" is a sentence in a plan. What makes a baseline
 * trustworthy months later is that the run itself recorded whether the window
 * held, so a reader can tell a clean measurement from one taken while a bulk
 * import was running.
 *
 * A failed gate does **not** abort the run. It is written into the artifact,
 * every number keeps its `preflight.quiet: false` marker, and the operator
 * decides. Aborting would tempt the next person to skip preflight entirely to
 * get a number out; recording makes a contaminated baseline impossible to
 * mistake for a clean one, which is the property that actually matters.
 */

import type { BaselineTransport, PreflightReport } from './artifact';
import type { SqlRunner } from './ledger';

export type PreflightInput = {
  query: SqlRunner;
  transport: BaselineTransport;
  environment: string;
  ledgerEnabled: boolean;
  /** `increase(places_provider_requests_total{env}[10m])`, or null if unreachable. */
  recentProviderTraffic: number | null;
  gitSha: string;
  gitClean: boolean;
};

export async function preflight(input: PreflightInput): Promise<PreflightReport> {
  const checks: PreflightReport['checks'] = [];

  const processing = await input.query(
    `select count(*)::int as n from place_ingest_jobs where status = 'processing'`,
    [],
  );
  const running = Number((processing[0] as { n?: number } | undefined)?.n ?? 0);
  checks.push({
    name: 'no import job processing',
    required: true,
    pass: running === 0,
    detail:
      running === 0
        ? 'no row in place_ingest_jobs is processing'
        : `${running} import job(s) processing — their provider calls would land in this window`,
  });

  checks.push({
    name: 'usage ledger enabled',
    required: true,
    pass: input.ledgerEnabled,
    detail: input.ledgerEnabled
      ? 'COST_LEDGER_ENABLED — provider_usage_daily is being written'
      : 'ledger off: provider_usage_daily will not move and every operation count would read zero',
  });

  if (input.transport === 'live') {
    const quiet = input.recentProviderTraffic;
    checks.push({
      name: '10 minutes of zero provider traffic',
      required: true,
      pass: quiet === 0,
      detail:
        quiet === null
          ? 'Grafana unreachable — the quiet window could not be verified'
          : `increase(places_provider_requests_total{env="${input.environment}"}[10m]) = ${quiet}`,
    });
    // §4 names the phones explicitly: a DEV tunnel with a handset on it makes
    // the ledger move for reasons the scenario did not cause. There is no
    // server-side way to prove none is attached, so this is recorded as an
    // operator declaration rather than pretended to be a measurement.
    checks.push({
      name: 'no client on the DEV tunnel',
      required: true,
      pass: process.env.COST_BASELINE_TUNNEL_QUIET === 'true',
      detail:
        'declared by the operator via COST_BASELINE_TUNNEL_QUIET=true after checking redis-diag CLIENT LIST shows api only',
    });
  } else {
    checks.push({
      name: 'quiet window',
      required: false,
      pass: true,
      detail:
        'not applicable: the stub transport answers in-process, so no other traffic can reach it',
    });
  }

  checks.push({
    name: 'working tree clean',
    required: false,
    pass: input.gitClean,
    detail: input.gitClean
      ? `measured at ${input.gitSha}`
      : `measured at ${input.gitSha} with uncommitted changes — the code under measurement is not the code in the commit`,
  });

  return { checks, quiet: checks.every((c) => !c.required || c.pass) };
}
