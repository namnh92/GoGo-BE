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
 * Migration ordering across the two provider chains (#193/#199 and #204–#206).
 *
 * The chains were developed side by side and each numbered its own migration.
 * Combining them renumbers one of the two, and Drizzle decides what to apply by
 * comparing a journal entry's `when` against the newest `created_at` already in
 * `drizzle.__drizzle_migrations` — not by filename and not by hash. So the
 * question a green suite on an empty database cannot answer is: what happens to
 * a database that already ran *one* chain?
 *
 * Three databases, three histories, one expected schema:
 *
 *   empty  → combined
 *   push   → combined   (already has 0045_notification-push-delivery @ 1789084800000)
 *   link   → combined   (already has 0044_share-links @ 1788998400000)
 *
 * The prior states come from `test/fixtures/migration-states/` — each chain's
 * migration frozen exactly as it shipped, plus the shared migrations at or
 * below `baseThroughIdx`, which are identical in every state and are read from
 * `migrations/` rather than duplicated.
 *
 * They are deliberately not derived from git. Two earlier attempts did, and
 * neither survives this repository: naming parents of HEAD breaks the moment a
 * commit lands on top, and walking merge commits breaks under the squash merge
 * `feature/*` branches get — after which the merges do not exist — and in the
 * CI job that runs these tests, which checks out at depth 1 with no
 * `origin/develop` to walk from. Files on disk survive all of it.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const combinedMigrations = path.join(repoRoot, 'migrations');

type MigrationState = {
  tag: string;
  when: number;
  file: string;
  origin: string;
  /** Combined-tree file this fixture must still match byte for byte, or null. */
  sameContentAs: string | null;
};

const fixtureDir = path.join(__dirname, 'fixtures/migration-states');
const fixtures = JSON.parse(readFileSync(path.join(fixtureDir, 'states.json'), 'utf8')) as {
  baseThroughIdx: number;
  states: Record<'push' | 'link', MigrationState>;
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
 * Rebuild the migrations folder one chain had before the two were combined:
 * everything they shared, then that chain's own migration under its own number
 * and its own `when`.
 */
function migrationsFor(which: 'push' | 'link'): string {
  const state = fixtures.states[which];
  const dir = mkdtempSync(path.join(tmpdir(), `gogo-migrations-${which}-`));
  mkdirSync(path.join(dir, 'meta'), { recursive: true });

  const shared = journalOf(combinedMigrations).entries.filter(
    (e) => e.idx <= fixtures.baseThroughIdx,
  );
  expect(shared.length).toBeGreaterThan(10);
  for (const entry of shared) {
    const sql = `${entry.tag}.sql`;
    copyFileSync(path.join(combinedMigrations, sql), path.join(dir, sql));
  }
  copyFileSync(path.join(fixtureDir, state.file), path.join(dir, `${state.tag}.sql`));

  const entries = [
    ...shared,
    {
      idx: shared[shared.length - 1]!.idx + 1,
      version: '7',
      when: state.when,
      tag: state.tag,
      breakpoints: true,
    },
  ];
  writeFileSync(
    path.join(dir, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2),
  );
  return dir;
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
 * these two chains touch, ordered so two databases compare as text.
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_migration_base')
    .start();
}, 240_000);

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  await container?.stop();
});

