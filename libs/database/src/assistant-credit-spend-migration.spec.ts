import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

it('defers the existing usage ledger CHECK scan until post-commit validation (#852 F-01)', () => {
  const migration = readFileSync(
    path.join(root, 'migrations/0099_assistant-cost-credit-spending.sql'),
    'utf8',
  ).replace(/--[^\n]*/g, '');
  const addColumns = migration.match(/ALTER TABLE assistant_usage_ledger\s+ADD COLUMN[^;]+;/i)?.[0];
  expect(addColumns).toBeDefined();
  expect(addColumns).not.toMatch(/\bCHECK\s*\(/i);
  expect(migration).toMatch(
    /ALTER TABLE assistant_usage_ledger\s+ADD CONSTRAINT assistant_usage_ledger_cost_revision_check\s+CHECK\s*\(cost_revision\s*>=\s*0\)\s+NOT VALID\s*;/i,
  );
  expect(migration).not.toMatch(/VALIDATE CONSTRAINT assistant_usage_ledger_cost_revision_check/i);
  const validation = readFileSync(
    path.join(root, 'scripts/ops/validate-assistant-credit-spend.sql'),
    'utf8',
  );
  expect(validation).toMatch(
    /ALTER TABLE assistant_usage_ledger\s+VALIDATE CONSTRAINT assistant_usage_ledger_cost_revision_check\s*;/i,
  );
});
