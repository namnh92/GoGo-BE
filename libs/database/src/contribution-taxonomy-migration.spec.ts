import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

it('F-05 locks, seeds and advances the generation in one Drizzle transaction', async () => {
  const folder = path.resolve(__dirname, '../../../migrations');
  const journal = JSON.parse(await readFile(path.join(folder, 'meta/_journal.json'), 'utf8'));
  const prior = journal.entries.find((entry: { tag: string }) => entry.tag.startsWith('0087_'));
  const statements: string[] = [];
  // Record the real migrator's driver calls. PostgreSQL behavior is covered by
  // contribution-taxonomy-migration.int.spec.ts; this also runs without Docker.
  const client = {
    query: async ({ text }: { text: string }) => {
      statements.push(text.trim());
      return {
        rows: text.includes('order by created_at desc limit 1')
          ? [{ id: 1, hash: 'legacy', created_at: prior.when }]
          : [],
      };
    },
  };
  await migrate(drizzle(client as unknown as Client), { migrationsFolder: folder });
  const begin = statements.findIndex((sql) => /^begin$/i.test(sql));
  const lock = statements.findIndex((sql) =>
    /select\s+id\s+from\s+taxonomy_version\s+where\s+id\s*=\s*1\s+for\s+update/i.test(sql),
  );
  const seeds = statements.findIndex((sql) => /INSERT INTO taxonomies\(/i.test(sql));
  const labels = statements.findIndex((sql) => /INSERT INTO taxonomy_labels\(/i.test(sql));
  const bumps = statements.filter((sql) =>
    /update\s+taxonomy_version\s+set\s+version\s*=\s*version\s*\+\s*1\s*,\s*updated_at\s*=\s*clock_timestamp\(\)\s+where\s+id\s*=\s*1/i.test(
      sql,
    ),
  );
  expect(lock, 'migration must serialize with CMS taxonomy writers').toBeGreaterThan(begin);
  expect(seeds).toBeGreaterThan(lock);
  expect(labels).toBeGreaterThan(seeds);
  expect(bumps, 'migration must invalidate cached taxonomy validators exactly once').toHaveLength(
    1,
  );
  const bump = statements.indexOf(bumps[0]!);
  expect(bump).toBeGreaterThan(labels);
  expect(statements.slice(begin + 1, bump)).not.toContain('commit');
  expect(statements.at(-1)).toBe('commit');
});
