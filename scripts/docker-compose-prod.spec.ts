import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * GoGo-BE#687 review F-06 — the deploy commit must reach every process that
 * writes a super admin audit row. The migrate container runs the sync; the API
 * re-runs the erase gate at boot. GoGo-Infra deploy-vps.sh exports
 * GOGO_REVISION on `run --rm migrate` and on every `up -d` that starts api;
 * this file is the half the deploy cannot see, so it is pinned here.
 */

type Compose = { services: Record<string, { environment?: Record<string, string> }> };

const compose = parse(
  readFileSync(path.resolve(__dirname, '../docker/docker-compose.prod.yml'), 'utf8'),
) as Compose;

describe('docker/docker-compose.prod.yml — GOGO_REVISION (#687 F-06)', () => {
  it.each(['api', 'migrate'])('the %s service receives GOGO_REVISION from the deploy', (svc) => {
    expect(compose.services[svc]?.environment?.GOGO_REVISION).toBe('${GOGO_REVISION:-}');
  });

  it('the worker, which writes no super admin audit row, is left alone', () => {
    expect(compose.services.worker?.environment?.GOGO_REVISION).toBeUndefined();
  });
});
