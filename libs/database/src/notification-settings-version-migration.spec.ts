import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

/**
 * #817 F-05 — `notification_settings` is a hot table. The `version` CHECK is
 * added NOT VALID so 0094 never scans existing rows under the ACCESS EXCLUSIVE
 * lock the ADD COLUMN takes; the scan runs later, under SHARE UPDATE EXCLUSIVE,
 * from `scripts/ops/validate-notification-settings-version.sql` (0084 pattern).
 */
it.each(['empty', '0093'])(
  'adds the version CHECK NOT VALID and validates it only after the migrator commits, from %s',
  async (state) => {
    const journal = JSON.parse(
      await readFile(path.join(root, 'migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const prior = journal.entries.find((entry) => entry.tag.startsWith('0093_'))!;
    const statements: string[] = [];
    // Record the real Drizzle migrator's driver calls, without simulating PG locks.
    const client = {
      query: async ({ text }: { text: string }) => {
        statements.push(text.trim());
        return {
          rows:
            text.includes('order by created_at desc limit 1') && state === '0093'
              ? [{ id: 1, hash: 'legacy', created_at: prior.when }]
              : [],
        };
      },
    };
    await migrate(drizzle(client as unknown as Client), {
      migrationsFolder: path.join(root, 'migrations'),
    });
    const add = statements.findIndex((sql) =>
      /ALTER TABLE notification_settings ADD COLUMN version bigint NOT NULL DEFAULT 0;/i.test(sql),
    );
    expect(add, 'the column is added with a constant default and no inline CHECK').toBeGreaterThan(
      -1,
    );
    expect(statements[add]!.replace(/--[^\n]*/g, '')).not.toMatch(/CHECK/i);
    expect(
      statements.filter((sql) =>
        /ADD CONSTRAINT notification_settings_version_check CHECK \(version >= 0\) NOT VALID/i.test(
          sql,
        ),
      ),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) =>
        /VALIDATE CONSTRAINT notification_settings_version_check/i.test(sql),
      ),
      'Drizzle retains the ADD COLUMN lock until its final COMMIT; validation must run later',
    ).toEqual([]);
    const committed = statements.findIndex((sql, index) => index > add && /^commit$/i.test(sql));
    expect(committed).toBeGreaterThan(add);

    const validation = await readFile(
      path.join(root, 'scripts/ops/validate-notification-settings-version.sql'),
      'utf8',
    );
    const separate = validation
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean);
    expect(separate[0]).toBe('BEGIN');
    expect(separate.at(-1)).toBe('COMMIT');
    for (const sql of separate) await client.query({ text: sql });
    const validate = statements.findIndex((sql) =>
      /VALIDATE CONSTRAINT notification_settings_version_check/i.test(sql),
    );
    expect(validate).toBeGreaterThan(committed);
    expect(statements.slice(committed + 1, validate)).toContain('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
  },
);
