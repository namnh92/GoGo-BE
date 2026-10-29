import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildConfigReadiness,
  isPresent,
  parseProjection,
  type ConfigCatalogue,
  type Projection,
} from './config-readiness';

/**
 * GoGo-BE#727 (GoGo-Infra#309 D-9) — the join of process presence with the
 * deploy's readiness projection. What is pinned: facts only, never a value;
 * verdicts copied from the projection, never recomputed (A-F-11); host rows
 * never get a process column (A-F-06).
 */

const catalogue: ConfigCatalogue = {
  keys: [
    { name: 'DATABASE_URL', optional: false, conditional: false },
    { name: 'AUTH_JWT_SECRET', optional: true, conditional: true },
    { name: 'R2_PUBLIC_BUCKET', optional: true, conditional: true },
    { name: 'R2_PUBLIC_ACCESS_KEY_ID', optional: true, conditional: true },
    { name: 'APP_DEPLOY_ID', optional: true, conditional: false },
  ],
  dynamicNames: (env) => Object.keys(env).filter((n) => /^EXPORT_WRAPPING_KEY_V\d+$/.test(n)),
  isDynamic: (n) => /^EXPORT_WRAPPING_KEY_V\d+$/.test(n) || n === 'EXPORT_WRAPPING_KEY_ACTIVE',
};

const SHA = 'a'.repeat(40);
const DEPLOY_ID = `${SHA}-4242-1`;

function projection(over: Partial<Projection> = {}): Projection {
  return {
    schema_version: 1,
    env: 'dev',
    generated_at: '2026-10-29T13:58:31Z',
    manifest_sha: '9d59f0d22015a936972469f6244ecdca1baacd82',
    deploy_id: DEPLOY_ID,
    release_sha: SHA,
    run_id: '4242',
    run_attempt: '1',
    rows: [
      row('database/url', 'DATABASE_URL', 'required', []),
      row('r2/public-bucket', 'R2_PUBLIC_BUCKET', 'optional', ['public_catalogue_uploads']),
      row('r2/public-access-key-id', 'R2_PUBLIC_ACCESS_KEY_ID', 'optional', [
        'public_catalogue_uploads',
      ]),
      row('tunnel/token', 'TUNNEL_TOKEN', 'optional', ['public_catalogue_uploads']),
      row('privacy-export/wrapping-key-v1', 'EXPORT_WRAPPING_KEY_V1', 'optional', []),
    ],
    capabilities: [
      {
        name: 'public_catalogue_uploads',
        status: 'enabled',
        verdict: 'FAIL',
        ready: false,
        missing: ['/gogo/dev/backend/r2/public-access-key-id'],
      },
    ],
    ...over,
  };
}

function row(
  path: string,
  envVar: string | null,
  lifecycle: string,
  capabilities: string[],
  presence: 'present' | 'absent' | 'unknown' = 'present',
): Projection['rows'][number] {
  return {
    path: `/gogo/dev/backend/${path}`,
    env_var: envVar,
    lifecycle,
    presence,
    findings: [],
    verdict: 'OK',
    capabilities,
  };
}

const ok = (p: Projection) => ({ ok: true as const, projection: p });

describe('process presence', () => {
  it('reports every catalogue key, set or not, with the schema flags', () => {
    const res = buildConfigReadiness({
      catalogue,
      env: { DATABASE_URL: 'postgres://x', AUTH_JWT_SECRET: '   ' },
      projection: { ok: false, reason: 'missing' },
    });
    expect(res.process).toEqual([
      { name: 'DATABASE_URL', present: true, optional: false, conditional: false },
      { name: 'AUTH_JWT_SECRET', present: false, optional: true, conditional: true },
      { name: 'R2_PUBLIC_BUCKET', present: false, optional: true, conditional: true },
      { name: 'R2_PUBLIC_ACCESS_KEY_ID', present: false, optional: true, conditional: true },
      { name: 'APP_DEPLOY_ID', present: false, optional: true, conditional: false },
    ]);
  });

  it('blank is absent', () => {
    expect(isPresent(undefined)).toBe(false);
    expect(isPresent('')).toBe(false);
    expect(isPresent(' \t')).toBe(false);
    expect(isPresent('x')).toBe(true);
  });

  it('lists the dynamic loader: what it finds and what the deploy declared', () => {
    const res = buildConfigReadiness({
      catalogue,
      env: { EXPORT_WRAPPING_KEY_V2: 'k' },
      projection: ok(projection()),
    });
    expect(res.process_dynamic).toEqual([
      { name: 'EXPORT_WRAPPING_KEY_V1', present: false, optional: true, conditional: false },
      { name: 'EXPORT_WRAPPING_KEY_V2', present: true, optional: true, conditional: false },
    ]);
  });
});

describe('no projection', () => {
  for (const reason of [
    'not_configured',
    'missing',
    'unreadable',
    'invalid',
    'unknown_schema',
  ] as const) {
    it(`${reason}: infra null with the reason, process still complete`, () => {
      const res = buildConfigReadiness({ catalogue, env: {}, projection: { ok: false, reason } });
      expect(res.infra).toBeNull();
      expect(res.reason).toBe(reason);
      expect(res.process).toHaveLength(catalogue.keys.length);
      expect(res.capabilities).toEqual([]);
    });
  }
});

