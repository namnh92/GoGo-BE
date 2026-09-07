import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativeResolverService,
  AdministrativeValidationService,
} from '@gogo/modules';

/**
 * ADM-010 (#463) — the telemetry, asserted against a real scrape.
 *
 * Two properties are worth more than the rest. **Every label is bounded**: the
 * scrape is parsed and checked for the identities that must never appear in
 * one — a place id, a dataset UUID, a version string, a reviewer. And **the
 * zero-cost guarantee is measured on the real meters**, not on a decorative
 * counter that could only ever read zero.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let datasetId: string;
let datasetVersion: string;

/**
 * Set at module scope, before any import can read the environment. The config
 * is parsed once per process, and a token assigned inside `beforeAll` is
 * assigned after something has already looked — which is why `/metrics`
 * answered 404 and every scrape silently measured nothing.
 */
process.env.METRICS_TOKEN = 'metrics-token-adm010';

const BOUNDARY_VERSION = 'fixture-v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.79.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const tokens: Record<string, string> = {};
const adminIds: Record<string, string> = {};

type Role = 'editor' | 'moderator' | 'ops_admin';

const get = (url: string, role?: Role) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    ...(role ? { headers: { authorization: `Bearer ${tokens[role]}` } } : {}),
  });

const send = (
  method: 'POST' | 'PATCH',
  url: string,
  role: Role,
  payload: Record<string, unknown> = {},
) =>
  api().inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${tokens[role]}` },
    payload,
  });

async function scrape(): Promise<string> {
  const res = await api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** All samples of one metric, as `{labels, value}`. */
function samples(
  body: string,
  metric: string,
): { labels: Record<string, string>; value: number }[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `))
    .map((line) => {
      const match = /^([a-z_]+)(?:\{(.*)\})? ([-\d.e+]+)$/.exec(line.trim());
      const labels: Record<string, string> = {};
      for (const pair of match?.[2]?.split(',') ?? []) {
        const [key, value] = pair.split('=');
        if (key) labels[key] = (value ?? '').replace(/"/g, '');
      }
      return { labels, value: Number(match?.[3] ?? 0) };
    });
}

const value = (body: string, metric: string, labels: Record<string, string> = {}): number =>
  samples(body, metric)
    .filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((sum, s) => sum + s.value, 0);

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

async function insidePoint(code: string): Promise<{ lng: number; lat: number }> {
  const [row] = await rows<{ lng: number; lat: number }>(sql`
    select st_x(p) as lng, st_y(p) as lat from (
      select st_pointonsurface(geom) as p from administrative_unit_boundaries
      where boundary_version = ${BOUNDARY_VERSION} and code = ${code}) s`);
  return row!;
}

async function insertPlace(over: Record<string, unknown> = {}) {
  const inside = await insidePoint('00004');
  const [row] = await db
    .insert(schema.places)
    .values({
      name: 'Quán Đo Đạc',
      nameNormalized: 'quan do dac',
      geom: { x: inside.lng, y: inside.lat },
      addressText: '19 Lê Hồng Phong',
      status: 'review',
      ...over,
    })
    .returning();
  return row!;
}

