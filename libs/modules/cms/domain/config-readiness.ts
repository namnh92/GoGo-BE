import { z } from 'zod';

/**
 * GoGo-BE#727 (OPS-BE-002; GoGo-Infra#309 shape rev 4, D-9) — which variables
 * this API process holds, joined with the readiness projection the deploy left
 * beside its env file.
 *
 * Facts only, and never a value: for every variable the answer is a boolean,
 * never the value, a prefix, a length or a hash. The verdicts come from the
 * projection, which GoGo-Infra computed (A-F-11) — this module copies them and
 * computes only what the projection cannot know: whether this process has each
 * variable.
 *
 * The projection is a dated snapshot of one deploy. Its `deploy_id` equal to
 * the process's `APP_DEPLOY_ID` says the file describes the configuration this
 * process was started with — not that SSM still holds the same, nor that any
 * credential works (residual risk r3).
 */

/** One key of the API's env object schema (apps/api/src/config/env.ts). */
export type ConfigCatalogueEntry = {
  name: string;
  /** The schema lets it be absent (optional, or a default). */
  optional: boolean;
  /** Its requirement is decided in `superRefine`, not by the field. */
  conditional: boolean;
};

/**
 * What the API binds for this endpoint (`CONFIG_CATALOGUE`). The schema keys,
 * plus the one loader outside the object schema: the export wrapping keyring,
 * whose variable names (`EXPORT_WRAPPING_KEY_V<n>`) are open-ended.
 */
export type ConfigCatalogue = {
  keys: readonly ConfigCatalogueEntry[];
  /** Names the dynamic loader would pick from this environment. */
  dynamicNames: (env: Readonly<Record<string, string | undefined>>) => string[];
  /** Whether a name belongs to the dynamic loader. */
  isDynamic: (name: string) => boolean;
};

export const CONFIG_CATALOGUE = Symbol('CONFIG_CATALOGUE');

export type ProcessVariable = {
  name: string;
  /** Set and not blank in the raw environment — raw presence, not validity. */
  present: boolean;
  optional: boolean;
  conditional: boolean;
};

export type InfraUnavailableReason =
  'not_configured' | 'missing' | 'unreadable' | 'invalid' | 'unknown_schema';

export type Verdict = 'OK' | 'FAIL' | 'UNKNOWN';

export type InfraRow = {
  path: string;
  env_var: string | null;
  lifecycle: string;
  presence: 'present' | 'absent' | 'unknown';
  findings: string[];
  verdict: Verdict;
  capabilities: string[];
  /**
   * `api` when the API process reads the variable (a key of its env schema or
   * of the dynamic loader); `host` for the deploy host's own variables in the
   * same env file (`DOMAIN`, `ACME_EMAIL`, `TUNNEL_TOKEN` …), which compose
   * and cloudflared consume. A host row has no process column.
   */
  applicable: 'api' | 'host';
  /** `null` for a host row: the API never holds it, so absence means nothing. */
  process_present: boolean | null;
};

export type InfraSnapshot = {
  /** Always `deploy_snapshot`: what this is, so no reader takes it for live state. */
  label: 'deploy_snapshot';
  schema_version: 1;
  env: string;
  generated_at: string;
  manifest_sha: string | null;
  deploy_id: string;
  release_sha: string;
  run_id: string;
  run_attempt: string;
  /** This process's `APP_DEPLOY_ID`, an identifier, not a secret; `null` when unset. */
  process_deploy_id: string | null;
  /** The snapshot describes the env file this process was started with. A warning when false. */
  deploy_match: boolean;
  rows: InfraRow[];
};

export type CapabilityReadiness = {
  name: string;
  status: 'enabled' | 'planned';
  /** Copied from the projection's canonical capability verdict; never recomputed. */
  ssm_verdict: Verdict;
  /** Copied from the projection: verdict OK. */
  ssm_ready: boolean;
  /** Copied from the projection: the rows that keep it from OK. */
  ssm_missing: string[];
  /** Presence-only count of its rows stored in SSM — a count, never readiness. */
  ssm_present: { present: number; total: number };
  /**
   * Every api-applicable row of the capability is present in this process.
   * `null` when it has none (only host rows).
   */
  process_ready: boolean | null;
  /** api-applicable env_vars the process does not hold. */
  process_missing: string[];
  /** Host rows, left out of `process_ready` and listed instead. */
  excluded_from_process: string[];
};

export type ConfigReadiness = {
  process: ProcessVariable[];
  process_dynamic: ProcessVariable[];
  infra: InfraSnapshot | null;
  /** Why `infra` is null; `null` when it is not. */
  reason: InfraUnavailableReason | null;
  capabilities: CapabilityReadiness[];
};

/** Blank and unset are the same answer: the process cannot use either. */
export function isPresent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

const verdict = z.enum(['OK', 'FAIL', 'UNKNOWN']);

/**
 * The projection as GoGo-Infra writes it (`manifest.py --project-deploy`,
 * schema 1). Parsed, never echoed: only the fields below are read, so a field
 * added to the file later cannot reach a response by default.
 */