describe('the join', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    R2_PUBLIC_BUCKET: 'gogo-dev-public',
    APP_DEPLOY_ID: DEPLOY_ID,
  };

  it('marks schema and dynamic-loader variables api, everything else host', () => {
    const res = buildConfigReadiness({ catalogue, env, projection: ok(projection()) });
    const byVar = Object.fromEntries(res.infra!.rows.map((r) => [r.env_var, r]));
    expect(byVar.DATABASE_URL).toMatchObject({ applicable: 'api', process_present: true });
    expect(byVar.R2_PUBLIC_ACCESS_KEY_ID).toMatchObject({
      applicable: 'api',
      process_present: false,
    });
    expect(byVar.EXPORT_WRAPPING_KEY_V1).toMatchObject({
      applicable: 'api',
      process_present: false,
    });
    // A host variable has no process column: the API never holds it.
    expect(byVar.TUNNEL_TOKEN).toMatchObject({ applicable: 'host', process_present: null });
  });

  it('copies the canonical capability verdict and computes only process readiness', () => {
    const res = buildConfigReadiness({ catalogue, env, projection: ok(projection()) });
    expect(res.capabilities).toEqual([
      {
        name: 'public_catalogue_uploads',
        status: 'enabled',
        ssm_verdict: 'FAIL',
        ssm_ready: false,
        ssm_missing: ['/gogo/dev/backend/r2/public-access-key-id'],
        // Every row is present in SSM, and the verdict is still the projection's FAIL.
        ssm_present: { present: 3, total: 3 },
        process_ready: false,
        process_missing: ['R2_PUBLIC_ACCESS_KEY_ID'],
        excluded_from_process: ['TUNNEL_TOKEN'],
      },
    ]);
  });

  it('a row stored in SSM and missing from the process is shown as such', () => {
    const res = buildConfigReadiness({ catalogue, env, projection: ok(projection()) });
    const r = res.infra!.rows.find((x) => x.env_var === 'R2_PUBLIC_ACCESS_KEY_ID')!;
    expect(r.presence).toBe('present');
    expect(r.process_present).toBe(false);
  });

  it('process_ready is null for a capability made of host rows only', () => {
    const p = projection({
      rows: [row('tunnel/token', 'TUNNEL_TOKEN', 'optional', ['edge'])],
      capabilities: [{ name: 'edge', status: 'planned', verdict: 'OK', ready: true, missing: [] }],
    });
    const res = buildConfigReadiness({ catalogue, env, projection: ok(p) });
    expect(res.capabilities[0]).toMatchObject({
      process_ready: null,
      excluded_from_process: ['TUNNEL_TOKEN'],
    });
  });

  it('deploy_match compares the projection with APP_DEPLOY_ID', () => {
    const match = buildConfigReadiness({ catalogue, env, projection: ok(projection()) });
    expect(match.infra).toMatchObject({
      label: 'deploy_snapshot',
      deploy_match: true,
      process_deploy_id: DEPLOY_ID,
    });
    const other = buildConfigReadiness({
      catalogue,
      env: { ...env, APP_DEPLOY_ID: `${SHA}-4242-2` },
      projection: ok(projection()),
    });
    expect(other.infra!.deploy_match).toBe(false);
    const unset = buildConfigReadiness({
      catalogue,
      env: { DATABASE_URL: 'x' },
      projection: ok(projection()),
    });
    expect(unset.infra).toMatchObject({ deploy_match: false, process_deploy_id: null });
  });
});

describe('parseProjection', () => {
  it('accepts schema 1 and drops fields it does not know', () => {
    const text = JSON.stringify({
      ...projection(),
      extra: 'not echoed',
      rows: [{ ...row('a', 'A', 'optional', []), parameter_age_days: 3 }],
    });
    const res = parseProjection(text);
    expect(res.ok).toBe(true);
    const built = buildConfigReadiness({ catalogue, env: {}, projection: res });
    expect(JSON.stringify(built)).not.toContain('not echoed');
    expect(JSON.stringify(built)).not.toContain('parameter_age_days');
  });

  it('a schema it does not know is unknown_schema, malformed JSON or shape is invalid', () => {
    expect(parseProjection(JSON.stringify({ ...projection(), schema_version: 2 }))).toEqual({
      ok: false,
      reason: 'unknown_schema',
    });
    expect(parseProjection('{not json')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseProjection(JSON.stringify({ ...projection(), deploy_id: 'develop' }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('never a value (AC-3)', () => {
  // Property test: random secrets in every variable, the response must contain
  // none of them, no fragment of them, and no number but the counts it states.
  it('no value, prefix or length of any variable reaches the response', () => {
    for (let round = 0; round < 50; round++) {
      const env: Record<string, string> = {};
      const secrets: string[] = [];
      for (const k of [
        ...catalogue.keys.map((c) => c.name),
        'EXPORT_WRAPPING_KEY_V1',
        'TUNNEL_TOKEN',
      ]) {
        if (k === 'APP_DEPLOY_ID') continue;
        const v = `s3cr3t-${randomBytes(12 + (round % 20)).toString('hex')}`;
        env[k] = v;
        secrets.push(v);
      }
      const json = JSON.stringify(
        buildConfigReadiness({ catalogue, env, projection: ok(projection()) }),
      );
      for (const v of secrets) {
        expect(json).not.toContain(v);
        expect(json).not.toContain(v.slice(0, 12));
      }
      expect(json).not.toContain('s3cr3t');
      const numbers = [...json.matchAll(/:(\d+)[,}]/g)].map((m) => Number(m[1]));
      // The only numbers are presence counts and the schema version.
      expect(numbers.every((n) => n <= 5)).toBe(true);
    }
  });
});
