import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';

process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';
import { AdministrativeBoundaryImportService, AdministrativeImportService } from '@gogo/modules';

/**
 * GoGo-BE#440 F-07 — province/commune provenance is outcome-aware (Astra,
 * `dev/handoffs/codex-review-request-sa-GoGo-BE-440-provenance.sa.out`).
 *
 * A submitted code is an assertion to the resolver. It becomes the current
 * field's editorial claim only when the resolver adopted it as `trusted_code`;
 * machine-derived codes carry the administrative mapping metadata instead, and
 * codes a decision retained keep the provenance they had. Every assertion, and
 * every claim it superseded, stays in the audit history.
 *
 * Tests marked `FAIL-before` reproduce F-07 on 0606cd1: (a) a re-stamp under a
 * VERIFIED/REJECTED mapping that the edit could not change, (b) a re-stamp when
 * the resolver kept or chose other codes, (c) create-time evidence surviving a
 * geometry-only re-resolution.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
let datasetId: string;

const BOUNDARY_VERSION = 'fixture-v5.0.0';
const FIXTURE = path.resolve(
  __dirname,
  '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.62.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

type Admin = { id: string; token: string };
let editor: Admin;
let moderator: Admin;
let creator: (Admin & { uses: number }) | undefined;
let admins = 0;

let mapped: { provinceCode: string; communeCode: string };
let neighbour: { provinceCode: string; communeCode: string };
let inside: { lng: number; lat: number };
let neighbourInside: { lng: number; lat: number };
const outside = { lng: 108.5, lat: 12.0 };

async function createAdmin(role: 'editor' | 'moderator'): Promise<Admin> {
  const email = `c440pv-${role}-${++admins}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  const [row] = await db
    .insert(schema.adminUsers)
    .values({ email, passwordHash, displayName: email, role })
    .returning();
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: row!.id, token: res.json().accessToken as string };
}

/** Creates rotate across editors: the route allows 20/minute per actor. */
async function aCreator(): Promise<Admin> {
  if (!creator || creator.uses >= 8) creator = { ...(await createAdmin('editor')), uses: 0 };
  creator.uses += 1;
  return creator;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

const R1 = { province: 'biển hiệu UBND phường, ảnh 2026-10-01', commune: 'hoá đơn điện 2026-09' };
const R2 = { province: 'gọi xác nhận 2026-10-03', commune: 'giấy phép kinh doanh 2026' };

/** POST with explicit references: name/geom always, codes when given. */
async function create(
  over: Record<string, unknown> = {},
  refs: Record<string, string> = {},
): Promise<{ id: string; by: Admin; res: Awaited<ReturnType<typeof post>> }> {
  const by = await aCreator();
  const res = await post(
    {
      name: `Quán ${randomUUID().slice(0, 8)}`,
      lat: inside.lat,
      lng: inside.lng,
      allowDuplicate: true,
      ...over,
      sourceReferences: { name: 'menu', geom: 'khảo sát', ...refs },
    },
    by.token,
  );
  return { id: res.statusCode === 201 ? (res.json().id as string) : '', by, res };
}

function post(payload: Record<string, unknown>, token: string) {
  return api().inject({
    method: 'POST',
    url: '/v1/cms/places',
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload,
  });
}

/** A create whose codes the resolver adopts, with R1 references. */
async function createAdopted() {
  const made = await create(mapped, { provinceCode: R1.province, communeCode: R1.commune });
  expect(made.res.statusCode, made.res.body).toBe(201);
  return made;
}

function patch(id: string, payload: Record<string, unknown>, as: Admin = editor) {
  return api().inject({
    method: 'PATCH',
    url: `/v1/cms/places/${id}`,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${as.token}` },
    payload,
  });
}

async function placeRow(id: string) {
  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  return row!;
}

async function codeClaims(id: string) {
  const all = await db
    .select()
    .from(schema.placeFieldProvenance)
    .where(eq(schema.placeFieldProvenance.placeId, id));
  return {
    province: all.find((r) => r.field === 'province_code'),
    commune: all.find((r) => r.field === 'commune_code'),
  };
}

async function audits(action: string, id: string) {
  return db
    .select()
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.resourceId, id)));
}

async function moderate(id: string, action: 'verify' | 'reject' | 'rematch', body: object) {
  const place = await placeRow(id);
  const res = await api().inject({
    method: 'POST',
    url: `/v1/cms/places/${id}/administrative-mapping/${action}`,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${moderator.token}` },
    payload: { ...body, expectedUpdatedAt: place.updatedAt.toISOString() },
  });
  expect(res.statusCode, res.body).toBe(201);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_code_provenance_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    archivePath: FIXTURE,
  });
  const report = await new AdministrativeImportService(db).importPinnedSnapshot();
  datasetId = report.datasetVersionId;
  await db
    .update(schema.administrativeDatasetVersions)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), boundarySourceVersion: BOUNDARY_VERSION })
    .where(eq(schema.administrativeDatasetVersions.id, datasetId));
  await new AdministrativeBoundaryImportService(db).load({
    role: 'boundaries-fixture',
    boundaryVersion: BOUNDARY_VERSION,
    archivePath: FIXTURE,
  });

  const drawn = await rows<{ code: string; parent_code: string; lng: number; lat: number }>(sql`
    select b.code, b.parent_code,
           st_x(st_pointonsurface(b.geom)) as lng, st_y(st_pointonsurface(b.geom)) as lat
    from administrative_unit_boundaries b
    where b.boundary_version = ${BOUNDARY_VERSION} and b.level = 'COMMUNE'
    order by b.code limit 2`);
  mapped = { communeCode: drawn[0]!.code, provinceCode: drawn[0]!.parent_code };
  inside = { lng: Number(drawn[0]!.lng), lat: Number(drawn[0]!.lat) };
  neighbour = { communeCode: drawn[1]!.code, provinceCode: drawn[1]!.parent_code };
  neighbourInside = { lng: Number(drawn[1]!.lng), lat: Number(drawn[1]!.lat) };

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  editor = await createAdmin('editor');
  moderator = await createAdmin('moderator');
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