describe('combined migration ordering (#193 + #204–#206)', () => {
  it('the combined journal is monotonic in `when` — the only thing Drizzle orders by', async () => {
    const journal = JSON.parse(
      readFileSync(path.join(combinedMigrations, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const whens = journal.entries.map((e) => e.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
    // The two chains' migrations, in the order the combined history applies them.
    const tail = journal.entries.slice(-2).map((e) => e.tag);
    expect(tail).toEqual(['0044_notification-push-delivery', '0045_share-links']);
  });

  it('the fixtures still describe the migrations they were taken from', () => {
    // Drift protection. These files are frozen history; if a combined migration
    // is edited, this fails and someone has to decide what it means for a
    // database already holding the old one — rather than the suite quietly
    // proving an upgrade path nobody ships any more.
    const push = fixtures.states.push;
    expect(push.sameContentAs).toBe('0044_notification-push-delivery.sql');
    expect(readFileSync(path.join(fixtureDir, push.file), 'utf8')).toBe(
      readFileSync(path.join(combinedMigrations, push.sameContentAs ?? ''), 'utf8'),
    );

    // The link fixture is deliberately NOT identical: it predates the guards
    // that make the migration replay-safe, and replay is the whole point of
    // raising its `when` above the push migration.
    const link = readFileSync(path.join(fixtureDir, fixtures.states.link.file), 'utf8');
    const combinedLink = readFileSync(
      path.join(combinedMigrations, '0045_share-links.sql'),
      'utf8',
    );
    expect(link).not.toBe(combinedLink);
    expect(link).toMatch(/^CREATE TYPE share_link_type/m);
    expect(combinedLink).not.toMatch(/^CREATE TYPE share_link_type/m);
    expect(combinedLink).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'share_link_type'\)/,
    );
  });

  it('an empty database gets both migrations', async () => {
    const db = await database('gogo_from_empty');
    await migrate(db, { migrationsFolder: combinedMigrations });
    const applied = await appliedMigrations(db);
    expect(applied).toContain(1789084800000);
    expect(applied).toContain(1789171200000);
    const schema = await schemaOf(db);
    expect(schema.columns.map((c) => `${c.table_name}.${c.column_name}`)).toContain(
      'notifications.push_sent_at',
    );
    expect(schema.columns.map((c) => `${c.table_name}.${c.column_name}`)).toContain(
      'share_links.slug_hash',
    );
  });

  it('a database that already ran the push chain upgrades to the same schema', async () => {
    const db = await database('gogo_from_push');
    // Its history: develop + #193/#199, where the push migration was numbered
    // 0045 and share_links did not exist.
    await migrate(db, { migrationsFolder: migrationsFor('push') });
    const before = await appliedMigrations(db);
    expect(before.at(-1)).toBe(1789084800000);
    const { rows: noShareLinks } = await db.execute(
      sql`select to_regclass('public.share_links') as t`,
    );
    expect((noShareLinks[0] as { t: string | null }).t).toBeNull();

    await migrate(db, { migrationsFolder: combinedMigrations });

    const after = await appliedMigrations(db);
    // The push migration is NOT re-applied: same `when`, already recorded.
    expect(after.filter((w) => w === 1789084800000)).toHaveLength(1);
    // share_links arrives, because its `when` is the larger one.
    expect(after).toContain(1789171200000);
    const { rows: hasShareLinks } = await db.execute(
      sql`select to_regclass('public.share_links') as t`,
    );
    expect((hasShareLinks[0] as { t: string | null }).t).not.toBeNull();
  });

  it('a database that already ran the link chain upgrades, re-running share_links harmlessly', async () => {
    const db = await database('gogo_from_link');
    // Its history: the link chain tip, where share_links was 0044 with a
    // SMALLER `when` than the push migration — so the combined journal replays
    // it after the push migration. It must be idempotent, or this throws.
    await migrate(db, { migrationsFolder: migrationsFor('link') });
    const before = await appliedMigrations(db);
    expect(before.at(-1)).toBe(1788998400000);

    // A row written under the old numbering must survive the replay.
    await db.execute(sql`
      insert into share_links (slug_hash, type, target_id, provider)
      values ('deadbeef', 'PLACE', '00000000-0000-4000-8000-000000000001', 'TENJIN')
    `);

    await migrate(db, { migrationsFolder: combinedMigrations });

    const after = await appliedMigrations(db);
    expect(after).toContain(1789084800000);
    expect(after).toContain(1789171200000);
    const { rows: survivors } = await db.execute(sql`select slug_hash from share_links`);
    expect(survivors).toHaveLength(1);
    const columns = (await schemaOf(db)).columns.map((c) => `${c.table_name}.${c.column_name}`);
    expect(columns).toContain('notifications.push_sent_at');
  });

  it('all three histories end at exactly the same schema', async () => {
    const [empty, fromPush, fromLink] = await Promise.all([
      database('gogo_cmp_empty'),
      database('gogo_cmp_push'),
      database('gogo_cmp_link'),
    ]);
    await migrate(empty, { migrationsFolder: combinedMigrations });
    await migrate(fromPush, { migrationsFolder: migrationsFor('push') });
    await migrate(fromPush, { migrationsFolder: combinedMigrations });
    await migrate(fromLink, { migrationsFolder: migrationsFor('link') });
    await migrate(fromLink, { migrationsFolder: combinedMigrations });

    const [a, b, c] = await Promise.all([schemaOf(empty), schemaOf(fromPush), schemaOf(fromLink)]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // And the comparison is not vacuous.
    expect(a.columns.length).toBeGreaterThan(30);
    expect(a.enums.map((e) => e.enumlabel)).toContain('ROOM_INVITE');
  });
});
