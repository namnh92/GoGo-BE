import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import { NoopMetrics } from '@gogo/observability';
import {
  ADMINISTRATIVE_DATASET,
  AdministrativePublicationService,
  AdministrativeValidationService,
  type AdministrativeDatasetPort,
} from '@gogo/modules';

/**
 * ADM-005 (#458) — the staff lifecycle against the real pinned dataset.
 *
 * Almost every test here is an attempt to make an unvalidated, drifted or
 * half-edited dataset become the country's active administrative data, and the
 * assertions are about what the server refuses. The happy path is three tests;
 * the rest are the reasons publication is not a status update.
 *
 * The tests run in file order and share state deliberately: publication is a
 * sequence — import, validate, publish, roll back — and a truncate between each
 * step would test the steps without testing the sequence.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.73.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const tokens: Record<string, string> = {};

type Role = 'editor' | 'moderator' | 'ops_admin' | 'super_admin';

const get = (url: string, role?: Role) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    ...(role ? { headers: { authorization: `Bearer ${tokens[role]}` } } : {}),
  });

function post(
  url: string,
  role?: Role,
  options: { payload?: Record<string, unknown>; idempotencyKey?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (role) headers.authorization = `Bearer ${tokens[role]}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return api().inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers,
    payload: options.payload ?? {},
  });
}

const BASE = '/v1/cms/administrative-datasets';

type Dataset = { id: string; version: string };

/** Assigned in file order; every test that reads one runs after its import. */
let r0!: Dataset;
let r1!: Dataset;
let r2!: Dataset;

async function createAdmin(role: Role) {
  const email = `adm005-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db.insert(schema.adminUsers).values({ email, passwordHash, displayName: role, role });
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

async function rows() {
  return db
    .select()
    .from(schema.administrativeDatasetVersions)
    .orderBy(schema.administrativeDatasetVersions.importedAt);
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db
    .select({ status: schema.administrativeDatasetVersions.status })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.id, id));
  return row!.status;
}

async function activeIds(): Promise<string[]> {
  const found = await db
    .select({ id: schema.administrativeDatasetVersions.id })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'));
  return found.map((r) => r.id);
}

async function lastAudit(action: string) {
  const [row] = await db
    .select()
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.action, action),
        eq(schema.auditLogs.resourceType, 'administrative_dataset'),
      ),
    )
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(1);
  return row;
}

/** Every place row, verbatim, for the "nothing was rewritten" assertions. */
async function placesSnapshot(): Promise<string> {
  const found = await db.select().from(schema.places).orderBy(schema.places.id);
  return JSON.stringify(found);
}

async function importDataset(overrideRevision: number) {
  const res = await post(`${BASE}/import`, 'ops_admin', { payload: { overrideRevision } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.datasetVersionId as string, version: body.combinedDatasetVersion as string };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_admin_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
    await createAdmin(role);
  }
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('RBAC', () => {
  const someId = '00000000-0000-4000-8000-000000000000';

  it.each([
    ['POST', `${BASE}/import`],
    ['POST', `${BASE}/${someId}/validate`],
    ['POST', `${BASE}/${someId}/publish`],
    ['POST', `${BASE}/${someId}/rollback`],
  ])('refuses %s %s to an editor', async (_method, url) => {
    // The role model is not extended for this work: editors curate the catalog,
    // and the country's administrative geography is not the catalog.
    expect((await post(url, 'editor')).statusCode).toBe(403);
  });

  it('refuses reads to editor and moderator, allows them to ops_admin', async () => {
    expect((await get(BASE, 'editor')).statusCode).toBe(403);
    expect((await get(BASE, 'moderator')).statusCode).toBe(403);
    expect((await get(BASE, 'ops_admin')).statusCode).toBe(200);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await post(`${BASE}/import`)).statusCode).toBe(401);
    expect((await get(BASE)).statusCode).toBe(401);
  });
});

describe('import', () => {
  it('writes a STAGED version and nothing else', async () => {
    r0 = await importDataset(0);
    expect(await statusOf(r0.id)).toBe('STAGED');
    expect(await activeIds()).toEqual([]);
  });

  it('audits the import with its sources and counts', async () => {
    const audit = await lastAudit('administrative_dataset.import');
    expect(audit?.resourceId).toBe(r0.id);
    const diff = audit!.diff as {
      sources: { currentSourceVersion: string };
      counts: { communes: number };
    };
    expect(diff.sources.currentSourceVersion).toBe('v5.0.0');
    expect(diff.counts.communes).toBe(3321);
  });

  it('refuses a re-import of byte-identical sources', async () => {
    // The same inputs are the same dataset. A second copy would be a second row
    // with the same identity and publication would have to choose between them.
    const res = await post(`${BASE}/import`, 'ops_admin', { payload: { overrideRevision: 0 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DATASET_ALREADY_IMPORTED');
    expect((await rows()).length).toBe(1);
  });
});

describe('publication refuses before it is entitled to succeed', () => {
  it('refuses to publish a dataset nobody validated', async () => {
    const res = await post(`${BASE}/${r0.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DATASET_NOT_VALIDATED');
    expect(await activeIds()).toEqual([]);
  });

  it('audits the refusal with its reason', async () => {
    // The refused attempt is exactly the event worth finding later.
    const audit = await lastAudit('administrative_dataset.publish_rejected');
    expect(audit?.resourceId).toBe(r0.id);
    expect((audit!.diff as { reason: string }).reason).toBe('DATASET_NOT_VALIDATED');
  });

  it('refuses to roll back to a dataset that was never published', async () => {
    const res = await post(`${BASE}/${r0.id}/rollback`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DATASET_NEVER_PUBLISHED');
  });

  it('serves no public administrative data while only a STAGED version exists', async () => {
    // Not an empty list — an empty list would read as "Vietnam has no
    // provinces". Staging is not a soft launch.
    const res = await get('/v1/administrative/version');
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('ADMINISTRATIVE_DATASET_UNAVAILABLE');
  });
});