describe('F-07 create', () => {
  it('adopted pair: exact independent references and actor', async () => {
    const { id, by } = await createAdopted();
    const row = await placeRow(id);
    expect(row).toMatchObject({ ...mapped, administrativeMappingSource: 'trusted_code' });
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({
      sourceType: 'editorial',
      sourceReference: R1.province,
      actorId: by.id,
    });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
  });

  it('FAIL-before (b): conflicting pair → NEEDS_REVIEW, null codes, no current claims, assertions audited', async () => {
    const made = await create(
      { ...neighbour },
      { provinceCode: R1.province, communeCode: R1.commune },
    );
    expect(made.res.statusCode, made.res.body).toBe(201);
    expect(await placeRow(made.id)).toMatchObject({
      administrativeMappingStatus: 'NEEDS_REVIEW',
      provinceCode: null,
      communeCode: null,
    });
    const { province, commune } = await codeClaims(made.id);
    expect(province).toBeUndefined();
    expect(commune).toBeUndefined();

    const [assertion] = await audits('place.administrative_assertion', made.id);
    const diff = assertion!.diff as { assertions: Record<string, unknown>[] };
    expect(diff.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'communeCode',
          value: neighbour.communeCode,
          reference: R1.commune,
          disposition: 'not_adopted',
        }),
      ]),
    );
  });

  it('geometry-only: resolver codes with administrative provenance, no editorial code rows', async () => {
    const { id } = await create();
    expect(await placeRow(id)).toMatchObject({
      ...mapped,
      administrativeMappingStatus: 'AUTO_MATCHED',
      administrativeMappingSource: 'boundary_point_in_polygon',
    });
    const { province, commune } = await codeClaims(id);
    expect(province).toBeUndefined();
    expect(commune).toBeUndefined();
  });

  it('no assertions and nothing to resolve: UNMAPPED without code rows', async () => {
    const { id } = await create(outside);
    expect(await placeRow(id)).toMatchObject({ administrativeMappingStatus: 'UNMAPPED' });
    expect(await codeClaims(id)).toEqual({ province: undefined, commune: undefined });
  });

  it('reference errors are exact; null codes need none', async () => {
    const who = await aCreator();
    const base = { name: 'Quán Mã', lat: inside.lat, lng: inside.lng, allowDuplicate: true };
    const cases: [Record<string, unknown>, Record<string, string>, string, string][] = [
      [mapped, {}, 'sourceReferences.provinceCode', 'required'],
      [
        mapped,
        { provinceCode: ' ', communeCode: 'x' },
        'sourceReferences.provinceCode',
        'required',
      ],
      [
        mapped,
        { provinceCode: 'x'.repeat(501), communeCode: 'x' },
        'sourceReferences.provinceCode',
        'too_long',
      ],
      [{}, { provinceCode: 'x' }, 'sourceReferences.provinceCode', 'unused'],
      [{}, { legacyDistrictCode: 'x' }, 'sourceReferences.legacyDistrictCode', 'unknown'],
    ];
    for (const [codes, refs, field, code] of cases) {
      const res = await post(
        { ...base, ...codes, sourceReferences: { name: 'a', geom: 'b', ...refs } },
        who.token,
      );
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('SOURCE_REFERENCE_INVALID');
      expect(res.json().field_errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, code })]),
      );
    }
    const nulls = await post(
      {
        ...base,
        provinceCode: null,
        communeCode: null,
        sourceReferences: { name: 'a', geom: 'b' },
      },
      who.token,
    );
    expect(nulls.statusCode, nulls.body).toBe(201);
  });
});

