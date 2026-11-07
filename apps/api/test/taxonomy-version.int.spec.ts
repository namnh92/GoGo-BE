import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { schema, type Db } from '@gogo/database';
import { CmsContentService } from '../../../libs/modules/cms/application/cms-content.service';
import { TaxonomyController } from '../../../libs/modules/places/presentation/taxonomy.controller';
import { DB } from '../../../libs/modules/shared/tokens';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let cms: CmsContentService;
let app: NestFastifyApplication;
const actor = randomUUID();
const get = (url: string, etag?: string) =>
  app.inject({ method: 'GET', url, headers: etag ? { 'if-none-match': etag } : {} });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  cms = new CmsContentService(db);
  @Module({
    controllers: [TaxonomyController],
    providers: [{ provide: DB, useValue: db }],
  })
  class TaxonomyTestModule {}
  app = await NestFactory.create<NestFastifyApplication>(TaxonomyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

it('versions every write, retains response fields, and audits the same committed generation', async () => {
  const initial = await cms.taxonomyVersion();
  expect((await get('/v1/taxonomies/version')).json()).toEqual(initial);
  const created = await cms.createTaxonomy(actor, {
    kind: 'mood',
    key: 'cache799',
    labels: { vi: 'Thư giãn', en: 'Relax' },
  });
  expect(created).toMatchObject({
    id: expect.any(String),
    version: initial.version + 1,
    updatedAt: expect.any(String),
  });
  for (const input of [
    { labels: { vi: 'Vui' } },
    { sortOrder: 9 },
    { isActive: false },
    { isActive: true },
  ]) {
    const before = await cms.taxonomyVersion();
    const result = await cms.updateTaxonomy(actor, created.id, input);
    expect(result).toMatchObject({ updated: true, version: before.version + 1 });
  }
  const synonym = await cms.addSynonym(actor, created.id, { term: 'relax799' });
  const rows = await db
    .select()
    .from(schema.taxonomySynonyms)
    .where(eq(schema.taxonomySynonyms.taxonomyId, created.id));
  const removed = await cms.removeSynonym(actor, rows[0]!.id);
  expect(removed.version).toBe(synonym.version + 1);
  const audit = await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.action, 'taxonomy.synonym_removed'));
  expect(audit.at(-1)!.diff).toMatchObject({
    version: removed.version,
    updatedAt: removed.updatedAt,
  });
  expect((await get('/v1/taxonomies/version')).json()).toEqual(await cms.taxonomyVersion());
});

it('scopes validators by canonical kinds and locale; supports weak/list/wildcard 304 without a body', async () => {
  const first = await get('/v1/taxonomies?kinds=mood,amenity&locale=vi');
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
  const etag = String(first.headers.etag);
  const canonical = await get('/v1/taxonomies?kinds=amenity,mood,mood&locale=vi');
  expect(canonical.headers.etag).toBe(etag);
  for (const validator of [etag, etag.replace('W/', ''), `"other", ${etag}`, '*']) {
    const hit = await get('/v1/taxonomies?kinds=mood,amenity&locale=vi', validator);
    expect(hit.statusCode).toBe(304);
    expect(hit.body).toBe('');
    expect(hit.headers.etag).toBe(etag);
    expect(hit.headers['cache-control']).toBe(first.headers['cache-control']);
  }
  const english = await get('/v1/taxonomies?kinds=mood,amenity&locale=en', etag);
  expect(english.statusCode).toBe(200);
  expect(english.headers.etag).not.toBe(etag);
  const entry = english.json().kinds.mood.find((t: { key: string }) => t.key === 'cache799');
  expect(entry.labels).toEqual({ en: 'Relax' });
  expect((await get('/v1/taxonomies?kinds=mood&locale=vi', etag)).statusCode).toBe(200);
  const all = await get('/v1/taxonomies');
  expect(all.json().kinds.mood.find((t: { key: string }) => t.key === 'cache799').labels).toEqual({
    vi: 'Vui',
    en: 'Relax',
  });
  const check = await get('/v1/taxonomies/version');
  expect((await get('/v1/taxonomies/version', String(check.headers.etag))).statusCode).toBe(304);
  expect(check.headers.etag).not.toBe(all.headers.etag);
  await cms.createTaxonomy(actor, { kind: 'mood', key: 'cache799_new', labels: { vi: 'Mới' } });
  const changed = await get('/v1/taxonomies?kinds=mood,amenity&locale=vi', etag);
  expect(changed.statusCode).toBe(200);
  expect(changed.json().version).toBe(first.json().version + 1);
});

it('serializes concurrent writers without lost versions', async () => {
  const before = await cms.taxonomyVersion();
  const writes = await Promise.all(
    [0, 1, 2, 3].map((n) =>
      cms.createTaxonomy(actor, {
        kind: 'mood',
        key: `concurrent799_${n}`,
        labels: { vi: `Nhãn ${n}` },
      }),
    ),
  );
  expect(writes.map((w) => w.version).sort((a, b) => a - b)).toEqual(
    [1, 2, 3, 4].map((n) => before.version + n),
  );
});

it('rolls back taxonomy, generation and audit on label or audit failure', async () => {
  const snapshot = async () => ({
    generation: await cms.taxonomyVersion(),
    taxonomies: await db.select().from(schema.taxonomies).orderBy(schema.taxonomies.id),
    labels: await db
      .select()
      .from(schema.taxonomyLabels)
      .orderBy(schema.taxonomyLabels.taxonomyId, schema.taxonomyLabels.locale),
    audits: await db.select().from(schema.auditLogs).orderBy(schema.auditLogs.id),
  });
  const before = await snapshot();
  await expect(
    cms.createTaxonomy(actor, {
      kind: 'mood',
      key: 'failed799',
      labels: { en: 'Written before failure', vi: null as never },
    }),
  ).rejects.toMatchObject({ cause: { code: '23502', column: 'label' } });
  expect(await snapshot()).toEqual(before);
  await expect(cms.updateTaxonomy(actor, randomUUID(), { sortOrder: 1 })).rejects.toThrow();
  await expect(cms.addSynonym(actor, randomUUID(), { term: 'missing' })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  await db.execute(sql`create function reject_taxonomy_audit799() returns trigger language plpgsql as $$
    begin if new.action like 'taxonomy.%' then raise exception 'audit unavailable'; end if; return new; end $$`);
  await db.execute(sql`create trigger reject_taxonomy_audit799 before insert on audit_logs
    for each row execute function reject_taxonomy_audit799()`);
  try {
    // Drizzle wraps the trigger's PostgreSQL error in the query error's cause.
    await expect(
      cms.createTaxonomy(actor, { kind: 'mood', key: 'auditfailed799', labels: { vi: 'Nhãn' } }),
    ).rejects.toMatchObject({ cause: { code: 'P0001', message: 'audit unavailable' } });
  } finally {
    await db.execute(sql`drop trigger reject_taxonomy_audit799 on audit_logs`);
  }
  expect(await snapshot()).toEqual(before);
});
