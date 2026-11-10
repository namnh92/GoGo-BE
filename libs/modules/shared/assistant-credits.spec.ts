import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { grantSubmissionCredits, submissionCreditFacts } from './assistant-credits';
import { CREDIT_SEEDS } from './credit-catalogue';
import { type LegacyCreditRow, legacyCreditEntitlements } from './credit-grants';

const dialect = new PgDialect();
function fixture(legacy: LegacyCreditRow[] = []) {
  const keys = new Set<string>();
  const deltas: number[] = [];
  const metadata: unknown[][] = [];
  const trace: string[] = [];
  let balance = 0;
  const rules = CREDIT_SEEDS.slice(0, 2).map((s) => ({
    id: s.id,
    key: s.key,
    amount: s.amount,
    status: 'active',
    max_per_user: null,
  }));
  const execute = vi.fn(async (query) => {
    const { sql, params } = dialect.sqlToQuery(query);
    trace.push(sql);
    if (sql.includes('select id from users')) return { rows: [{ id: 'user' }] };
    if (sql.includes("from assistant_credit_ledger where reason='submission_approved'"))
      return { rows: legacy };
    if (sql.includes('select * from credit_events')) return { rows: rules };
    if (sql.includes('select ledger_id from credit_entitlements'))
      return { rows: keys.has(`${params[0]}:${params[1]}`) ? [{ id: 'existing' }] : [] };
    if (sql.includes('count(distinct e.ledger_id)')) return { rows: [{ n: 0 }] };
    if (sql.startsWith('update credit_events')) return { rows: [{ id: 'reserved' }] };
    if (sql.startsWith('update assistant_credit_ledger')) return { rows: [{ id: legacy[0]?.id }] };
    if (sql.startsWith('insert into credit_entitlements')) keys.add(`${params[0]}:${params[1]}`);
    if (sql.startsWith('insert into assistant_credit_ledger')) {
      deltas.push(Number(params[2]));
      metadata.push(params);
    }
    if (sql.startsWith('insert into assistant_credit_accounts')) balance += Number(params[1]);
    return { rows: [] };
  });
  return { execute, keys, deltas, trace, metadata, balance: () => balance };
}
describe('moderator accepted evidence component grants', () => {
  it.each([
    [true, 0, 50],
    [true, 1, 60],
    [true, 5, 60],
    [false, 1, 10],
    [false, 5, 10],
  ])('base=%s accepted photos=%s grants %s once', async (base, count, total) => {
    const f = fixture();
    const user = randomUUID(),
      submission = randomUUID();
    await grantSubmissionCredits(
      f as never,
      user,
      submission,
      'google:ABC',
      Number(count),
      Boolean(base),
    );
    await grantSubmissionCredits(
      f as never,
      user,
      submission,
      'google:ABC',
      Number(count),
      Boolean(base),
    );
    expect(f.balance()).toBe(total);
    expect(f.deltas).toEqual(base ? (count ? [50, 10] : [50]) : [10]);
    expect(f.keys.size).toBe(f.deltas.length);
    expect(
      f.metadata.every((params) => params[8] === submission && params[9] === 'google:ABC'),
    ).toBe(true);
    expect(submissionCreditFacts(Number(count), Boolean(base)).total).toBe(total);
    expect(f.trace.some((t) => t.includes('pg_advisory'))).toBe(false); // Entry took locks before domain; never reacquire here.
  });
  it.each([20, 50, 70])(
    'reconciles a conflicting historical %i before any missing evidence component',
    async (delta) => {
      const user = randomUUID(),
        submission = randomUUID();
      const row: LegacyCreditRow = {
        id: randomUUID(),
        user_id: user,
        delta,
        submission_id: submission,
        venue_identity: 'google:ABC',
        credit_event_id: null,
      };
      const f = fixture([row]);
      await grantSubmissionCredits(f as never, user, submission, 'google:ABC', 1, true);
      expect(f.balance()).toBe(delta === 50 ? 10 : 0);
      expect(row.delta).toBe(delta);
      for (const key of legacyCreditEntitlements(row))
        expect(f.keys.has(`${key.eventId}:${key.key}`)).toBe(true);
      const attributed = f.trace.findIndex((t) => t.startsWith('update assistant_credit_ledger'));
      const paid = f.trace.findIndex((t) => t.startsWith('insert into assistant_credit_ledger'));
      if (paid >= 0) expect(attributed).toBeLessThan(paid);
    },
  );
  it('rolls back for rediscovery if a legacy row belongs to an account not held at entry', async () => {
    const f = fixture([
      {
        id: randomUUID(),
        user_id: randomUUID(),
        delta: 70,
        submission_id: randomUUID(),
        venue_identity: 'google:ABC',
        credit_event_id: null,
      },
    ]);
    await expect(
      grantSubmissionCredits(f as never, randomUUID(), randomUUID(), 'google:ABC', 1),
    ).rejects.toThrow();
    expect(f.deltas).toEqual([]);
    expect(f.keys.size).toBe(0);
  });
  it('merge without accepted evidence creates no ledger or account write', async () => {
    const execute = vi.fn();
    await grantSubmissionCredits({ execute }, 'user', 'submission', 'venue', 0, false);
    expect(execute).not.toHaveBeenCalled();
  });
});