describe('validate', () => {
  it('runs every gate and binds the result to this exact snapshot', async () => {
    const res = await post(`${BASE}/${r0.id}/validate`, 'ops_admin');
    expect(res.statusCode).toBe(201);
    const { validation, diff } = res.json();

    expect(validation.errors).toBe(0);
    expect(validation.publishable).toBe(true);
    expect(validation.findings.map((f: { gate: string }) => f.gate).sort()).toEqual([
      'SOURCE_FORMATTING',
      'UNRESOLVED_CHANGES',
    ]);
    expect(validation.boundTo).toMatchObject({
      datasetVersionId: r0.id,
      combinedDatasetVersion: r0.version,
      overrideRevision: 0,
    });
    expect(validation.boundTo.snapshotFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(validation.validationId).toMatch(/^[0-9a-f]{32}$/);
    expect(await statusOf(r0.id)).toBe('VALIDATED');

    // First publication: an explicitly empty baseline, not an error.
    expect(diff.fromVersion).toBeNull();
    expect(diff.countsByCategory.CREATED).toBe(14149);
  });

  it('is deterministic — re-validating replaces the result with an identical one', async () => {
    const first = (await post(`${BASE}/${r0.id}/validate`, 'ops_admin')).json();
    const second = (await post(`${BASE}/${r0.id}/validate`, 'ops_admin')).json();
    expect(second.validation.validationId).toBe(first.validation.validationId);
    expect(second.validation.boundTo).toEqual(first.validation.boundTo);
  });

  it('pages the diff entries while keeping every count complete', async () => {
    const page = (await get(`${BASE}/${r0.id}/diff?limit=5&offset=10`, 'ops_admin')).json();
    expect(page.entries).toHaveLength(5);
    expect(page.pagination).toMatchObject({ offset: 10, limit: 5, hasMore: true });
    expect(page.countsByCategory.CREATED).toBe(14149);
    expect(page.pagination.totalEntries).toBe(
      Object.values(page.countsByCategory as Record<string, number>).reduce((a, b) => a + b, 0),
    );
  });
});

describe('publish', () => {
  it('makes the version active, atomically and exactly once', async () => {
    const res = await post(`${BASE}/${r0.id}/publish`, 'ops_admin', {
      idempotencyKey: 'adm005-publish-r0',
    });
    // 201, like every other POST action in this API: the repository lets Nest's
    // default stand rather than hand-setting 200, and the idempotency replay
    // below returns the same status only because of that.
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      datasetVersionId: r0.id,
      previousActiveVersion: null,
      cacheWarmed: true,
    });
    // Two warning gates fired, carrying 1,034 rows between them. Visible and
    // audited; neither blocked anything.
    expect(body.warnings).toBe(2);
    expect(body.warningGates.sort()).toEqual(['SOURCE_FORMATTING', 'UNRESOLVED_CHANGES']);
    expect(await activeIds()).toEqual([r0.id]);
  });

  it('records the audit row a reviewer would look for', async () => {
    const audit = await lastAudit('administrative_dataset.publish');
    const diff = audit!.diff as Record<string, any>;
    expect(audit?.resourceId).toBe(r0.id);
    expect(audit?.actorType).toBe('admin');
    expect(diff.previousActiveVersion).toBeNull();
    expect(diff.combinedChecksum).toHaveLength(64);
    expect(diff.validation.validatorVersion).toBe('adm-004.1');
    expect(diff.idempotencyKey).toBe('adm005-publish-r0');
    expect(diff.diff.countsByCategory.CREATED).toBe(14149);
  });

  it('serves the published version publicly, and only that version', async () => {
    const res = await get('/v1/administrative/version');
    expect(res.statusCode).toBe(200);
    expect(res.json().datasetVersion).toBe(r0.version);
  });

  it('replays an identical request carrying the same Idempotency-Key', async () => {
    const res = await post(`${BASE}/${r0.id}/publish`, 'ops_admin', {
      idempotencyKey: 'adm005-publish-r0',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-idempotent-replay']).toBe('true');
    expect(res.json().datasetVersionId).toBe(r0.id);
  });

  it('refuses to republish the active version, rather than silently doing nothing', async () => {
    const res = await post(`${BASE}/${r0.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DATASET_ALREADY_PUBLISHED');
    expect(await activeIds()).toEqual([r0.id]);
  });
});

describe('a validation result stops being evidence the moment anything moves', () => {
  beforeAll(async () => {
    r1 = await importDataset(1);
    expect((await post(`${BASE}/${r1.id}/validate`, 'ops_admin')).statusCode).toBe(201);
  }, 120_000);

  it('refuses when the override revision moved after validation', async () => {
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ overrideRevision: 5 })
      .where(eq(schema.administrativeDatasetVersions.id, r1.id));

    const res = await post(`${BASE}/${r1.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('VALIDATION_STALE');
    expect(res.json().message).toContain('override revision');

    await db
      .update(schema.administrativeDatasetVersions)
      .set({ overrideRevision: 1 })
      .where(eq(schema.administrativeDatasetVersions.id, r1.id));
  });

  it('refuses when a staged row was edited underneath an unchanged checksum', async () => {
    // The combined checksum is computed from the pinned files, so it cannot see
    // this. The fingerprint is the reason the edit is caught at all.
    await db.execute(sql`
      update administrative_units set full_name = full_name || ' (edited)'
      where dataset_version_id = ${r1.id} and code = '00004'`);

    const res = await post(`${BASE}/${r1.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('VALIDATION_STALE');
    expect(res.json().message).toContain('staged rows');

    // Re-validating re-binds to the rows as they now are.
    expect((await post(`${BASE}/${r1.id}/validate`, 'ops_admin')).statusCode).toBe(201);
  });

  it('refuses when the pinned sources no longer produce this version', async () => {
    const [before] = await db
      .select({ v: schema.administrativeDatasetVersions.currentSourceVersion })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, r1.id));
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ currentSourceVersion: 'v9.9.9' })
      .where(eq(schema.administrativeDatasetVersions.id, r1.id));

    const res = await post(`${BASE}/${r1.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SNAPSHOT_CHECKSUM_MISMATCH');

    await db
      .update(schema.administrativeDatasetVersions)
      .set({ currentSourceVersion: before!.v })
      .where(eq(schema.administrativeDatasetVersions.id, r1.id));
  });

  it('leaves the active version untouched through every refusal', async () => {
    expect(await activeIds()).toEqual([r0.id]);
  });
});

describe('failure inside the transaction leaves the old version active', () => {
  it('fails rather than waiting forever, and changes nothing', async () => {
    // A separate connection holds the row publication must demote. The
    // transaction's `lock_timeout` fires, the transaction rolls back, and the
    // dataset that was active still is.
    const blocker = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
    const client = await blocker.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from administrative_dataset_versions where id = $1 for update', [
        r0.id,
      ]);
      const res = await post(`${BASE}/${r1.id}/publish`, 'ops_admin');
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await client.query('rollback');
      client.release();
      await blocker.end();
    }
    expect(await activeIds()).toEqual([r0.id]);
    expect(await statusOf(r1.id)).toBe('VALIDATED');
  }, 60_000);

  it('rolls the publication back when its audit row cannot be written', async () => {
    // The audit is written inside the publishing transaction, so a publication
    // nobody can see in the audit log does not survive on its own. Forced here
    // by an actor id the audit column cannot store.
    const service = new AdministrativePublicationService(
      db,
      app.get<AdministrativeDatasetPort>(ADMINISTRATIVE_DATASET),
      app.get(AdministrativeValidationService),
      new NoopMetrics(),
    );
    await expect(service.publish(r1.id, { id: 'not-a-uuid', type: 'admin' })).rejects.toThrow();
    expect(await activeIds()).toEqual([r0.id]);
    expect(await statusOf(r1.id)).toBe('VALIDATED');
  });
});

describe('the cache is downstream of the commit, never upstream', () => {
  it('publishes even when the local pointer cannot be refilled', async () => {
    // PostgreSQL is authoritative for the active version; the in-process
    // pointer is a memo of what it said. Rolling back a published dataset
    // because a local map did not refill would be the tail wagging the dog.
    const broken: AdministrativeDatasetPort = {
      active: () => Promise.reject(new Error('cache is down')),
      invalidateActiveVersion: () => undefined,
    };
    const service = new AdministrativePublicationService(
      db,
      broken,
      app.get(AdministrativeValidationService),
      new NoopMetrics(),
    );
    const result = await service.publish(r1.id, { id: null, type: 'system' });
    expect(result.cacheWarmed).toBe(false);
    expect(result.previousActiveVersion).toBe(r0.version);
    expect(await activeIds()).toEqual([r1.id]);

    // The application's own cache still points at the old version until it is
    // told otherwise — which is the 60-second TTL, made explicit here.
    app.get<AdministrativeDatasetPort>(ADMINISTRATIVE_DATASET).invalidateActiveVersion();
    expect((await get('/v1/administrative/version')).json().datasetVersion).toBe(r1.version);
  });

  it('retains the superseded version rather than deleting it', async () => {
    expect(await statusOf(r0.id)).toBe('ROLLED_BACK');
    const [row] = await db
      .select({ publishedAt: schema.administrativeDatasetVersions.publishedAt })
      .from(schema.administrativeDatasetVersions)
      .where(eq(schema.administrativeDatasetVersions.id, r0.id));
    expect(row!.publishedAt).not.toBeNull();
  });
});

describe('rollback', () => {
  let before: string;

  beforeAll(async () => {
    await db.insert(schema.places).values([
      {
        name: 'Quán Ba Đình',
        nameNormalized: 'quan ba dinh',
        geom: { x: 105.8342, y: 21.0355 },
        addressText: '1 Phan Đình Phùng',
        communeCode: '00004',
        provinceCode: '01',
        administrativeMappingStatus: 'AUTO_MATCHED',
        administrativeDatasetVersion: r0.version,
      },
      {
        name: 'Quán Không Rõ',
        nameNormalized: 'quan khong ro',
        geom: { x: 106.7009, y: 10.7769 },
        addressText: '12 Lê Lợi',
        communeCode: '99999',
        administrativeMappingStatus: 'VERIFIED',
        administrativeDatasetVersion: r0.version,
      },
    ]);
    before = await placesSnapshot();
  });

  it('restores the previously published version and reports its impact', async () => {
    const res = await post(`${BASE}/${r0.id}/rollback`, 'ops_admin', {
      idempotencyKey: 'adm005-rollback-r0',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.previousActiveVersion).toBe(r1.version);
    expect(body.diff.affectedPlaces.total).toBeGreaterThanOrEqual(1);
    expect(body.diff.affectedPlaces.sampleLimit).toBe(20);
    // The place claiming a code no dataset holds is reported, not rewritten.
    expect(body.staleMappings.total).toBe(1);
    expect(body.staleMappings.samples[0]).toMatchObject({ code: '99999', status: 'VERIFIED' });
  });

  it('leaves exactly one active version, and it is the restored one', async () => {
    expect(await activeIds()).toEqual([r0.id]);
    expect(await statusOf(r1.id)).toBe('ROLLED_BACK');
  });

  it('writes an audit row of its own — it is a forward act, not an undo', async () => {
    const audit = await lastAudit('administrative_dataset.rollback');
    const diff = audit!.diff as Record<string, any>;
    expect(audit?.resourceId).toBe(r0.id);
    expect(diff.previousActiveVersion).toBe(r1.version);
    expect(diff.staleMappings).toBe(1);
    expect(diff.restoredFirstPublishedAt).not.toBeNull();
  });

  it('leaves every place byte-identical', async () => {
    // Publication and rollback do not touch places. Whether a stale claim
    // should be demoted — and a VERIFIED claim never silently — is the mapping
    // work's decision (#459/#461/#462), not a side effect of a version switch.
    expect(await placesSnapshot()).toBe(before);
  });

  it('refuses to restore a version whose stored rows were tampered with', async () => {
    await db.execute(sql`
      update administrative_units set name = 'tampered'
      where dataset_version_id = ${r1.id} and code = '01'`);
    const res = await post(`${BASE}/${r1.id}/rollback`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DATASET_CORRUPTED');
    expect(await activeIds()).toEqual([r0.id]);
  });
});

describe('concurrent publication', () => {
  it('has exactly one winner and a refusal for the loser', async () => {
    const target = await importDataset(2);
    r2 = target;
    expect((await post(`${BASE}/${target.id}/validate`, 'ops_admin')).statusCode).toBe(201);

    const [a, b] = await Promise.all([
      post(`${BASE}/${target.id}/publish`, 'ops_admin'),
      post(`${BASE}/${target.id}/publish`, 'ops_admin'),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(['DATASET_ALREADY_PUBLISHED', 'ACTIVE_VERSION_CHANGED']).toContain(refused.json().code);
    expect(await activeIds()).toEqual([target.id]);
  }, 120_000);
});

describe('ERROR cannot be overridden', () => {
  it('refuses a dataset whose gates failed, even with the status flipped by hand', async () => {
    const target = await importDataset(3);
    // A commune whose province is not in the dataset: an ERROR gate, and a real
    // one — this is what a bad merge of two sources looks like.
    await db.execute(sql`
      update administrative_units set parent_code = '77'
      where dataset_version_id = ${target.id} and code = '00004'`);

    const validated = await post(`${BASE}/${target.id}/validate`, 'ops_admin');
    expect(validated.json().validation.publishable).toBe(false);
    expect(validated.json().validation.errors).toBeGreaterThan(0);
    // A failed check is not a rejection: the version stays STAGED so a fixed
    // source can be re-validated without a status being undone by hand.
    expect(await statusOf(target.id)).toBe('STAGED');

    // The status is not the evidence. Flipping it by hand — a psql session, a
    // future admin tool — must not buy a publication.
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'VALIDATED' })
      .where(eq(schema.administrativeDatasetVersions.id, target.id));

    const res = await post(`${BASE}/${target.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('VALIDATION_HAS_ERRORS');
    expect(res.json().message).toContain('cannot be overridden');
    expect(await activeIds()).toEqual([r2.id]);
  }, 120_000);
});

describe('the whole surface issues no Redis command', () => {
  it('reads, validates and refuses without touching Upstash', async () => {
    // ADR-0019 §8: the administrative cache is in-process by decision, and
    // Upstash bills per command.
    const before = await metricCount('upstash');
    expect((await get(BASE, 'ops_admin')).statusCode).toBe(200);
    expect((await get(`${BASE}/${r2.id}`, 'ops_admin')).statusCode).toBe(200);
    expect((await get(`${BASE}/${r2.id}/diff`, 'ops_admin')).statusCode).toBe(200);
    expect((await get(`${BASE}/restorable`, 'ops_admin')).statusCode).toBe(200);
    expect((await post(`${BASE}/${r2.id}/publish`, 'ops_admin')).statusCode).toBe(409);
    expect(await metricCount('upstash')).toBe(before);
  });
});

/** Sums `provider_requests_total` samples whose labels mention a provider. */
async function metricCount(provider: string): Promise<number> {
  // `/v1/metrics`, not `/metrics`: the app sets a global `v1` prefix, and an
  // earlier version of this helper asked for the unprefixed path, got a 404 and
  // returned 0 — so every "the provider counter did not move" assertion built
  // on it was comparing zero to zero. It throws now rather than answering 0,
  // because a scrape that cannot be read is not evidence of anything.
  const metrics = await api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  if (metrics.statusCode !== 200) {
    throw new Error(
      `metrics scrape failed with ${metrics.statusCode}; the assertion would be vacuous`,
    );
  }
  return metrics.body
    .split('\n')
    .filter((line) => line.startsWith('provider_requests_total') && line.includes(provider))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
