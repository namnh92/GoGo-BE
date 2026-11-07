import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { TaxonomyController } from '../../../libs/modules/places/presentation/taxonomy.controller';
import { DB } from '../../../libs/modules/shared/tokens';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;
const folder = path.resolve(__dirname, '../../../migrations');
const get = (locale: string, etag?: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/taxonomies?kinds=amenity,checkin_tag&locale=${locale}`,
    headers: etag ? { 'if-none-match': etag } : {},
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  const journal = JSON.parse(await readFile(path.join(folder, 'meta/_journal.json'), 'utf8'));
  const prior = journal.entries.filter((entry: { idx: number }) => entry.idx < 88);
  const snapshot = await mkdtemp(path.join(os.tmpdir(), 'gogo-802-taxonomy-'));
  try {
    await mkdir(path.join(snapshot, 'meta'));
    await writeFile(
      path.join(snapshot, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const entry of prior)
      await cp(path.join(folder, `${entry.tag}.sql`), path.join(snapshot, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: snapshot });
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
  @Module({
    controllers: [TaxonomyController],
    providers: [{ provide: DB, useValue: db }],
  })
  class TaxonomyMigrationTestModule {}
  app = await NestFactory.create<NestFastifyApplication>(
    TaxonomyMigrationTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

it('F-05 rolls back failed seeds, then invalidates pre-migration validators with the complete vocabulary', async () => {
  const locales = ['vi', 'en'];
  const cached = await Promise.all(locales.map((locale) => get(locale)));
  const snapshot = async () => ({
    state: (await pool.query('select * from taxonomy_version')).rows,
    keys: (await pool.query('select * from taxonomies order by id')).rows,
    labels: (await pool.query('select * from taxonomy_labels order by taxonomy_id, locale')).rows,
  });
  const before = await snapshot();
  await pool.query(`create function reject_wizard_label802() returns trigger language plpgsql as $$
    begin raise exception 'wizard label unavailable'; end $$`);
  await pool.query(`create trigger reject_wizard_label802 before insert on taxonomy_labels
    for each row execute function reject_wizard_label802()`);
  try {
    await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
  } finally {
    await pool.query('drop function reject_wizard_label802() cascade');
  }
  expect(await snapshot()).toEqual(before);
  for (const [index, locale] of locales.entries())
    expect((await get(locale, String(cached[index]!.headers.etag))).statusCode).toBe(304);

  await migrate(db, { migrationsFolder: folder });
  const state = (await snapshot()).state[0]!;
  expect(state.version).toBe(before.state[0]!.version + 1);
  expect(state.updated_at.getTime()).toBeGreaterThan(before.state[0]!.updated_at.getTime());
  for (const [index, locale] of locales.entries()) {
    const changed = await get(locale, String(cached[index]!.headers.etag));
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(cached[index]!.headers.etag);
    expect(changed.json().version).toBe(state.version);
    for (const [kind, keys] of Object.entries({
      amenity: ['power_at_each_table', 'separate_smoking_area', 'open_after_23', 'tables_over_six'],
      checkin_tag: ['service_friendly', 'service_attentive', 'space_quiet', 'space_spacious'],
    })) {
      for (const key of keys)
        expect(changed.json().kinds[kind]).toContainEqual({
          key,
          sortOrder: expect.any(Number),
          labels: { [locale]: expect.any(String) },
        });
    }
    expect((await get(locale, String(changed.headers.etag))).statusCode).toBe(304);
  }
});
