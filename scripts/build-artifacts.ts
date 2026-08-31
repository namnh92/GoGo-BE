/**
 * FND-003 (#13) + FND-005 (#15) — the shared artifacts, built and versioned.
 *
 * The api-contract rule lists what GoGo-BE publishes for every other repo:
 * OpenAPI, the generated TS client, event schemas, design tokens, the
 * analytics taxonomy, and golden fixtures. Two of those were already uploaded
 * by CI; the rest existed only as knowledge in this repo, which meant each
 * consumer re-derived them and drifted independently.
 *
 * Everything lands under `artifacts/` with a manifest carrying the contract
 * version, the commit, and a checksum per file. The checksums are what let a
 * consumer's CI answer "is the client I generated from the spec I think I
 * have" without trusting a version string alone.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ROOM_EVENT_TYPES } from '../libs/modules/realtime/domain/room-event';
import { ALERTED_METRICS } from '../libs/observability/src/alerted-metrics';

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'artifacts');

const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8');

function write(relative: string, contents: string): string {
  const target = path.join(outDir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return relative;
}

/** The domain-event envelope from the api-contract rules, as JSON Schema. */
function eventEnvelopeSchema(): string {
  return JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://gogo.id.vn/schemas/domain-event.json',
      title: 'GoGo domain event envelope',
      description:
        'Every domain event carries this envelope. Field names are snake_case because that is the event convention, not the REST DTO convention.',
      type: 'object',
      required: [
        'event_id',
        'event_type',
        'event_version',
        'occurred_at',
        'resource_type',
        'resource_id',
        'payload',
      ],
      properties: {
        event_id: { type: 'string', format: 'uuid' },
        event_type: { type: 'string' },
        event_version: { type: 'integer', minimum: 1 },
        occurred_at: { type: 'string', format: 'date-time' },
        actor_id: {
          type: ['string', 'null'],
          description:
            'Pseudonymous. Room-scoped member id where a participant is named — never an account id across rooms.',
        },
        resource_type: { type: 'string' },
        resource_id: { type: 'string' },
        correlation_id: { type: ['string', 'null'] },
        payload_schema_version: { type: 'integer', minimum: 1 },
        payload: {
          type: 'object',
          description:
            'Facts, never composed copy. Carries the version a client compares against so a stale event is distinguishable from a fresh one.',
        },
      },
      additionalProperties: false,
    },
    null,
    2,
  );
}

function roomEventSchema(): string {
  return JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://gogo.id.vn/schemas/room-event.json',
      title: 'GoGo room realtime event',
      description: 'Payload of the SSE stream at GET /v1/rooms/{id}/events.',
      allOf: [{ $ref: 'https://gogo.id.vn/schemas/domain-event.json' }],
      properties: { event_type: { enum: [...ROOM_EVENT_TYPES] } },
    },
    null,
    2,
  );
}

/**
 * Semantic design tokens (design-system rule). Published from here so every
 * client resolves the same values instead of each repo keeping its own copy
 * and drifting — which is how a "coral" ends up being two different colours.
 */
function designTokens(): string {
  return JSON.stringify(
    {
      $comment:
        'Semantic tokens only. Components accept these names, never raw hex — a colour literal outside the tokens file is the thing this exists to prevent.',
      color: {
        coral: { value: '#D84F4A', role: 'Primary action / emotional accent' },
        lavender: { value: '#7667E8', role: 'Group, matching, AI accent' },
        mint: { value: '#4FAF86', role: 'Success / within budget' },
        amber: { value: '#D99028', role: 'Warning / attention' },
        ivory: { value: '#F6F3EE', role: 'App background' },
        ink: { value: '#211F1C', role: 'Primary text' },
      },
      accessibility: {
        contrast: 'WCAG 2.2 AA on all main flows',
        minimumTouchTarget: { width: 44, height: 44 },
        motionDurationMs: { min: 150, max: 300 },
        notes: [
          'Contrast must never depend on a blurred layer; text over images needs a scrim or solid fallback.',
          'Colour is never the sole signal — pair with icon, text or shape.',
          'Respect prefers-reduced-motion and reduced transparency.',
        ],
      },
      glass: {
        $comment:
          'Glass is a hierarchy material for cards, sheets and navigation. Never a full-screen blur, never a large blur area on a weak device, and always with a solid fallback.',
      },
    },
    null,
    2,
  );
}

