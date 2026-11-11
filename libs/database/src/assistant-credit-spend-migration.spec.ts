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

it('D2 builds the existing-outbox index concurrently outside migration transaction', () => {
  const migration = readFileSync(
    path.join(root, 'migrations/0100_assistant-credit-settlement.sql'),
    'utf8',
  ).replace(/--[^\n]*/g, '');
  expect(migration).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]+outbox_events/i);
  const ops = readFileSync(path.join(root, 'scripts/ops/index-assistant-credit-spend.sql'), 'utf8');
  expect(ops).toMatch(
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS assistant_credit_settlement_outbox_due/,
  );
  expect(ops).toContain('assistant_credit_settlement_outbox_due_ready');
});
