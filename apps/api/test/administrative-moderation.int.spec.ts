import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import {
  AdministrativeBoundaryImportService,
  AdministrativeImportService,
  AdministrativeResolverService,
  evaluatePlaceApproval,
  publicationOutcomeFor,
} from '@gogo/modules';

/**
 * ADM-009 (#462) — mapping moderation and the place approval policy.
 *
 * The approval tests go through the real `PATCH /cms/places/{id}/status`
 * endpoint rather than calling the policy directly, because the whole point of
 * this task is that the gate sits at the authoritative state transition and not
 * in a controller a second caller could route around.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let datasetId: string;
let datasetVersion: string;

const BOUNDARY_VERSION = 'fixture-v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.77.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const tokens: Record<string, string> = {};
const adminIds: Record<string, string> = {};

type Role = 'editor' | 'moderator' | 'ops_admin' | 'super_admin';

const get = (url: string, role?: Role) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    ...(role ? { headers: { authorization: `Bearer ${tokens[role]}` } } : {}),
  });

function send(
  method: 'POST' | 'PATCH',
  url: string,
  role: Role | undefined,
  payload: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {};
  if (role) headers.authorization = `Bearer ${tokens[role]}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  return api().inject({ method, url, remoteAddress: ip(), headers, payload });
}

async function createAdmin(role: Role) {
  const email = `adm009-${role}@gogo.local`;
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
      name: 'Quán Thử',
      nameNormalized: 'quan thu',
      geom: { x: inside.lng, y: inside.lat },
      addressText: '19 Lê Hồng Phong',
      city: 'Hà Nội',
      district: 'Ba Đình',
      status: 'review',
      ...over,
    })
    .returning();
  return row!;
}

async function placeRow(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}

/** Everything moderation must never rewrite. */
function originals(row: Record<string, unknown>) {
  return {
    name: row.name,
    addressText: row.addressText,
    city: row.city,
    district: row.district,
    geom: row.geom,
    areaKey: row.areaKey,
  };
}

async function auditRows(action: string, placeId?: string) {
  const conditions = [eq(schema.auditLogs.action, action)];
  if (placeId) conditions.push(eq(schema.auditLogs.resourceId, placeId));
  return db
    .select()
    .from(schema.auditLogs)
    .where(and(...conditions));
}

/** Verifies a place's mapping as the moderator, returning the fresh row. */
async function verify(placeId: string, codes = { provinceCode: '01', communeCode: '00004' }) {
  const place = await placeRow(placeId);
  const res = await send(
    'POST',
    `/v1/cms/places/${placeId}/administrative-mapping/verify`,
    'moderator',
    {
      ...codes,
      expectedUpdatedAt: place.updatedAt.toISOString(),
    },
  );
  expect(res.statusCode).toBe(201);
  return placeRow(placeId);
}

