import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PLACE_NAME_KEY_WHITESPACE } from './schema/places';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const expression = `btrim(regexp_replace(name_normalized, '${PLACE_NAME_KEY_WHITESPACE}', ' ', 'g'), ' ')`;

it('#857 ships the exact-name key as an additive, non-rewriting successor migration', () => {
  const migration = read(path.join(root, 'migrations/0102_place-name-key-index.sql')).replace(
    /--[^\n]*/g,
    '',
  );
  // An expression index: no column, no table rewrite, no data change.
  expect(migration.trim()).toBe('SELECT 1;');
  expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  expect(migration).not.toMatch(/CONCURRENTLY/i);
  const journal = JSON.parse(read(path.join(root, 'migrations/meta/_journal.json')) || '{}') as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const entry = journal.entries.find((e) => e.tag === '0102_place-name-key-index');
  expect(entry).toMatchObject({ idx: 102 });
  // Drizzle skips an entry whose `when` is not strictly newer than the last applied one.
  expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 101)!.when);
  expect(journal.entries.filter((e) => e.idx === 102)).toHaveLength(1);
});

it('#857 requires the index CONCURRENTLY outside the migration, with an exact-shape readiness check', () => {
  const ops = read(path.join(root, 'scripts/ops/index-place-name-key.sql'));
  expect(ops).toContain(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS places_name_key_idx ON places ((${expression}))`,
  );
  expect(ops).toContain('places_name_key_idx_ready');
  expect(ops).toMatch(/i\.indisvalid AND i\.indisready/);
  expect(ops.replace(/--[^\n]*/g, '')).not.toMatch(/\bBEGIN\b/i);
});

it('round-4: transactional migration never builds an index or locks places', () => {
  const migration = read(path.join(root, 'migrations/0102_place-name-key-index.sql')).replace(
    /--[^\n]*/g,
    '',
  );
  expect(migration).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX|LOCK\s+TABLE/i);
});
