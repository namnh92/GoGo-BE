import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from './client';
import {
  collapseNotificationCategoriesBatch,
  disableNotificationRecipientKeys,
  enableNotificationRecipientKeys,
  resumeNotificationProducers,
} from './notification-categories';

function database(...rows: Record<string, unknown>[][]) {
  const statements: string[] = [];
  const execute = vi.fn(async (query: SQL) => {
    statements.push(new PgDialect().sqlToQuery(query).sql);
    return { rows: rows.shift() ?? [] };
  });
  const db = { execute, transaction: async (run: (tx: unknown) => unknown) => run({ execute }) };
  return { db: db as unknown as Db, statements };
}

describe('notification binary transition gates', () => {
  for (const [name, transition] of [
    ['roll-forward', enableNotificationRecipientKeys],
    ['rollback', disableNotificationRecipientKeys],
  ] as const) {
    it(`${name} requires a durable producer fence`, async () => {
      const { db, statements } = database([{ producers_frozen: false }]);
      await expect(transition(db, ['plan.published'])).rejects.toThrow('Quiesce');
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('for update');
    });

    it(`${name} refuses unresolved/ambiguous delivery without changing keys or suppression`, async () => {
      const { db, statements } = database([{ producers_frozen: true }], [{ '?column?': 1 }]);
      await expect(transition(db, ['plan.published'])).rejects.toThrow('existing provider keys');
      expect(statements).toHaveLength(2);
      // Both generations, including events produced after an earlier cutover
      // and dead letters, must reconcile. Terminal ledgers stay untouched.
      expect(statements[1]).toContain('e.published_at is null');
      expect(statements[1]).not.toMatch(/occurred_at|cutover_at|failed_at/);
      expect(statements[1]).toContain("status in ('pending', 'attempting')");
      // Published quiet-hour work remains unresolved, even before its wake time.
      expect(statements[1]).toContain("or status = 'deferred'");
      // #817 F-01: a campaign a worker is still walking is in-flight work too.
      expect(statements[1]).toContain("notification_campaigns where status = 'sending'");
      expect(
        statements.every((statement) => !/^\s*(update|delete|insert)\b/i.test(statement)),
      ).toBe(true);
    });
  }

  it('collapses an account whose terminally suppressed campaign delivery an old worker could resume (#817 F-01)', async () => {
    const { db, statements } = database([{ writes_frozen: true }], []);
    expect(await collapseNotificationCategoriesBatch(db)).toBe(0);
    expect(statements).toHaveLength(2);
    const candidate = statements[1]!;
    expect(candidate).toContain('not cp.enabled');
    // Only a dispatch the previous release can still pick up or reopen: its kept
    // key, under `scheduled`/`sending`/`failed`. `sent` has no outgoing
    // transition and a cancel clears the key, so neither is ever retried.
    expect(candidate).toContain("c.status in ('scheduled', 'sending', 'failed')");
    expect(candidate).toContain('c.dispatch_key is not null');
    expect(candidate).toContain("n.kind = 'campaign'");
    expect(candidate).toContain('n.push_sent_at is null and n.push_suppressed_at is not null');
    expect(candidate).toContain("'campaign:' || c.dispatch_key::text || ':' || u.id::text");
  });

  it('closes recipient dispatch and freezes writes only after rollback reconciliation', async () => {
    const { db, statements } = database([{ producers_frozen: true }], []);
    await disableNotificationRecipientKeys(db, ['plan.published']);
    expect(statements[2]).toContain('writes_frozen = true, recipient_keys_enabled = false');
  });

  it('reopens recipient keys only after the complete roll-forward drain', async () => {
    const { db, statements } = database([{ producers_frozen: true }], []);
    await enableNotificationRecipientKeys(db, ['plan.published']);
    expect(statements[2]).toContain('recipient_keys_enabled = true');
  });

  it('keeps producers fenced until rollback consent collapse is complete', async () => {
    const { db, statements } = database(
      [{ recipient_keys_enabled: false, writes_frozen: true }],
      [{ '?column?': 1 }],
    );
    await expect(resumeNotificationProducers(db)).rejects.toThrow('Complete rollback collapse');
    expect(statements).toHaveLength(2);
  });

  it('cannot bypass the initial cutover by resuming producers', async () => {
    const { db } = database([{ recipient_keys_enabled: false, writes_frozen: false }], []);
    await expect(resumeNotificationProducers(db)).rejects.toThrow('Complete rollback collapse');
  });
});
