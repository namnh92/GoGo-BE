import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration ordering across two epics, not just two branches.
 *
 * Drizzle applies a journal entry only when its `when` exceeds the newest
 * `created_at` already in `drizzle.__drizzle_migrations` — never by filename
 * and never by hash — and it reads that watermark **once**, before the loop
 * (`drizzle-orm/pg-core/dialect.js`). Two consequences run through everything
 * below:
 *
 *   - an empty database has no watermark, so it applies every migration in
 *     journal order whatever the timestamps say. That is why a suite that only
 *     ever starts empty cannot see any of this;
 *   - a database with a watermark silently skips anything numbered above it in
 *     the file listing but stamped below it in the journal. No error. The
 *     table simply never exists, and the deploy reports success.
 *
 * This repository has two chains above develop's `0043`:
 *
 *   CMS Place Editor (#432/#434)  0046 @1788675980330, 0047 @1788675981330
 *   this chain                    0048 @1789084800000, 0049 @1789171200000
 *
 * **CMS first is the order of record.** This chain therefore takes the next
 * free indices above the CMS tail and keeps its own `when` values, which
 * already sit above it — that is precisely what lets a CMS-only database
 * receive these two migrations.
 *
 * Prior states come from `test/fixtures/migration-states/`, deliberately not
 * from git: `feature/*` branches are squash-merged so their merge commits stop
 * existing, and the CI job that runs this checks out at depth 1 with no
 * `origin/develop` to walk from. Files on disk survive all of it.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const combinedMigrations = path.join(repoRoot, 'migrations');

type FixtureMigration = {
  idx: number;
  tag: string;
  when: number;
  /** Path under the fixture directory, for a state whose SQL is frozen here. */
  file?: string;
  /** Combined-tree file to copy verbatim, for a state that only renamed one. */
  fromCombined?: string;
  /** Combined-tree file this fixture must still match byte for byte, or null. */
  sameContentAs?: string | null;
};

type MigrationState = { description: string; migrations: FixtureMigration[] };
type StateName = 'push' | 'link' | 'provider' | 'cms';

const fixtureDir = path.join(__dirname, 'fixtures/migration-states');
const fixtures = JSON.parse(readFileSync(path.join(fixtureDir, 'states.json'), 'utf8')) as {
  baseThroughIdx: number;
  states: Record<StateName, MigrationState>;
};

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

function journalOf(folder: string): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
}

/**
 * Rebuild the migrations folder a database was migrated with before this
 * chain arrived: everything shared, then that state's own migrations under
 * their own numbers and their own `when`.
 */
function migrationsFor(which: StateName): string {
  const state = fixtures.states[which];
  const dir = mkdtempSync(path.join(tmpdir(), `gogo-migrations-${which}-`));
  mkdirSync(path.join(dir, 'meta'), { recursive: true });

  const shared = journalOf(combinedMigrations).entries.filter(
    (e) => e.idx <= fixtures.baseThroughIdx,
  );
  expect(shared.length).toBeGreaterThan(10);
  for (const entry of shared) {
    const sqlFile = `${entry.tag}.sql`;
    copyFileSync(path.join(combinedMigrations, sqlFile), path.join(dir, sqlFile));
  }

  for (const migration of state.migrations) {
    const source = migration.fromCombined
      ? path.join(combinedMigrations, migration.fromCombined)
      : path.join(fixtureDir, migration.file!);
    copyFileSync(source, path.join(dir, `${migration.tag}.sql`));
  }

  const entries = [
    ...shared,
    ...state.migrations.map((m) => ({
      idx: m.idx,
      version: '7',
      when: m.when,
      tag: m.tag,
      breakpoints: true,
    })),
  ];
  writeFileSync(
    path.join(dir, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2),
  );
  return dir;
}

/** The watermark a state leaves behind — what Drizzle compares against next. */
function watermarkOf(which: StateName): number {
  return Math.max(...fixtures.states[which].migrations.map((m) => m.when));
}

let container: StartedPostgreSqlContainer;
const pools: Pool[] = [];

async function database(name: string) {
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`create database ${name}`);
  await admin.end();
  const uri = container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const pool = new Pool({ connectionString: uri, max: 2 });
  pool.on('error', () => undefined);
  pools.push(pool);
  return drizzle(pool);
}

