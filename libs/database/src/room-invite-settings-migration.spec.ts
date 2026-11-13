import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

it.each([105, 106])(
  '#906 migrates once above 0%i without touching existing credentials',
  async (previousIdx) => {
    const root = path.resolve(__dirname, '../../..');
    const read = (name: string) => readFileSync(path.join(root, name), 'utf8');
    const journal = JSON.parse(read('migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const previous = journal.entries.find((e) => e.idx === previousIdx)!;
    const entry = journal.entries.find((e) => e.idx === 107)!;
    expect(entry.tag).toBe('0107_room-invite-settings');
    expect(entry.when).toBe(1794441600107);
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
    expect(queries.filter((q) => /CREATE TABLE room_invite_settings/.test(q))).toHaveLength(1);
    expect(queries.at(-1)).toBe('commit');
    const migration = read(`migrations/${entry.tag}.sql`).replace(/--[^\n]*/g, '');
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '15s'");
    expect(migration).toContain('ON CONFLICT (id) DO NOTHING');
    expect(migration).toContain('room_invite_ttl.initialized');
    expect(migration).not.toMatch(
      /\b(?:UPDATE|DELETE|TRUNCATE|ALTER)\s+(?:rooms|room_invites|share_links|room_invite_codes)\b/i,
    );
    const down = read('scripts/rollback/0107-room-invite-settings.sql');
    expect(down.indexOf('RAISE EXCEPTION')).toBeLessThan(down.indexOf('DROP TABLE'));
    expect(down).not.toMatch(/DELETE FROM audit_logs|__drizzle_migrations/i);
  },
);