async function createAdmin(role: Role) {
  const email = `adm010-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: role, role })
    .returning();
  adminIds[role] = row!.id;
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_observability_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  datasetVersion = report.combinedDatasetVersion;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: BOUNDARY_VERSION,
    archivePath: FIXTURE,
  });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  for (const role of ['editor', 'moderator', 'ops_admin'] as const) await createAdmin(role);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
});

describe('gauges describe the present, not the past', () => {
  it('reports an active dataset, its age and its boundary release', async () => {
    const body = await scrape();
    expect(value(body, 'administrative_dataset_active')).toBe(1);
    expect(value(body, 'administrative_boundary_active')).toBe(1);
    expect(value(body, 'administrative_publication_enabled')).toBe(1);
    // Refreshed at scrape time: an age computed at publication would be wrong
    // by however long the process has been running.
    expect(value(body, 'administrative_dataset_age_seconds')).toBeGreaterThanOrEqual(0);
    expect(value(body, 'administrative_boundary_units', { level: 'COMMUNE' })).toBe(3);
    expect(value(body, 'administrative_datasets', { state: 'PUBLISHED' })).toBe(1);
  });

  it('counts the review backlog and the remediation categories', async () => {
    await insertPlace({
      administrativeMappingStatus: 'NEEDS_REVIEW',
      // The check constraint: a mapped place must say which dataset mapped it.
      administrativeDatasetVersion: datasetVersion,
    });
    await insertPlace({ status: 'published' });
    const body = await scrape();
    expect(value(body, 'administrative_mappings', { status: 'NEEDS_REVIEW' })).toBe(1);
    expect(value(body, 'administrative_mappings', { status: 'UNMAPPED' })).toBe(1);
    expect(value(body, 'administrative_remediation', { category: 'unmapped' })).toBe(1);
  });

  it('says publication is blocked when no dataset is published', async () => {
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'ROLLED_BACK' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    try {
      const body = await scrape();
      expect(value(body, 'administrative_dataset_active')).toBe(0);
      expect(value(body, 'administrative_publication_enabled')).toBe(0);

      const capability = (
        await get('/v1/cms/administrative-datasets/capability', 'ops_admin')
      ).json();
      expect(capability.dataset.state).toBe('MISSING');
      expect(capability.resolver).toBe('UNAVAILABLE');
      expect(capability.publication).toBe('BLOCKED');

      // And the API is still perfectly ready: a missing dataset blocks place
      // approval through the domain guard, not by taking the service offline.
      const health = await api().inject({ method: 'GET', url: '/v1/health/ready' });
      expect(health.statusCode).toBe(200);
    } finally {
      await db
        .update(schema.administrativeDatasetVersions)
        .set({ status: 'PUBLISHED' })
        .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    }
  });

  it('reports PARTIAL resolver capability when no boundary release is loaded', async () => {
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ boundarySourceVersion: 'not-loaded' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    try {
      const capability = (
        await get('/v1/cms/administrative-datasets/capability', 'ops_admin')
      ).json();
      expect(capability.boundaries.state).toBe('MISSING');
      // Not UNAVAILABLE: without polygons the resolver still answers from
      // explicit codes, stored names and the change mapping.
      expect(capability.resolver).toBe('PARTIAL');
      expect(capability.publication).toBe('ENABLED');
    } finally {
      await db
        .update(schema.administrativeDatasetVersions)
        .set({ boundarySourceVersion: BOUNDARY_VERSION })
        .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    }
  });

  it('carries the exact versions on the capability endpoint, not in a label', async () => {
    const capability = (
      await get('/v1/cms/administrative-datasets/capability', 'ops_admin')
    ).json();
    expect(capability.dataset.version).toBe(datasetVersion);
    expect(capability.boundaries.version).toBe(BOUNDARY_VERSION);

    const body = await scrape();
    // A version label would mint a new series on every publication.
    expect(body).not.toContain(datasetVersion);
    expect(body).not.toContain(BOUNDARY_VERSION);
  });
});

describe('counters describe what happened', () => {
  it('records a resolver run by status, method and confidence class', async () => {
    const before = await scrape();
    const place = await insertPlace();
    await app.get(AdministrativeResolverService).resolvePlace(place.id);
    const after = await scrape();

    expect(
      value(after, 'administrative_resolver_runs_total', {
        status: 'AUTO_MATCHED',
        method: 'boundary_point_in_polygon',
      }),
    ).toBe(
      value(before, 'administrative_resolver_runs_total', {
        status: 'AUTO_MATCHED',
        method: 'boundary_point_in_polygon',
      }) + 1,
    );
    expect(
      value(after, 'administrative_boundary_matches_total', { outcome: 'strict_inside' }),
    ).toBe(
      value(before, 'administrative_boundary_matches_total', { outcome: 'strict_inside' }) + 1,
    );
    expect(
      value(after, 'administrative_resolver_confidence_total', { class: 'definitional' }),
    ).toBe(
      value(before, 'administrative_resolver_confidence_total', { class: 'definitional' }) + 1,
    );
  });

  it('tells a shared edge apart from an overlap, and both from a miss', async () => {
    const [edge] = await rows<{ lng: number; lat: number }>(sql`
      select st_x(p) as lng, st_y(p) as lat from (
        select st_pointonsurface(st_intersection(a.geom, b.geom)) as p
        from administrative_unit_boundaries a
        join administrative_unit_boundaries b
          on b.boundary_version = a.boundary_version and b.code = '00008'
        where a.boundary_version = ${BOUNDARY_VERSION} and a.code = '00004') s`);
    const before = await scrape();
    const shared = await insertPlace({ geom: { x: edge!.lng, y: edge!.lat } });
    const missing = await insertPlace({ geom: { x: 106.7, y: 10.77 } });
    const resolver = app.get(AdministrativeResolverService);
    await resolver.resolvePlace(shared.id);
    await resolver.resolvePlace(missing.id);
    const after = await scrape();

    expect(value(after, 'administrative_boundary_matches_total', { outcome: 'shared_edge' })).toBe(
      value(before, 'administrative_boundary_matches_total', { outcome: 'shared_edge' }) + 1,
    );
    expect(value(after, 'administrative_boundary_matches_total', { outcome: 'no_match' })).toBe(
      value(before, 'administrative_boundary_matches_total', { outcome: 'no_match' }) + 1,
    );
    // And the durations were observed, not merely the counts.
    expect(after).toContain('administrative_pip_duration_seconds_count');
  });

  it('counts an approval block by its closed reason, and a success as allowed', async () => {
    const blocked = await insertPlace();
    const before = await scrape();
    const refused = await send('PATCH', `/v1/cms/places/${blocked.id}/status`, 'editor', {
      status: 'published',
    });
    expect(refused.statusCode).toBe(409);
    const after = await scrape();
    expect(
      value(after, 'place_approval_checks_total', {
        result: 'blocked',
        reason: 'MAPPING_UNMAPPED',
      }),
    ).toBe(
      value(before, 'place_approval_checks_total', {
        result: 'blocked',
        reason: 'MAPPING_UNMAPPED',
      }) + 1,
    );
  });

  it('counts a moderator action without naming the moderator', async () => {
    const place = await insertPlace();
    const before = await scrape();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'moderator',
      {
        provinceCode: '01',
        communeCode: '00004',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(201);
    const after = await scrape();
    expect(
      value(after, 'administrative_moderation_actions_total', { action: 'verify', result: 'ok' }),
    ).toBe(
      value(before, 'administrative_moderation_actions_total', { action: 'verify', result: 'ok' }) +
        1,
    );
    expect(after).not.toContain(adminIds.moderator!);
  });

  it('records a dataset lifecycle operation and every gate it fired', async () => {
    // A *staged* dataset: validating the published one would demote it, since
    // validation is what moves a dataset to VALIDATED.
    const staged = await new AdministrativeImportService(db).importPinnedSnapshot({
      overrideRevision: 7,
    });
    const before = await scrape();
    await app.get(AdministrativeValidationService).validate(staged.datasetVersionId);
    const after = await scrape();

    expect(
      value(after, 'administrative_dataset_operations_total', {
        operation: 'validate',
        result: 'succeeded',
      }),
    ).toBe(
      value(before, 'administrative_dataset_operations_total', {
        operation: 'validate',
        result: 'succeeded',
      }) + 1,
    );
    expect(after).toContain('administrative_dataset_operation_duration_seconds_count');
    // The pinned dataset trips exactly two warning gates, and each is its own
    // series — which is what makes "validation regressed" alertable by gate.
    expect(
      value(after, 'administrative_validation_findings_total', {
        gate: 'SOURCE_FORMATTING',
        severity: 'WARNING',
      }),
    ).toBeGreaterThan(0);
    expect(
      value(after, 'administrative_validation_findings_total', {
        gate: 'UNRESOLVED_CHANGES',
        severity: 'WARNING',
      }),
    ).toBeGreaterThan(0);
    expect(value(after, 'administrative_validation_findings_total', { severity: 'ERROR' })).toBe(0);
  }, 120_000);
});

describe('no label carries an identity', () => {
  it('exposes no place id, admin id, dataset id, code or version anywhere in a label', async () => {
    const place = await insertPlace();
    await app.get(AdministrativeResolverService).resolvePlace(place.id);
    await send('POST', `/v1/cms/places/${place.id}/administrative-mapping/verify`, 'moderator', {
      provinceCode: '01',
      communeCode: '00004',
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    const body = await scrape();

    const labelBlobs = body
      .split('\n')
      .filter((line) => line.includes('{') && !line.startsWith('#'))
      .map((line) => line.slice(line.indexOf('{')));
    const joined = labelBlobs.join('\n');

    for (const identity of [place.id, adminIds.moderator!, datasetId, datasetVersion]) {
      expect(joined, `${identity} must not appear in a metric label`).not.toContain(identity);
    }
    // A UUID in any label at all is the shape of the mistake, so it is caught
    // generically rather than only for the ids this test happens to know.
    expect(joined).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('keeps every administrative label inside its declared set', async () => {
    const body = await scrape();
    const allowed: Record<string, string[]> = {
      administrative_mappings: [
        'UNMAPPED',
        'AUTO_MATCHED',
        'NEEDS_REVIEW',
        'VERIFIED',
        'REJECTED',
        'STALE',
      ],
      administrative_datasets: ['STAGED', 'VALIDATED', 'REJECTED', 'PUBLISHED', 'ROLLED_BACK'],
      administrative_boundary_units: ['PROVINCE', 'COMMUNE'],
      administrative_remediation: [
        'unmapped',
        'auto_matched',
        'needs_review',
        'rejected',
        'stale',
        'verified_against_older_version',
        'compliant',
      ],
    };
    for (const [metric, values] of Object.entries(allowed)) {
      for (const sample of samples(body, metric)) {
        const label = Object.values(sample.labels)[0]!;
        expect(values, `${metric} label ${label}`).toContain(label);
      }
    }
  });
});

describe('the zero-cost invariant, measured on the real meters', () => {
  it('does not move the provider or Upstash counters across the whole surface', async () => {
    // Asserted on the meters that could actually move, rather than on a
    // permanent zero-only counter that would tell an operator nothing.
    const before = await scrape();
    const google = value(before, 'places_provider_requests_total');
    const upstash = value(before, 'provider_requests_total', { provider: 'upstash' });

    const place = await insertPlace();
    await get('/v1/administrative/provinces');
    await get('/v1/administrative/search?query=ba');
    await get('/v1/cms/administrative-datasets', 'ops_admin');
    await get('/v1/cms/administrative-datasets/capability', 'ops_admin');
    await get('/v1/cms/administrative-mappings', 'moderator');
    await get(`/v1/cms/places/${place.id}/administrative-mapping`, 'moderator');
    await app.get(AdministrativeResolverService).resolvePlace(place.id);
    await send('POST', `/v1/cms/places/${place.id}/administrative-mapping/verify`, 'moderator', {
      provinceCode: '01',
      communeCode: '00004',
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });

    const after = await scrape();
    expect(value(after, 'places_provider_requests_total')).toBe(google);
    expect(value(after, 'provider_requests_total', { provider: 'upstash' })).toBe(upstash);
  });

  it('declares no permanent zero-only counter of its own', async () => {
    const body = await scrape();
    // A counter that can only ever read zero implies somebody is checking, and
    // nobody is. The guarantee lives in the test above and in the two alert
    // rules on the real meters.
    expect(body).not.toContain('administrative_google_requests_total');
    expect(body).not.toContain('administrative_upstash_commands_total');
  });
});
