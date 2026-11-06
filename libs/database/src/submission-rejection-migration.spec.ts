import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

it.each(['empty', '0081'])(
  'commits additive DDL before the separate validation invocation from %s (#787 F-01)',
  async (state) => {
    const journal = JSON.parse(
      await readFile(path.join(root, 'migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const prior = journal.entries.find((entry) => entry.tag.startsWith('0081_'))!;
    const statements: string[] = [];
    // Record the real Drizzle migrator's driver calls, without simulating PG locks.
    const client = {
      query: async ({ text }: { text: string }) => {
        statements.push(text.trim());
        return {
          rows:
            text.includes('order by created_at desc limit 1') && state === '0081'
              ? [{ id: 1, hash: 'legacy', created_at: prior.when }]
              : [],
        };
      },
    };
    await migrate(drizzle(client as unknown as Client), {
      migrationsFolder: path.join(root, 'migrations'),
    });
    const add = statements.findIndex((sql) => /ADD COLUMN rejection_reason/i.test(sql));
    expect(add).toBeGreaterThan(-1);
    expect(
      statements.filter((sql) =>
        /VALIDATE CONSTRAINT place_submissions_rejection_reason_check/i.test(sql),
      ),
      'Drizzle retains ADD COLUMN locks until its final COMMIT; validation must run later',
    ).toEqual([]);
    const committed = statements.findIndex((sql, index) => index > add && /^commit$/i.test(sql));
    expect(committed).toBeGreaterThan(add);

    const validation = await readFile(
      path.join(root, 'scripts/ops/validate-submission-rejection-reason.sql'),
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
      /VALIDATE CONSTRAINT place_submissions_rejection_reason_check/i.test(sql),
    );
    expect(validate).toBeGreaterThan(committed);
    expect(statements.slice(committed + 1, validate)).toContain('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
  },
);