const projectionSchema = z.object({
  schema_version: z.literal(1),
  env: z.string().max(32),
  generated_at: z.string().max(64),
  manifest_sha: z.string().max(64).nullable(),
  deploy_id: z.string().regex(/^[0-9a-f]{40}-[0-9]+-[0-9]+$/),
  release_sha: z.string().regex(/^[0-9a-f]{40}$/),
  run_id: z.string().regex(/^[0-9]+$/),
  run_attempt: z.string().regex(/^[0-9]+$/),
  rows: z
    .array(
      z.object({
        path: z.string().max(256),
        env_var: z.string().max(128).nullable(),
        lifecycle: z.string().max(32),
        presence: z.enum(['present', 'absent', 'unknown']),
        findings: z.array(z.string().max(64)).max(32),
        verdict,
        capabilities: z.array(z.string().max(128)).max(64),
      }),
    )
    .max(2000),
  capabilities: z
    .array(
      z.object({
        name: z.string().max(128),
        status: z.enum(['enabled', 'planned']),
        verdict,
        ready: z.boolean(),
        missing: z.array(z.string().max(256)).max(256),
      }),
    )
    .max(256),
});

export type Projection = z.infer<typeof projectionSchema>;

export type ProjectionRead =
  { ok: true; projection: Projection } | { ok: false; reason: InfraUnavailableReason };

/** The projection file's text, parsed and checked against schema 1. */
export function parseProjection(text: string): ProjectionRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schema_version' in raw &&
    (raw as { schema_version: unknown }).schema_version !== 1
  ) {
    return { ok: false, reason: 'unknown_schema' };
  }
  const parsed = projectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, reason: 'invalid' };
}

export function buildConfigReadiness(input: {
  catalogue: ConfigCatalogue;
  env: Readonly<Record<string, string | undefined>>;
  projection: ProjectionRead;
}): ConfigReadiness {
  const { catalogue, env } = input;
  const schemaKeys = new Set(catalogue.keys.map((k) => k.name));

  const process: ProcessVariable[] = catalogue.keys.map((k) => ({
    name: k.name,
    present: isPresent(env[k.name]),
    optional: k.optional,
    conditional: k.conditional,
  }));

  // The dynamic loader names what it finds; the projection names what the
  // deploy declared. Both, so a declared wrapping key the process lacks shows
  // as absent instead of not at all.
  const declaredDynamic = input.projection.ok
    ? input.projection.projection.rows
        .map((r) => r.env_var)
        .filter((n): n is string => n !== null && catalogue.isDynamic(n))
    : [];
  const dynamicNames = [...new Set([...catalogue.dynamicNames(env), ...declaredDynamic])].sort();
  const process_dynamic: ProcessVariable[] = dynamicNames.map((name) => ({
    name,
    present: isPresent(env[name]),
    optional: true,
    conditional: false,
  }));

  if (!input.projection.ok) {
    return {
      process,
      process_dynamic,
      infra: null,
      reason: input.projection.reason,
      capabilities: [],
    };
  }

  const p = input.projection.projection;
  const apiApplicable = (name: string | null): name is string =>
    name !== null && (schemaKeys.has(name) || catalogue.isDynamic(name));

  const rows: InfraRow[] = p.rows.map((r) => {
    const api = apiApplicable(r.env_var);
    return {
      path: r.path,
      env_var: r.env_var,
      lifecycle: r.lifecycle,
      presence: r.presence,
      findings: [...r.findings],
      verdict: r.verdict,
      capabilities: [...r.capabilities],
      applicable: api ? 'api' : 'host',
      process_present: api ? isPresent(env[r.env_var as string]) : null,
    };
  });

  const capabilities: CapabilityReadiness[] = p.capabilities.map((c) => {
    const own = rows.filter((r) => r.capabilities.includes(c.name));
    const api = own.filter((r) => r.applicable === 'api');
    const missing = api.filter((r) => r.process_present !== true).map((r) => r.env_var as string);
    return {
      name: c.name,
      status: c.status,
      ssm_verdict: c.verdict,
      ssm_ready: c.ready,
      ssm_missing: [...c.missing],
      ssm_present: {
        present: own.filter((r) => r.presence === 'present').length,
        total: own.length,
      },
      process_ready: api.length === 0 ? null : missing.length === 0,
      process_missing: missing,
      excluded_from_process: own
        .filter((r) => r.applicable === 'host')
        .map((r) => r.env_var ?? r.path),
    };
  });

  const processDeployId = isPresent(env.APP_DEPLOY_ID)
    ? (env.APP_DEPLOY_ID as string).trim()
    : null;
  return {
    process,
    process_dynamic,
    infra: {
      label: 'deploy_snapshot',
      schema_version: 1,
      env: p.env,
      generated_at: p.generated_at,
      manifest_sha: p.manifest_sha,
      deploy_id: p.deploy_id,
      release_sha: p.release_sha,
      run_id: p.run_id,
      run_attempt: p.run_attempt,
      process_deploy_id: processDeployId,
      deploy_match: processDeployId === p.deploy_id,
      rows,
    },
    reason: null,
    capabilities,
  };
}