const approve = (placeId: string) =>
  send('PATCH', `/v1/cms/places/${placeId}/status`, 'editor', { status: 'published' });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_moderation_test')
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
  for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
    await createAdmin(role);
  }
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table places cascade`);
  await db.execute(sql`delete from audit_logs`);
});

describe('the approval policy sits at the state transition', () => {
  it('approves a place whose mapping a reviewer verified', async () => {
    const place = await insertPlace();
    await verify(place.id);
    const res = await approve(place.id);
    expect(res.statusCode).toBe(200);
    expect((await placeRow(place.id)).status).toBe('published');
  });

  it.each([
    ['UNMAPPED', 'MAPPING_UNMAPPED'],
    ['AUTO_MATCHED', 'MAPPING_NOT_VERIFIED'],
    ['NEEDS_REVIEW', 'MAPPING_NOT_VERIFIED'],
    ['REJECTED', 'MAPPING_REJECTED'],
    ['STALE', 'MAPPING_STALE'],
  ] as const)('refuses to approve a %s mapping (%s)', async (status, code) => {
    const place = await insertPlace({
      administrativeMappingStatus: status,
      ...(status === 'UNMAPPED'
        ? {}
        : {
            provinceCode: '01',
            communeCode: '00004',
            administrativeDatasetVersion: datasetVersion,
          }),
    });
    const res = await approve(place.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(code);
    expect((await placeRow(place.id)).status).toBe('review');
  });

  it('refuses a verified mapping whose hierarchy does not hold', async () => {
    const place = await insertPlace({
      administrativeMappingStatus: 'VERIFIED',
      provinceCode: '79',
      communeCode: '00004',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: adminIds.moderator!,
    });
    const res = await approve(place.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MAPPING_HIERARCHY_INVALID');
  });

  it('refuses when the mapping is rejected between the reviewer reading it and approving', async () => {
    const place = await insertPlace();
    const verified = await verify(place.id);
    // Another reviewer rejects it while the approve request is in flight.
    const rejected = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/reject`,
      'moderator',
      { reason: 'wrong ward', expectedUpdatedAt: verified.updatedAt.toISOString() },
    );
    expect(rejected.statusCode).toBe(201);

    const res = await approve(place.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MAPPING_REJECTED');
  });

  it('refuses when a new dataset publishes and no longer holds the commune', async () => {
    const place = await insertPlace();
    await verify(place.id);

    // A second dataset becomes active, and this commune is not in it.
    const second = await new AdministrativeImportService(db).importPinnedSnapshot({
      overrideRevision: 1,
    });
    await db.execute(sql`
      delete from administrative_units
      where dataset_version_id = ${second.datasetVersionId} and code = '00004' and level = 'COMMUNE'`);
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'ROLLED_BACK' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    await db
      .update(schema.administrativeDatasetVersions)
      .set({
        status: 'PUBLISHED',
        publishedAt: new Date(),
        boundarySourceVersion: BOUNDARY_VERSION,
      })
      .where(eq(schema.administrativeDatasetVersions.id, second.datasetVersionId));

    const res = await approve(place.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MAPPING_UNIT_NOT_CURRENT');

    // Put the original dataset back for the rest of the file.
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'ROLLED_BACK' })
      .where(eq(schema.administrativeDatasetVersions.id, second.datasetVersionId));
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'PUBLISHED' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    await db.execute(
      sql`delete from administrative_dataset_versions where id = ${second.datasetVersionId}`,
    );
  }, 180_000);

  it('leaves an already-approved unmapped place alone, and reports it', async () => {
    const place = await insertPlace({ status: 'published' });
    const report = await get('/v1/cms/administrative-mappings/remediation', 'moderator');
    expect(report.statusCode).toBe(200);
    expect(report.json().counts.unmapped).toBe(1);
    expect(report.json().samples.unmapped).toContain(place.id);
    // Reported, not rolled back: the policy was written after this place was
    // approved, and taking a working catalogue off the air to satisfy it would
    // do more harm than the gap it closes.
    expect((await placeRow(place.id)).status).toBe('published');
  });

  it('separates a verification made against an older dataset from a defect', async () => {
    const place = await insertPlace({ status: 'published' });
    await db
      .update(schema.places)
      .set({
        administrativeMappingStatus: 'VERIFIED',
        provinceCode: '01',
        communeCode: '00004',
        administrativeDatasetVersion: 'v4.9.0+older',
        administrativeMappedBy: adminIds.moderator!,
      })
      .where(eq(schema.places.id, place.id));

    const report = (await get('/v1/cms/administrative-mappings/remediation', 'moderator')).json();
    expect(report.counts.verified_against_older_version).toBe(1);
    expect(report.counts.compliant).toBe(0);

    // Reported, and still approvable: the identity is what the reviewer judged.
    await db
      .update(schema.places)
      .set({ status: 'suspended' })
      .where(eq(schema.places.id, place.id));
    expect((await approve(place.id)).statusCode).toBe(200);
  });
});

