import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

it('applies host transfer above the installed invite-foundation watermark', async () => {
  const root = path.resolve(__dirname, '../../..');
  const journal = JSON.parse(
    readFileSync(path.join(root, 'migrations/meta/_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const prior = journal.entries.find((e) => e.tag === '0104_invite-foundation')!;
  const transfer = journal.entries.find((e) => e.tag === '0105_room-host-transfer')!;
  expect(transfer.idx).toBe(105);
  expect(transfer.when).toBeGreaterThan(prior.when);
  const queries: string[] = [];
  const client = {
    query: async ({ text }: { text: string }) => {
      queries.push(text.trim());
      return {
        rows: text.includes('order by created_at desc limit 1')
          ? [{ id: 1, hash: 'snapshot', created_at: prior.when }]
          : [],
      };
    },
  };
  await migrate(drizzle(client as unknown as Client), {
    migrationsFolder: path.join(root, 'migrations'),
  });
  expect(queries.join('\n')).toContain('room_host_transfer_rollout');
  expect(queries.join('\n')).toContain('CREATE TABLE invite_attempt_contexts');
  expect(queries.join('\n')).not.toMatch(/CREATE TABLE.*room_invite_codes/i);
  expect(
    queries.filter((q) => q.startsWith('insert into "drizzle"."__drizzle_migrations"')),
  ).toHaveLength(2);
  expect(queries.at(-1)).toBe('commit');
});