/**
 * The shape a reader cares about: every column and every index of the tables
 * this chain owns, ordered so two databases compare as text. Scoped on
 * purpose — a CMS-only database also carries that chain's tables, which this
 * chain neither creates nor should assert on.
 */
async function schemaOf(db: Awaited<ReturnType<typeof database>>) {
  const tables = ['notifications', 'share_links', 'notification_campaigns'];
  const { rows: columns } = await db.execute(sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name = any(${sql.raw(`ARRAY['${tables.join("','")}']`)})
    order by table_name, column_name
  `);
  const { rows: indexes } = await db.execute(sql`
    select tablename, indexname, indexdef from pg_indexes
    where schemaname = 'public' and tablename = any(${sql.raw(`ARRAY['${tables.join("','")}']`)})
    order by tablename, indexname
  `);
  const { rows: enums } = await db.execute(sql`
    select t.typname, e.enumlabel
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    where t.typname in ('share_link_type', 'share_link_provider')
    order by t.typname, e.enumsortorder
  `);
  return { columns, indexes, enums };
}

async function appliedMigrations(db: Awaited<ReturnType<typeof database>>) {
  const { rows } = await db.execute(
    sql`select created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  return (rows as { created_at: string | number }[]).map((r) => Number(r.created_at));
}

async function tableExists(db: Awaited<ReturnType<typeof database>>, table: string) {
  const { rows } = await db.execute(sql`select to_regclass(${`public.${table}`}) as t`);
  return (rows[0] as { t: string | null }).t !== null;
}

const PUSH_WHEN = 1789084800000;
const LINKS_WHEN = 1789171200000;

/**
 * This epic's two migrations, in the order they must stay in. Everything below
 * finds them by tag: they were the journal's last two entries when they landed
 * and will not stay that way, and a test that pins "the last two rows" turns
 * every later migration in this repository into a failure here.
 */
const EPIC_TAGS = ['0048_notification-push-delivery', '0049_share-links'] as const;

/** Positions of `tags` in journal order, so adjacency can be asserted. */
function indicesOf(journal: { entries: JournalEntry[] }, tags: readonly string[]): number[] {
  return tags.map((tag) => journal.entries.findIndex((e) => e.tag === tag));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_migration_base')
    .start();
}, 240_000);

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  await container?.stop();
});