describe('F-07 PATCH references', () => {
  it('requires a reference for each explicitly supplied non-null code, exactly', async () => {
    const { id } = await create();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ ...mapped }, 'sourceReferences.provinceCode', 'required'],
      [
        { ...mapped, sourceReferences: { provinceCode: 'a', communeCode: 'x'.repeat(501) } },
        'sourceReferences.communeCode',
        'too_long',
      ],
      [{ sourceReferences: { communeCode: 'a' } }, 'sourceReferences.communeCode', 'unused'],
      [
        { ...mapped, sourceReferences: { provinceCode: 'a', communeCode: 'b', name: 'c' } },
        'sourceReferences.name',
        'unknown',
      ],
    ];
    for (const [body, field, code] of cases) {
      const res = await patch(id, body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('SOURCE_REFERENCE_INVALID');
      expect(res.json().field_errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, code })]),
      );
    }
    const cleared = await patch(id, { provinceCode: null, communeCode: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
  });
});

describe('F-07 PATCH outcomes', () => {
  it('RESOLVE adopted pair: fresh references and actor', async () => {
    const { id } = await create();
    const res = await patch(id, {
      ...mapped,
      sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R2.province, actorId: editor.id });
    expect(commune).toMatchObject({ sourceReference: R2.commune, actorId: editor.id });
  });

  it('adopted identical pair with mapping noop: evidence refreshes', async () => {
    const { id } = await createAdopted();
    const resolvesBefore = (await audits('administrative_mapping.resolve', id)).length;
    const res = await patch(id, {
      ...mapped,
      sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
    });
    expect(res.statusCode, res.body).toBe(200);
    // The mapping did not change …
    expect((await audits('administrative_mapping.resolve', id)).length).toBe(resolvesBefore);
    // … and the evidence behind it did.
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R2.province, actorId: editor.id });
    expect(commune).toMatchObject({ sourceReference: R2.commune, actorId: editor.id });
  });

  it('the omitted counterpart is never attributed to the new editor', async () => {
    const { id, by } = await createAdopted();
    const res = await patch(id, {
      provinceCode: mapped.provinceCode,
      sourceReferences: { provinceCode: R2.province },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R2.province, actorId: editor.id });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
  });

  it('FAIL-before (b): conflicting evidence retaining old codes leaves old provenance', async () => {
    const { id, by } = await createAdopted();
    const res = await patch(id, {
      ...neighbour,
      sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await placeRow(id)).toMatchObject({
      administrativeMappingStatus: 'NEEDS_REVIEW',
      ...mapped,
    });
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R1.province, actorId: by.id });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
    // The rejected assertion is history, not current provenance.
    const [assertion] = await audits('place.administrative_assertion', id).then((a) =>
      a.filter((r) => r.actorId === editor.id),
    );
    expect(JSON.stringify(assertion!.diff)).toContain(R2.commune);
  });

  it('FAIL-before (a): VERIFIED agreeing edit keeps status and provenance', async () => {
    const { id, by } = await createAdopted();
    await moderate(id, 'verify', mapped);
    const res = await patch(id, {
      ...mapped,
      sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await placeRow(id)).toMatchObject({ administrativeMappingStatus: 'VERIFIED' });
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R1.province, actorId: by.id });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
  });

  it('FAIL-before (a): VERIFIED contradicting edit goes STALE and keeps provenance', async () => {
    const { id, by } = await createAdopted();
    await moderate(id, 'verify', mapped);
    const res = await patch(id, {
      lat: neighbourInside.lat,
      lng: neighbourInside.lng,
      ...neighbour,
      sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await placeRow(id)).toMatchObject({ administrativeMappingStatus: 'STALE', ...mapped });
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R1.province, actorId: by.id });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
  });

  it('FAIL-before (a): REJECTED mapping and provenance are untouched', async () => {
    const { id, by } = await createAdopted();
    await moderate(id, 'reject', { reason: 'sai phường' });
    const before = await placeRow(id);
    const res = await patch(id, {
      ...mapped,
      sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await placeRow(id);
    expect(after.administrativeMappingStatus).toBe('REJECTED');
    expect(after.communeCode).toBe(before.communeCode);
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R1.province, actorId: by.id });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
  });

  it('FAIL-before (c): geometry-only re-resolution to another pair removes the old claims', async () => {
    const { id } = await createAdopted();
    const res = await patch(id, { lat: neighbourInside.lat, lng: neighbourInside.lng });
    expect(res.statusCode, res.body).toBe(200);
    expect(await placeRow(id)).toMatchObject({
      ...neighbour,
      administrativeMappingStatus: 'AUTO_MATCHED',
    });
    expect(await codeClaims(id)).toEqual({ province: undefined, commune: undefined });
  });

  it('derivation to the same pair never re-stamps a claim editorial for the new editor', async () => {
    const { id, by } = await createAdopted();
    const res = await patch(id, { lat: inside.lat + 0.000001, lng: inside.lng });
    expect(res.statusCode, res.body).toBe(200);
    expect(await placeRow(id)).toMatchObject(mapped);
    const { province, commune } = await codeClaims(id);
    for (const claim of [province, commune]) {
      if (claim) expect(claim.actorId).toBe(by.id);
    }
  });

  it('FAIL-before (c): persisted UNMAPPED/null codes remove the claims', async () => {
    const { id } = await createAdopted();
    const res = await patch(id, { lat: outside.lat, lng: outside.lng });
    expect(res.statusCode, res.body).toBe(200);
    expect(await placeRow(id)).toMatchObject({
      administrativeMappingStatus: 'UNMAPPED',
      provinceCode: null,
      communeCode: null,
    });
    expect(await codeClaims(id)).toEqual({ province: undefined, commune: undefined });
  });

  it('explicit null pair then geometry resolution: resolver provenance, no editorial clear claim', async () => {
    const { id } = await createAdopted();
    const res = await patch(id, { provinceCode: null, communeCode: null });
    expect(res.statusCode, res.body).toBe(200);
    const row = await placeRow(id);
    expect(row).toMatchObject({
      ...mapped,
      administrativeMappingSource: 'boundary_point_in_polygon',
    });
    expect(await codeClaims(id)).toEqual({ province: undefined, commune: undefined });
  });

  it('an unrelated edit preserves code provenance', async () => {
    const { id, by } = await createAdopted();
    const res = await patch(id, { phone: '0283 822 7777' });
    expect(res.statusCode, res.body).toBe(200);
    const { province, commune } = await codeClaims(id);
    expect(province).toMatchObject({ sourceReference: R1.province, actorId: by.id });
    expect(commune).toMatchObject({ sourceReference: R1.commune, actorId: by.id });
  });
});

