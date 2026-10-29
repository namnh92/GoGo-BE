import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigCatalogue } from '../domain/config-readiness';
import { CmsConfigReadinessService, PROJECTION_MAX_BYTES } from './cms-config-readiness.service';

/**
 * GoGo-BE#727 — how the projection file is read. An absent, unreadable or
 * foreign file is a fact about the deploy (`infra: null` + reason), never an
 * error of the endpoint (AC-2).
 */

const catalogue: ConfigCatalogue = {
  keys: [{ name: 'DATABASE_URL', optional: false, conditional: false }],
  dynamicNames: () => [],
  isDynamic: () => false,
};
const dir = mkdtempSync(path.join(tmpdir(), 'gogo-727-'));
const service = (file: string) =>
  new CmsConfigReadinessService(catalogue, { SECRETS_READINESS_FILE: file });

const valid = {
  schema_version: 1,
  env: 'dev',
  generated_at: '2026-10-29T13:58:31Z',
  manifest_sha: null,
  deploy_id: `${'b'.repeat(40)}-7-1`,
  release_sha: 'b'.repeat(40),
  run_id: '7',
  run_attempt: '1',
  rows: [],
  capabilities: [],
};

describe('CmsConfigReadinessService', () => {
  it('not_configured when SECRETS_READINESS_FILE is unset', async () => {
    const res = await service('').readiness({ DATABASE_URL: 'x' });
    expect(res).toMatchObject({ infra: null, reason: 'not_configured' });
    expect(res.process).toEqual([
      { name: 'DATABASE_URL', present: true, optional: false, conditional: false },
    ]);
  });

  it('missing when the file does not exist', async () => {
    expect(await service(path.join(dir, 'nope.json')).readiness({})).toMatchObject({
      infra: null,
      reason: 'missing',
    });
  });

  it('invalid for malformed JSON, a directory or an oversized file', async () => {
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{');
    expect((await service(bad).readiness({})).reason).toBe('invalid');
    expect((await service(dir).readiness({})).reason).toBe('invalid');
    const big = path.join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(PROJECTION_MAX_BYTES + 1));
    expect((await service(big).readiness({})).reason).toBe('invalid');
  });

  it('unknown_schema for a schema version it does not know', async () => {
    const f = path.join(dir, 'v2.json');
    writeFileSync(f, JSON.stringify({ ...valid, schema_version: 2 }));
    expect((await service(f).readiness({})).reason).toBe('unknown_schema');
  });

  it.skipIf(process.getuid?.() === 0)('unreadable when the file cannot be read', async () => {
    const f = path.join(dir, 'locked.json');
    writeFileSync(f, JSON.stringify(valid));
    chmodSync(f, 0o000);
    expect((await service(f).readiness({})).reason).toBe('unreadable');
  });

  it('reads a valid projection', async () => {
    const f = path.join(dir, 'ok.json');
    writeFileSync(f, JSON.stringify(valid));
    const res = await service(f).readiness({ APP_DEPLOY_ID: valid.deploy_id });
    expect(res.reason).toBeNull();
    expect(res.infra).toMatchObject({
      deploy_id: valid.deploy_id,
      deploy_match: true,
      label: 'deploy_snapshot',
    });
  });
});
