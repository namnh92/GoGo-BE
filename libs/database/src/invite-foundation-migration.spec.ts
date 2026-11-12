import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const read = (name: string) => readFileSync(path.join(root, name), 'utf8');
const journal = JSON.parse(read('migrations/meta/_journal.json')) as {
  entries: { idx: number; when: number; tag: string }[];
};
it('I03 runs above the installed 0103 watermark, once, and never scans populated tables under ADD COLUMN locks', async () => {
  const previous = journal.entries.find((entry) => entry.idx === 103)!;
  const entry = journal.entries.find((entry) => entry.tag === '0104_invite-foundation')!;
  expect(previous.tag).toBe('0103_place-aliases');
  expect(entry.idx).toBe(104);
  expect(entry.when).toBeGreaterThan(previous.when);
  expect(new Set(journal.entries.map((e) => e.when)).size).toBe(journal.entries.length);
  const queries: string[] = [];
  const client = {
    query: async ({ text }: { text: string }) => {
      queries.push(text.trim());
      return {
        rows: text.includes('order by created_at desc limit 1')
          ? [{ id: 1, hash: 'snapshot', created_at: previous.when }]
          : [],
      };
    },
  };
  await migrate(drizzle(client as unknown as Client), {
    migrationsFolder: path.join(root, 'migrations'),
  });
  expect(queries.join('\n').match(/ADD COLUMN invitation_epoch bigint/gi)).toHaveLength(3);
  expect(queries.filter((query) => /create table room_invite_codes/i.test(query))).toHaveLength(1);
  expect(queries.at(-1)).toBe('commit');
  const migration = read('migrations/0104_invite-foundation.sql').replace(/--[^\n]*/g, '');
  expect(migration).not.toMatch(
    /\b(?:UPDATE|DELETE|TRUNCATE)\s+(?:rooms|users|room_invites|share_links)\b/i,
  );
  expect(migration).not.toMatch(/CONCURRENTLY|VALIDATE CONSTRAINT/i);
  const tables = [...migration.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+(\w+)/gi)].map(
    (m) => m[1],
  );
  expect(tables).toEqual(['room_invite_codes', 'room_invite_codes', 'room_invite_codes']);
  const ops = read('scripts/ops/prepare-invite-foundation.sql').replace(/--[^\n]*/g, '');
  expect(ops).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_host_share_id_unique/);
  expect(ops).toContain('VALIDATE CONSTRAINT share_links_path_metadata');
  expect(ops).not.toMatch(/\bBEGIN\b/i);
});
it('I03 index names do not collide with any prior migration; down refuses durable state', () => {
  const created = [
    ...read('migrations/0104_invite-foundation.sql').matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/gi,
    ),
  ].map((m) => m[1]!);
  const prior = journal.entries
    .filter((e) => e.idx < 104)
    .map((e) => read(`migrations/${e.tag}.sql`))
    .join('\n');
  for (const name of [...created, 'users_host_share_id_unique']) expect(prior).not.toContain(name);
  const rollback = read('scripts/rollback/0104-invite-foundation.sql');
  expect(rollback.indexOf("RAISE EXCEPTION 'invite foundation has durable state")).toBeLessThan(
    rollback.indexOf('DROP TABLE'),
  );
});