describe('F-07 later writers', () => {
  it('a moderator decision to other codes supersedes the changed claims, in the audit', async () => {
    const { id, by } = await createAdopted();
    await moderate(id, 'verify', neighbour);
    const { province, commune } = await codeClaims(id);
    expect(commune).toBeUndefined();
    if (neighbour.provinceCode === mapped.provinceCode) {
      expect(province).toMatchObject({ sourceReference: R1.province, actorId: by.id });
    } else {
      expect(province).toBeUndefined();
    }
    const [verify] = await audits('administrative_mapping.verify', id);
    expect(JSON.stringify(verify!.diff)).toContain(R1.commune);
  });

  it('a rematch re-deriving the codes does not retain the superseded claims', async () => {
    const { id } = await createAdopted();
    await moderate(id, 'rematch', { reason: 'kiểm tra lại' });
    expect(await placeRow(id)).toMatchObject({
      ...mapped,
      administrativeMappingSource: 'boundary_point_in_polygon',
    });
    expect(await codeClaims(id)).toEqual({ province: undefined, commune: undefined });
    const resolves = await audits('administrative_mapping.resolve', id);
    // The rematch's resolve row carries what it superseded (rows are unordered).
    const superseding = resolves.filter((r) => 'supersededClaims' in (r.diff as object));
    expect(superseding).toHaveLength(1);
    expect(JSON.stringify(superseding[0]!.diff)).toContain(R1.province);
  });

  it('F-10: a concurrent verification is respected, whichever lands first', async () => {
    const { id } = await create();
    const place = await placeRow(id);
    const [edit, verify] = await Promise.all([
      patch(id, {
        ...mapped,
        sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
      }),
      api().inject({
        method: 'POST',
        url: `/v1/cms/places/${id}/administrative-mapping/verify`,
        remoteAddress: ip(),
        headers: { authorization: `Bearer ${moderator.token}` },
        payload: { ...mapped, expectedUpdatedAt: place.updatedAt.toISOString() },
      }),
    ]);
    // The edit carries no expectedUpdatedAt, so it always lands.
    expect(edit.statusCode, edit.body).toBe(200);
    const row = await placeRow(id);
    const { province, commune } = await codeClaims(id);
    expect(row).toMatchObject(mapped);

    if (verify.statusCode === 201) {
      // Verification first: the edit met a VERIFIED mapping it may not change,
      // so its assertion was not adopted and nothing was stamped.
      expect(row).toMatchObject({
        administrativeMappingStatus: 'VERIFIED',
        administrativeMappedBy: moderator.id,
      });
      expect(province).toBeUndefined();
      expect(commune).toBeUndefined();
    } else {
      // Edit first: adopted as trusted_code with the editor's evidence; the
      // verification then saw a changed row and was refused.
      expect(verify.statusCode, verify.body).toBe(409);
      expect(row).toMatchObject({
        administrativeMappingStatus: 'AUTO_MATCHED',
        administrativeMappingSource: 'trusted_code',
      });
      expect(province).toMatchObject({ sourceReference: R2.province, actorId: editor.id });
      expect(commune).toMatchObject({ sourceReference: R2.commune, actorId: editor.id });
    }
  });

  it('F-09: a save committed between the form load and the lock is refused, not overwritten', async () => {
    const { id } = await create();
    const loaded = await placeRow(id);
    const other = await pool.connect();
    try {
      // Another save holds the row and is about to commit a newer version.
      await other.query('begin');
      await other.query('select id from places where id = $1 for update', [id]);
      await other.query(
        "update places set phone = '+842838220000', updated_at = now() where id = $1",
        [id],
      );
      const pending = patch(id, {
        phone: '0283 822 1111',
        expectedUpdatedAt: loaded.updatedAt.toISOString(),
      });
      // The PATCH has read the (still old) row and is now waiting on the lock.
      await new Promise((r) => setTimeout(r, 400));
      await other.query('commit');
      const res = await pending;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('PLACE_MODIFIED');
    } finally {
      other.release();
    }
    expect((await placeRow(id)).phone).toBe('+842838220000');
  });

  it('a provenance or audit failure rolls back mapping and claims together', async () => {
    const { id } = await create();
    const before = await placeRow(id);
    await db.execute(sql`
      create or replace function c440pv_refuse() returns trigger language plpgsql as $$
      begin raise exception 'c440pv injected'; end $$`);
    for (const ddl of [
      sql`create trigger c440pv_t before insert on place_field_provenance for each row
          when (new.field = 'commune_code') execute function c440pv_refuse()`,
      sql`create trigger c440pv_t before insert on audit_logs for each row
          when (new.action = 'place.administrative_assertion') execute function c440pv_refuse()`,
    ]) {
      await db.execute(ddl);
      try {
        const res = await patch(id, {
          lat: neighbourInside.lat,
          lng: neighbourInside.lng,
          ...neighbour,
          sourceReferences: { provinceCode: R2.province, communeCode: R2.commune },
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        await db.execute(sql`drop trigger if exists c440pv_t on place_field_provenance`);
        await db.execute(sql`drop trigger if exists c440pv_t on audit_logs`);
      }
      const after = await placeRow(id);
      expect(after).toMatchObject({
        provinceCode: before.provinceCode,
        communeCode: before.communeCode,
        administrativeMappingSource: before.administrativeMappingSource,
      });
      expect(after.geom).toEqual(before.geom);
      expect(await codeClaims(id)).toEqual({ province: undefined, commune: undefined });
    }
  });
});
