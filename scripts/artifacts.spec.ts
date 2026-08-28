import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const artifacts = path.join(repoRoot, 'artifacts');

type Manifest = { version: string; commit: string; files: { path: string; sha256: string }[] };
let manifest: Manifest;

/**
 * FND-003 (#13) — the published contract.
 *
 * Every other repo generates its client from these, so a missing or stale file
 * here is a break that surfaces in someone else's build.
 */
describe('contract artifacts', () => {
  beforeAll(() => {
    execFileSync('pnpm', ['artifacts'], { cwd: repoRoot, stdio: 'pipe' });
    manifest = JSON.parse(readFileSync(path.join(artifacts, 'manifest.json'), 'utf8')) as Manifest;
  }, 120_000);

  it('publishes everything the api-contract rule lists', () => {
    const published = manifest.files.map((f) => f.path);
    for (const required of [
      'openapi/gogo.v1.yaml',
      'openapi/gogo.v1.json',
      'openapi/gogo.v1.d.ts',
      'events/domain-event.schema.json',
      'events/room-event.schema.json',
      'design-tokens/tokens.json',
      'analytics/taxonomy.json',
      'fixtures/golden-scenarios.json',
    ]) {
      expect(published).toContain(required);
    }
  });

  it('carries the contract version, not a repo version', () => {
    const spec = readFileSync(path.join(repoRoot, 'openapi/gogo.v1.yaml'), 'utf8');
    const version = /^\s+version:\s*(\S+)/m.exec(spec)?.[1];
    // Repos do not share a version; this is the number a consumer pins to.
    expect(manifest.version).toBe(version);
    expect(manifest.commit).toMatch(/^[0-9a-f]{12}$/);
  });

  it('checksums match the files, so a hand-edit is detectable', () => {
    for (const file of manifest.files) {
      const actual = createHash('sha256')
        .update(readFileSync(path.join(artifacts, file.path)))
        .digest('hex');
      expect(actual).toBe(file.sha256);
    }
  });

  it('the analytics taxonomy contains metrics, not column names', () => {
    const taxonomy = JSON.parse(
      readFileSync(path.join(artifacts, 'analytics/taxonomy.json'), 'utf8'),
    ) as { metrics: string[]; alerted: string[] };

    // Extracted from call sites. A name-shaped grep swept up `bill_total` and
    // `latency_ms`, which are columns — a taxonomy with fields in it is worse
    // than none, because a consumer builds a dashboard on something never
    // emitted.
    expect(taxonomy.metrics).not.toContain('bill_total');
    expect(taxonomy.metrics).not.toContain('latency_ms');
    expect(taxonomy.metrics).toContain('place_import_rows_total');
    for (const alerted of taxonomy.alerted) expect(taxonomy.metrics).toContain(alerted);
  });

  it('the room event schema lists the types the stream actually emits', () => {
    const schema = JSON.parse(
      readFileSync(path.join(artifacts, 'events/room-event.schema.json'), 'utf8'),
    ) as { properties: { event_type: { enum: string[] } } };
    expect(schema.properties.event_type.enum).toContain('participant.selection_changed');
    // Stream-level types are part of the contract too: a client that ignores
    // `resync` resumes into a hole without knowing it.
    expect(schema.properties.event_type.enum).toContain('resync');
  });

  it('the JSON spec is the YAML spec, not a separate document', () => {
    const json = JSON.parse(readFileSync(path.join(artifacts, 'openapi/gogo.v1.json'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const yaml = readFileSync(path.join(artifacts, 'openapi/gogo.v1.yaml'), 'utf8');
    for (const route of Object.keys(json.paths)) expect(yaml).toContain(`${route}:`);
  });
});