/** What analytics may reference: metric names and event types, no free text. */
function analyticsTaxonomy(): string {
  // Read from the call sites, not from a name pattern: matching any quoted
  // snake_case ending in `_total` swept up `bill_total` and `latency_ms`,
  // which are column names. A taxonomy with fields in it is worse than none,
  // because a consumer would build a dashboard on something never emitted.
  const files = execFileSync(
    'find',
    ['libs', 'apps', '-name', '*.ts', '-not', '-path', '*/dist/*', '-not', '-name', '*.spec.ts'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);

  const emitted: string[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    // Tolerates the call wrapping onto the next line, which is how
    // place_submission_publish_latency_hours is written.
    for (const match of text.matchAll(/\.(?:increment|observe|time)\(\s*'([a-z_]+)'/g)) {
      emitted.push(match[1]!);
    }
  }

  return JSON.stringify(
    {
      $comment:
        'Stable keys. Analytics never stores a display label — a localised string would record different values for the same action depending on the reader.',
      metrics: [...new Set(emitted)].sort(),
      alerted: [...ALERTED_METRICS].sort(),
      roomEvents: [...ROOM_EVENT_TYPES],
    },
    null,
    2,
  );
}

/**
 * The release-gate flows from the quality-gates rule, as data. Consumers build
 * their E2E suites from this so "the minimum flows" means the same list in
 * every repo rather than whatever each team remembered.
 */
function goldenScenarios(): string {
  return JSON.stringify(
    {
      $comment: 'Minimum E2E flows (quality-gates rule). A release gate, not a suggestion.',
      scenarios: [
        {
          id: 'couple-match-plan',
          audience: 'couple',
          steps: ['create room', 'both members pick', 'match', 'plan appears'],
        },
        {
          id: 'group-guest-vote',
          audience: 'group-guest',
          steps: ['guest joins by invite', 'preferences', 'vote', 'host finalizes'],
        },
        {
          id: 'regenerate-keeps-locked',
          audience: 'group-host',
          steps: ['lock a stop', 'regenerate', 'locked stop is byte-identical'],
          invariant: 'core rule #7 — a locked stop survives regenerate, no exception',
        },
        {
          id: 'list-map-share-state',
          audience: 'any',
          steps: ['filter in list', 'switch to map', 'filter and navigation state carried over'],
        },
        {
          id: 'unavailable-place-excluded',
          audience: 'any',
          steps: ['place becomes unavailable', 'excluded or warned within SLA'],
          invariant: 'core rule #8 — never shown as certain',
        },
        {
          id: 'ai-failure-deterministic',
          audience: 'any',
          steps: ['AI or provider fails', 'deterministic result still returned'],
        },
        {
          id: 'member-cannot-host',
          audience: 'group-member',
          steps: ['hand-craft a host-only request', 'API refuses'],
          invariant: 'core rule #5 — hiding a button is never the enforcement',
        },
      ],
    },
    null,
    2,
  );
}

function main(): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const specYaml = read('openapi/gogo.v1.yaml');
  const spec = parse(specYaml) as { info: { version: string } };
  const version = spec.info.version;

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .slice(0, 12);

  const files = [
    write('openapi/gogo.v1.yaml', specYaml),
    write('openapi/gogo.v1.json', `${JSON.stringify(parse(specYaml), null, 2)}\n`),
    write('openapi/gogo.v1.d.ts', read('openapi/gogo.v1.d.ts')),
    write('events/domain-event.schema.json', `${eventEnvelopeSchema()}\n`),
    write('events/room-event.schema.json', `${roomEventSchema()}\n`),
    write('design-tokens/tokens.json', `${designTokens()}\n`),
    write('analytics/taxonomy.json', `${analyticsTaxonomy()}\n`),
    write('fixtures/golden-scenarios.json', `${goldenScenarios()}\n`),
  ];

  const manifest = {
    name: 'gogo-contract',
    // The contract version, not the repo version: repos do not share a
    // version, and this is the number a consumer pins against.
    version,
    commit,
    files: files
      .map((relative) => ({
        path: relative,
        // A version string alone cannot answer "is this the spec I think it
        // is" after a hand-edit; a checksum can.
        sha256: createHash('sha256')
          .update(readFileSync(path.join(outDir, relative)))
          .digest('hex'),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`artifacts/ built for contract ${version} @ ${commit}`);
  for (const file of manifest.files) console.log(`  ${file.path}  ${file.sha256.slice(0, 12)}`);
}

main();