describe('migration ordering across both epics', () => {
  it('the combined journal is monotonic in `when` — the only thing Drizzle orders by', () => {
    const journal = journalOf(combinedMigrations);
    const whens = journal.entries.map((e) => e.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
    // Located by tag, not by `slice(-2)`. These two are this epic's migrations
    // wherever they end up in the journal, and what matters is that they are
    // adjacent and in this order. Pinning them to the *last* two rows would
    // make the next unrelated migration, whatever it is, fail here.
    const [push, links] = indicesOf(journal, EPIC_TAGS);
    expect(push).toBeGreaterThanOrEqual(0);
    expect(links).toBe(push! + 1);
  });

  it('sits above the CMS chain, which is what makes CMS-first work', () => {
    // The whole ordering decision in one place. If someone lowers a `when`
    // here to tidy the numbering, a CMS-only database stops receiving these
    // two migrations and nothing else in the suite notices.
    const journal = journalOf(combinedMigrations);
    const mine = EPIC_TAGS.map((tag) => journal.entries.find((e) => e.tag === tag)!);
    expect(mine.map((e) => e?.tag)).toEqual([...EPIC_TAGS]);
    expect(mine.map((e) => e.when)).toEqual([PUSH_WHEN, LINKS_WHEN]);
    // The indices these two took when they landed, above the CMS chain's. Later
    // migrations take later ones; that is not this test's business.
    expect(mine.map((e) => e.idx)).toEqual([48, 49]);

    const cms = journal.entries.filter(
      (e) => e.tag.startsWith('004') && e.idx >= 46 && e.idx <= 47,
    );
    expect(cms.map((e) => e.tag)).toEqual(['0046_place-editor-contracts', '0047_cms-place-media']);
    const cmsTail = Math.max(...cms.map((e) => e.when));
    expect(cmsTail).toBe(watermarkOf('cms'));
    expect(PUSH_WHEN).toBeGreaterThan(cmsTail);
    expect(LINKS_WHEN).toBeGreaterThan(PUSH_WHEN);
  });

  it('the fixtures still describe the migrations they were taken from', () => {
    // Drift protection. These files are frozen history; if a combined migration
    // is edited, this fails and someone has to decide what it means for a
    // database already holding the old one — rather than the suite quietly
    // proving an upgrade path nobody ships any more.
    const push = fixtures.states.push.migrations[0]!;
    expect(push.sameContentAs).toBe('0048_notification-push-delivery.sql');
    expect(readFileSync(path.join(fixtureDir, push.file!), 'utf8')).toBe(
      readFileSync(path.join(combinedMigrations, push.sameContentAs!), 'utf8'),
    );

    // The link fixture is deliberately NOT identical: it predates the guards
    // that make the migration replay-safe, and replay is the whole point of
    // its `when` sitting above the push migration.
    const link = readFileSync(
      path.join(fixtureDir, fixtures.states.link.migrations[0]!.file!),
      'utf8',
    );
    const combinedLink = readFileSync(
      path.join(combinedMigrations, '0049_share-links.sql'),
      'utf8',
    );
    expect(link).not.toBe(combinedLink);
    expect(link).toMatch(/^CREATE TYPE share_link_type/m);
    expect(combinedLink).not.toMatch(/^CREATE TYPE share_link_type/m);
    expect(combinedLink).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'share_link_type'\)/,
    );

    // The provider state renamed files and changed nothing else, so it reads
    // the combined tree instead of duplicating it — and says so.
    expect(fixtures.states.provider.migrations.map((m) => m.fromCombined)).toEqual([
      '0048_notification-push-delivery.sql',
      '0049_share-links.sql',
    ]);
    // The CMS chain is on develop, so its state reads the real migrations
    // rather than a stand-in — an epic this branch does not own is never
    // copied into it.
    expect(fixtures.states.cms.migrations.map((m) => m.fromCombined)).toEqual([
      '0046_place-editor-contracts.sql',
      '0047_cms-place-media.sql',
    ]);
  });

  it('an empty database gets both migrations', async () => {
    const db = await database('gogo_from_empty');
    await migrate(db, { migrationsFolder: combinedMigrations });
    const applied = await appliedMigrations(db);
    expect(applied).toContain(PUSH_WHEN);
    expect(applied).toContain(LINKS_WHEN);
    const names = (await schemaOf(db)).columns.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toContain('notifications.push_sent_at');
    expect(names).toContain('share_links.slug_hash');
  });

  it('a CMS-only database upgrades, and keeps the rows it already had', async () => {
    const db = await database('gogo_from_cms');
    await migrate(db, { migrationsFolder: migrationsFor('cms') });
    expect((await appliedMigrations(db)).at(-1)).toBe(watermarkOf('cms'));
    expect(await tableExists(db, 'share_links')).toBe(false);

    // A row written under the CMS chain, before this one arrives — using a
    // column that chain added (`service_areas.city`, migration 0046).
    await db.execute(sql`
      insert into service_areas (key, name, center_lat, center_lng, radius_m, city)
      values ('q1', 'Quan 1', 10.7769, 106.7009, 5000, 'Ho Chi Minh')
    `);

    await migrate(db, { migrationsFolder: combinedMigrations });

    const applied = await appliedMigrations(db);
    expect(applied).toContain(PUSH_WHEN);
    expect(applied).toContain(LINKS_WHEN);
    expect(await tableExists(db, 'share_links')).toBe(true);
    const names = (await schemaOf(db)).columns.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toContain('notifications.push_sent_at');
    // The CMS chain's own objects are untouched, rows included.
    const { rows: survivors } = await db.execute(sql`select key, city from service_areas`);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ key: 'q1', city: 'Ho Chi Minh' });
    // …and the table that chain introduced is still there.
    expect(await tableExists(db, 'place_field_provenance')).toBe(true);
  });

  it('a database that already ran the push chain upgrades to the same schema', async () => {
    const db = await database('gogo_from_push');
    await migrate(db, { migrationsFolder: migrationsFor('push') });
    expect((await appliedMigrations(db)).at(-1)).toBe(PUSH_WHEN);
    expect(await tableExists(db, 'share_links')).toBe(false);

    await migrate(db, { migrationsFolder: combinedMigrations });

    const after = await appliedMigrations(db);
    // Not re-applied: same `when`, already recorded.
    expect(after.filter((w) => w === PUSH_WHEN)).toHaveLength(1);
    expect(after).toContain(LINKS_WHEN);
    expect(await tableExists(db, 'share_links')).toBe(true);
  });

  it('a database that already ran the link chain upgrades, re-running share_links harmlessly', async () => {
    const db = await database('gogo_from_link');
    await migrate(db, { migrationsFolder: migrationsFor('link') });
    expect((await appliedMigrations(db)).at(-1)).toBe(1788998400000);

    // A row written under the old numbering must survive the replay.
    await db.execute(sql`
      insert into share_links (slug_hash, type, target_id, provider)
      values ('deadbeef', 'PLACE', '00000000-0000-4000-8000-000000000001', 'TENJIN')
    `);

    await migrate(db, { migrationsFolder: combinedMigrations });

    const after = await appliedMigrations(db);
    expect(after).toContain(PUSH_WHEN);
    expect(after).toContain(LINKS_WHEN);
    const { rows: survivors } = await db.execute(sql`select slug_hash from share_links`);
    expect(survivors).toHaveLength(1);
    const names = (await schemaOf(db)).columns.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toContain('notifications.push_sent_at');
  });

  it('every history that can reach the combined schema reaches exactly the same one', async () => {
    const [empty, fromCms, fromPush, fromLink] = await Promise.all([
      database('gogo_cmp_empty'),
      database('gogo_cmp_cms'),
      database('gogo_cmp_push'),
      database('gogo_cmp_link'),
    ]);
    await migrate(empty, { migrationsFolder: combinedMigrations });
    for (const [db, state] of [
      [fromCms, 'cms'],
      [fromPush, 'push'],
      [fromLink, 'link'],
    ] as const) {
      await migrate(db, { migrationsFolder: migrationsFor(state) });
      await migrate(db, { migrationsFolder: combinedMigrations });
    }

    const [a, b, c, d] = await Promise.all([
      schemaOf(empty),
      schemaOf(fromCms),
      schemaOf(fromPush),
      schemaOf(fromLink),
    ]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
    // And the comparison is not vacuous.
    expect(a.columns.length).toBeGreaterThan(30);
    expect(a.enums.map((e) => e.enumlabel)).toContain('ROOM_INVITE');
  });

  /**
   * The one state that does not converge, asserted rather than hoped for.
   *
   * A database that already ran this chain sits at 1789171200000, above the
   * CMS chain's whole range. Drizzle reads that watermark once and skips every
   * entry below it, so when the CMS chain lands its two migrations are passed
   * over in silence — permanently, because the watermark never comes back down.
   *
   * No numbering fixes this. The watermark is a single value, so of the two
   * orders only one can be made to work, and CMS-first is the order of record.
   * Such a database needs a forward repair migration stamped above
   * 1789171200000; `docs/adr/0016` and the review report carry the detail. This
   * test exists so the state is named and measured instead of discovered.
   */
  it('documents the one state that needs a forward repair: provider-chain-first', async () => {
    const db = await database('gogo_from_provider');
    await migrate(db, { migrationsFolder: migrationsFor('provider') });
    expect((await appliedMigrations(db)).at(-1)).toBe(LINKS_WHEN);

    // This chain's own migrations are already applied under their old names,
    // so re-running the combined folder correctly changes nothing.
    await migrate(db, { migrationsFolder: combinedMigrations });
    const applied = await appliedMigrations(db);
    expect(applied.filter((w) => w === PUSH_WHEN)).toHaveLength(1);
    expect(applied.filter((w) => w === LINKS_WHEN)).toHaveLength(1);
    expect(await tableExists(db, 'share_links')).toBe(true);

    // Now the CMS chain arrives. Its `when` values are below the watermark.
    const cms = fixtures.states.cms.migrations;
    expect(Math.max(...cms.map((m) => m.when))).toBeLessThan(LINKS_WHEN);
    await migrate(db, { migrationsFolder: migrationsFor('cms') });
    expect(await tableExists(db, 'place_field_provenance')).toBe(false);
    expect(await appliedMigrations(db)).not.toContain(cms[0]!.when);
  });
});
