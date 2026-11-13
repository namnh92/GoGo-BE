import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

it('applies I05 once above the installed 0105 watermark without replaying prior migrations', async () => {
  const root = path.resolve(__dirname, '../../..');
  const journal = JSON.parse(
    readFileSync(path.join(root, 'migrations/meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  const prior = journal.entries.find((e) => e.tag === '0105_room-host-transfer')!;
  const entry = journal.entries.find((e) => e.tag === '0106_invite-attempt-contexts')!;
  expect(entry.tag).toBe('0106_invite-attempt-contexts');
  expect(entry.idx).toBe(106);
  expect(entry.when).toBeGreaterThan(prior.when);
  let watermark = prior.when;
  const queries: string[] = [];
  const client = {
    query: async ({ text }: { text: string }, values?: unknown[]) => {
      queries.push(text.trim());
      if (text.startsWith('insert into "drizzle"."__drizzle_migrations"'))
        watermark = Number(values![1]);
      return {
        rows: text.includes('order by created_at desc limit 1')
          ? [{ id: 1, hash: 'snapshot', created_at: watermark }]
          : [],
      };
    },
  };
  const db = drizzle(client as unknown as Client);
  const options = { migrationsFolder: path.join(root, 'migrations') };
  await migrate(db, options);
  expect(queries.filter((q) => /CREATE TABLE invite_attempt_contexts/i.test(q))).toHaveLength(1);
  expect(queries.join('\n')).not.toMatch(
    /room_host_transfer_rollout|CREATE TABLE room_invite_codes/,
  );
  expect(watermark).toBe(journal.entries.at(-1)!.when);
  expect(queries.at(-1)).toBe('commit');
  queries.length = 0;
  await migrate(db, options);
  expect(queries.join('\n')).not.toMatch(/invite_attempt|insert into "drizzle"/);
  expect(queries.at(-1)).toBe('commit');
});