describe('manual verification', () => {
  it('writes VERIFIED with the reviewer, and rewrites no address field', async () => {
    const place = await insertPlace();
    const before = originals(place);
    const after = await verify(place.id);

    expect(originals(after)).toEqual(before);
    expect(after).toMatchObject({
      administrativeMappingStatus: 'VERIFIED',
      provinceCode: '01',
      communeCode: '00004',
      administrativeMappingSource: 'editor',
      administrativeDatasetVersion: datasetVersion,
      administrativeMappedBy: adminIds.moderator,
    });
    // No number: a person's judgement is not a probability.
    expect(after.administrativeMappingConfidence).toBeNull();
    expect(after.administrativeMappedAt).not.toBeNull();
  });

  it.each([
    [
      'a province that is not current',
      { provinceCode: '99', communeCode: '00004' },
      'PROVINCE_NOT_CURRENT',
    ],
    [
      'a commune that is not current',
      { provinceCode: '01', communeCode: '99999' },
      'COMMUNE_NOT_CURRENT',
    ],
    [
      'a pair that is not a pair',
      { provinceCode: '79', communeCode: '00004' },
      'HIERARCHY_INVALID',
    ],
  ])('refuses %s', async (_case, codes, code) => {
    const place = await insertPlace();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'moderator',
      {
        ...codes,
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(code);
    expect((await placeRow(place.id)).administrativeMappingStatus).toBe('UNMAPPED');
  });

  it('refuses a code that names only a period that has ended', async () => {
    // A code is not an identity: some commune codes exist only in the
    // historical set, and selecting one is selecting a unit that is gone.
    const [historical] = await rows<{ code: string }>(sql`
      select u.code from administrative_units u
      where u.dataset_version_id = ${datasetId} and u.level = 'COMMUNE' and u.effective_to is not null
        and not exists (
          select 1 from administrative_units c
          where c.dataset_version_id = u.dataset_version_id and c.code = u.code
            and c.status = 'ACTIVE' and c.effective_to is null)
      order by u.code limit 1`);
    const place = await insertPlace();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'moderator',
      {
        provinceCode: '01',
        communeCode: historical!.code,
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('COMMUNE_NOT_CURRENT');
  });

  it('refuses a decision made about a row that has since moved', async () => {
    const place = await insertPlace();
    const stale = new Date(place.updatedAt.getTime() - 1000).toISOString();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'moderator',
      {
        provinceCode: '01',
        communeCode: '00004',
        expectedUpdatedAt: stale,
      },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PLACE_MODIFIED');
  });

  it('records the reviewer selection in the audit row', async () => {
    const place = await insertPlace();
    await verify(place.id);
    const [audit] = await auditRows('administrative_mapping.verify', place.id);
    expect(audit?.actorId).toBe(adminIds.moderator);
    expect((audit!.diff as Record<string, any>).reviewerSelection).toMatchObject({
      provinceCode: '01',
      communeCode: '00004',
    });
    expect((audit!.diff as Record<string, any>).from.status).toBe('UNMAPPED');
  });
});

describe('rejecting the mapping is not rejecting the place', () => {
  it('requires a reason', async () => {
    const place = await insertPlace();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/reject`,
      'moderator',
      {
        reason: '   ',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(400);
  });

  it('leaves the place where it was, and keeps the rejected codes on the record', async () => {
    const place = await insertPlace();
    const verified = await verify(place.id);
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/reject`,
      'moderator',
      {
        reason: 'the ward boundary is wrong here',
        expectedUpdatedAt: verified.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(201);

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('REJECTED');
    expect(after.status).toBe('review');
    expect(originals(after)).toEqual(originals(place));

    const [audit] = await auditRows('administrative_mapping.reject', place.id);
    expect((audit!.diff as Record<string, any>).rejectedCodes.communeCode).toBe('00004');
    expect((audit!.diff as Record<string, any>).reason).toContain('boundary');
  });
});

describe('authenticated rematch', () => {
  it('reopens a rejected mapping, clears the reviewer, and keeps the history', async () => {
    const place = await insertPlace();
    const verified = await verify(place.id);
    await send('POST', `/v1/cms/places/${place.id}/administrative-mapping/reject`, 'moderator', {
      reason: 'wrong',
      expectedUpdatedAt: verified.updatedAt.toISOString(),
    });
    const rejected = await placeRow(place.id);
    expect(rejected.administrativeMappedBy).toBe(adminIds.moderator);

    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/rematch`,
      'moderator',
      {
        reason: 'the boundary release was updated',
        expectedUpdatedAt: rejected.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(201);

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('AUTO_MATCHED');
    // The requester has not verified anything, so nobody is credited.
    expect(after.administrativeMappedBy).toBeNull();

    const [audit] = await auditRows('administrative_mapping.rematch', place.id);
    const diff = audit!.diff as Record<string, any>;
    expect(diff.previousReviewer).toBe(adminIds.moderator);
    expect(diff.previousStatus).toBe('REJECTED');
    expect(diff.requestedBy).toBe(adminIds.moderator);
    expect(diff.reason).toContain('boundary release');
    // The rejection itself is still on the record, still attributed.
    expect(await auditRows('administrative_mapping.reject', place.id)).toHaveLength(1);
  });

  it('requires a reason', async () => {
    const place = await insertPlace();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/rematch`,
      'moderator',
      {
        reason: '',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(400);
  });

  it('refuses to re-derive a mapping a reviewer verified', async () => {
    const place = await insertPlace();
    const verified = await verify(place.id);
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/rematch`,
      'moderator',
      {
        reason: 'try again',
        expectedUpdatedAt: verified.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('VERIFIED_NOT_REMATCHABLE');
    expect((await placeRow(place.id)).administrativeMappingStatus).toBe('VERIFIED');
  });
});

describe('correcting a verified mapping', () => {
  it('names both people in the audit', async () => {
    const place = await insertPlace();
    const verified = await verify(place.id);
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/correct`,
      'super_admin',
      {
        provinceCode: '01',
        communeCode: '00008',
        reason: 'the previous reviewer picked the neighbouring ward',
        expectedUpdatedAt: verified.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(201);

    const after = await placeRow(place.id);
    expect(after.communeCode).toBe('00008');
    expect(after.administrativeMappedBy).toBe(adminIds.super_admin);

    const [audit] = await auditRows('administrative_mapping.correct', place.id);
    const diff = audit!.diff as Record<string, any>;
    expect(diff.previousReviewer).toBe(adminIds.moderator);
    expect(diff.previousCodes.communeCode).toBe('00004');
    expect(diff.correctedBy).toBe(adminIds.super_admin);
  });

  it('refuses to "correct" a mapping nobody verified', async () => {
    const place = await insertPlace();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/correct`,
      'moderator',
      {
        provinceCode: '01',
        communeCode: '00004',
        reason: 'x',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_VERIFIED');
  });
});

describe('staleness reconciliation', () => {
  it('does not mark a mapping stale merely because the version moved', async () => {
    const place = await insertPlace();
    await verify(place.id);
    await db
      .update(schema.places)
      .set({ administrativeDatasetVersion: 'v4.9.0+older' })
      .where(eq(schema.places.id, place.id));

    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/reconcile`,
      'ops_admin',
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      changed: false,
      verdict: { stale: false, reason: 'REVALIDATED' },
    });
    expect((await placeRow(place.id)).administrativeMappingStatus).toBe('VERIFIED');
  });

  it('marks a materially invalid mapping stale, keeping the codes and the reviewer', async () => {
    const place = await insertPlace();
    await verify(place.id);
    // The commune this reviewer chose is no longer in the active dataset.
    await db
      .update(schema.places)
      .set({ communeCode: '99999' })
      .where(eq(schema.places.id, place.id));

    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/reconcile`,
      'ops_admin',
    );
    expect(res.json()).toMatchObject({ changed: true, verdict: { stale: true } });

    const after = await placeRow(place.id);
    expect(after.administrativeMappingStatus).toBe('STALE');
    expect(after.communeCode).toBe('99999');
    // Kept: they did verify this mapping. STALE says that verification is no
    // longer current, not that it never happened — and the reconciler must
    // never be readable as the verifier.
    expect(after.administrativeMappedBy).toBe(adminIds.moderator);

    const [audit] = await auditRows('administrative_mapping.reconcile', place.id);
    const diff = audit!.diff as Record<string, any>;
    expect(audit!.actorId).toBe(adminIds.ops_admin);
    expect(diff.systemEvaluated).toBe(true);
    expect(diff.retainedReviewer).toBe(adminIds.moderator);
  });

  it('is idempotent', async () => {
    const place = await insertPlace();
    await verify(place.id);
    await db
      .update(schema.places)
      .set({ communeCode: '99999' })
      .where(eq(schema.places.id, place.id));
    await send('POST', `/v1/cms/places/${place.id}/administrative-mapping/reconcile`, 'ops_admin');
    const first = await placeRow(place.id);

    const second = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/reconcile`,
      'ops_admin',
    );
    expect(second.json().changed).toBe(false);
    expect((await placeRow(place.id)).updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(await auditRows('administrative_mapping.reconcile', place.id)).toHaveLength(1);
  });

  it('blocks approval once stale', async () => {
    const place = await insertPlace();
    await verify(place.id);
    await db
      .update(schema.places)
      .set({ communeCode: '99999' })
      .where(eq(schema.places.id, place.id));
    await send('POST', `/v1/cms/places/${place.id}/administrative-mapping/reconcile`, 'ops_admin');
    const res = await approve(place.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MAPPING_STALE');
  });
});

describe('the queue', () => {
  it('keeps an UNMAPPED place awaiting approval discoverable', async () => {
    const unmapped = await insertPlace();
    const verified = await insertPlace();
    await verify(verified.id);

    // The actionable default would hide it — there is nothing to decide about a
    // place the resolver could not place — so the blocked-approval view exists.
    const actionable = (
      await get('/v1/cms/administrative-mappings?status=NEEDS_REVIEW,STALE', 'moderator')
    ).json();
    expect(actionable.items).toHaveLength(0);

    const blocked = (
      await get('/v1/cms/administrative-mappings?blockedApprovalOnly=true', 'moderator')
    ).json();
    expect(blocked.items.map((i: { placeId: string }) => i.placeId)).toEqual([unmapped.id]);
    expect(blocked.items[0].blocksApproval).toBe(true);

    // And the counts say what the page is not showing.
    expect(blocked.counts).toMatchObject({ UNMAPPED: 1, VERIFIED: 1, actionable: 0 });
  });

  it('pages deterministically and bounds the page', async () => {
    for (let i = 0; i < 5; i += 1) await insertPlace();
    const first = (await get('/v1/cms/administrative-mappings?limit=2', 'moderator')).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await get(`/v1/cms/administrative-mappings?limit=2&cursor=${first.nextCursor}`, 'moderator')
    ).json();
    expect(second.items.map((i: { placeId: string }) => i.placeId)).not.toContain(
      first.items[0].placeId,
    );
  });

  it('returns the evidence and permitted actions the console needs', async () => {
    const place = await insertPlace();
    const detail = (
      await get(`/v1/cms/places/${place.id}/administrative-mapping`, 'moderator')
    ).json();
    expect(detail.place).toMatchObject({ addressText: '19 Lê Hồng Phong', city: 'Hà Nội' });
    expect(detail.activeDatasetVersion).toBe(datasetVersion);
    expect(detail.evidence.length).toBeGreaterThan(0);
    expect(detail.approval).toMatchObject({ blocked: true, block: { code: 'MAPPING_UNMAPPED' } });
    expect(detail.permittedActions).toContain('verify');
    expect(detail.staleness.reason).toBe('NO_MAPPING');
  });
});

describe('roles', () => {
  it('refuses an anonymous caller everywhere', async () => {
    const place = await insertPlace();
    expect((await get('/v1/cms/administrative-mappings')).statusCode).toBe(401);
    expect(
      (
        await send(
          'POST',
          `/v1/cms/places/${place.id}/administrative-mapping/verify`,
          undefined,
          {},
        )
      ).statusCode,
    ).toBe(401);
  });

  it('lets an editor read the queue but not decide', async () => {
    // Separation of duties: the person who decides a place belongs in the
    // catalogue is not the person who certifies where it is.
    const place = await insertPlace();
    expect((await get('/v1/cms/administrative-mappings', 'editor')).statusCode).toBe(200);
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'editor',
      {
        provinceCode: '01',
        communeCode: '00004',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(403);
  });

  it('keeps reconciliation with ops and verification with moderation', async () => {
    const place = await insertPlace();
    const verifyAsOps = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'ops_admin',
      {
        provinceCode: '01',
        communeCode: '00004',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(verifyAsOps.statusCode).toBe(403);
    expect(
      (
        await send(
          'POST',
          `/v1/cms/places/${place.id}/administrative-mapping/reconcile`,
          'moderator',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(
          'POST',
          `/v1/cms/places/${place.id}/administrative-mapping/reconcile`,
          'ops_admin',
        )
      ).statusCode,
    ).toBe(201);
  });

  it('lets super_admin through both, audibly', async () => {
    const place = await insertPlace();
    const res = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'super_admin',
      {
        provinceCode: '01',
        communeCode: '00004',
        expectedUpdatedAt: place.updatedAt.toISOString(),
      },
    );
    expect(res.statusCode).toBe(201);
    const [audit] = await auditRows('administrative_mapping.verify', place.id);
    expect(audit?.authorizationPath).toBe('super_admin_bypass');
  });
});

describe('idempotency, concurrency and failure', () => {
  it('replays a verification carrying the same Idempotency-Key', async () => {
    const place = await insertPlace();
    const body = {
      provinceCode: '01',
      communeCode: '00004',
      expectedUpdatedAt: place.updatedAt.toISOString(),
    };
    const first = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'moderator',
      body,
      'adm009-verify-1',
    );
    expect(first.statusCode).toBe(201);

    const replay = await send(
      'POST',
      `/v1/cms/places/${place.id}/administrative-mapping/verify`,
      'moderator',
      body,
      'adm009-verify-1',
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    // Replayed, not re-applied: one decision, one audit row.
    expect(await auditRows('administrative_mapping.verify', place.id)).toHaveLength(1);
  });

  it('lets one of two concurrent reviewers win, and tells the other', async () => {
    const place = await insertPlace();
    const body = (commune: string) => ({
      provinceCode: '01',
      communeCode: commune,
      expectedUpdatedAt: place.updatedAt.toISOString(),
    });
    const [a, b] = await Promise.all([
      send(
        'POST',
        `/v1/cms/places/${place.id}/administrative-mapping/verify`,
        'moderator',
        body('00004'),
      ),
      send(
        'POST',
        `/v1/cms/places/${place.id}/administrative-mapping/verify`,
        'super_admin',
        body('00008'),
      ),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().code).toBe('PLACE_MODIFIED');
    expect(await auditRows('administrative_mapping.verify', place.id)).toHaveLength(1);
  });

  it('rolls the decision back when its audit row cannot be written', async () => {
    // The audit is inside the decision's transaction, so a decision nobody can
    // see in the log does not survive on its own. Forced with an actor id the
    // column cannot store.
    const place = await insertPlace();
    const service = app.get(AdministrativeResolverService);
    expect(service).toBeDefined();
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(schema.places)
          .set({ administrativeMappingStatus: 'VERIFIED' })
          .where(eq(schema.places.id, place.id));
        await tx.insert(schema.auditLogs).values({
          actorType: 'admin',
          actorId: 'not-a-uuid',
          action: 'administrative_mapping.verify',
          resourceType: 'place',
          resourceId: place.id,
        });
      }),
    ).rejects.toThrow();
    expect((await placeRow(place.id)).administrativeMappingStatus).toBe('UNMAPPED');
  });

  it('issues no Google request and no Redis command across the whole surface', async () => {
    const google = await metricCount('places_provider_requests_total');
    const redis = await metricCount('provider_requests_total', 'upstash');
    const place = await insertPlace();
    await get(`/v1/cms/places/${place.id}/administrative-mapping`, 'moderator');
    await verify(place.id);
    await approve(place.id);
    await get('/v1/cms/administrative-mappings/remediation', 'moderator');
    expect(await metricCount('places_provider_requests_total')).toBe(google);
    expect(await metricCount('provider_requests_total', 'upstash')).toBe(redis);
  });
});

describe('the shared guard every publishing path uses', () => {
  it('permits a verified, still-valid mapping', async () => {
    const place = await insertPlace();
    await verify(place.id);
    const subject = await placeRow(place.id);
    const block = await evaluatePlaceApproval(db, subject);
    expect(block).toBeNull();
    expect(publicationOutcomeFor(block)).toBe('published');
  });

  it.each([
    ['an unmapped place', {}, 'deferred_mapping_unverified'],
    [
      'an auto-matched place',
      {
        administrativeMappingStatus: 'AUTO_MATCHED' as const,
        provinceCode: '01',
        communeCode: '00004',
        administrativeDatasetVersion: 'v',
      },
      'deferred_mapping_unverified',
    ],
    [
      'a verified place whose hierarchy no longer holds',
      {
        administrativeMappingStatus: 'VERIFIED' as const,
        provinceCode: '79',
        communeCode: '00004',
        administrativeDatasetVersion: 'v',
      },
      'deferred_mapping_invalid',
    ],
    [
      'a verified place whose commune is gone',
      {
        administrativeMappingStatus: 'VERIFIED' as const,
        provinceCode: '01',
        communeCode: '99999',
        administrativeDatasetVersion: 'v',
      },
      'deferred_mapping_invalid',
    ],
  ])('defers %s', async (_case, over, outcome) => {
    const place = await insertPlace(over as Record<string, unknown>);
    const block = await evaluatePlaceApproval(db, await placeRow(place.id));
    expect(publicationOutcomeFor(block)).toBe(outcome);
  });

  it('defers everything when no administrative dataset is published', async () => {
    const place = await insertPlace();
    await verify(place.id);
    await db
      .update(schema.administrativeDatasetVersions)
      .set({ status: 'ROLLED_BACK' })
      .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    try {
      const block = await evaluatePlaceApproval(db, await placeRow(place.id));
      expect(block?.code).toBe('ADMINISTRATIVE_DATASET_UNAVAILABLE');
      expect(publicationOutcomeFor(block)).toBe('deferred_no_active_dataset');
      // And the ordinary transition refuses for the same reason, from the same
      // guard — an environment with no dataset can publish nothing.
      const res = await approve(place.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ADMINISTRATIVE_DATASET_UNAVAILABLE');
    } finally {
      await db
        .update(schema.administrativeDatasetVersions)
        .set({ status: 'PUBLISHED' })
        .where(eq(schema.administrativeDatasetVersions.id, datasetId));
    }
  });

  it('re-decides inside the publishing transaction, not from a stale read', async () => {
    // The mapping is verified, read, and then rejected — the approval must see
    // the rejection, because the guard runs against the row it is about to
    // write and not against whatever the caller saw earlier.
    const place = await insertPlace();
    const verified = await verify(place.id);
    const before = await evaluatePlaceApproval(db, verified);
    expect(before).toBeNull();

    await send('POST', `/v1/cms/places/${place.id}/administrative-mapping/reject`, 'moderator', {
      reason: 'wrong ward',
      expectedUpdatedAt: verified.updatedAt.toISOString(),
    });
    const res = await approve(place.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MAPPING_REJECTED');
  });
});

async function metricCount(metric: string, contains?: string): Promise<number> {
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
    .filter((line) => line.startsWith(metric) && (!contains || line.includes(contains)))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
