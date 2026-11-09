import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { schema, Db } from '@gogo/database';
import { FakePush, ProviderUnavailableError } from '@gogo/providers';
import { OutboxDispatcher, recipientPushKey } from './outbox-dispatcher';

const userId = '00000000-0000-4000-8000-000000000001';
const roomId = '00000000-0000-4000-8000-000000000002';
const event = {
  id: '00000000-0000-4000-8000-000000000003',
  eventType: 'plan.published',
  eventVersion: 1,
  actorId: null,
  correlationId: null,
  payloadSchemaVersion: 1,
  resourceType: 'room',
  resourceId: roomId,
  payload: {},
  occurredAt: new Date('2026-11-09T16:00:00Z'),
  publishedAt: null,
  attempts: 0,
  lastError: null,
  nextAttemptAt: null,
  failedAt: null,
} satisfies typeof schema.outboxEvents.$inferSelect;

/** Isolate delivery from inbox staging; PostgreSQL cohort/publication coverage
 * remains in notification-settings.int.spec.ts. No provider or database I/O.
 */
function fixture(options: { deferred?: boolean; enabled?: boolean; missing?: boolean } = {}) {
  const statements: { sql: string; params: unknown[] }[] = [];
  let eligible = true;
  const execute = vi.fn(async (query: SQL) => {
    const statement = new PgDialect().sqlToQuery(query);
    statements.push(statement);
    if (statement.sql.includes('select user_id'))
      return {
        rows: [{ user_id: userId, deferred_until: options.deferred ? '2026-11-09' : null }],
      };
    if (statement.sql.includes('returning user_id')) return { rows: [{ user_id: userId }] };
    if (statement.sql.includes('select u.id, u.locale'))
      return { rows: eligible ? [{ id: userId, locale: 'vi' }] : [] };
    if (statement.sql.includes('select id from users')) return { rows: [{ id: userId }] };
    if (statement.sql.includes('select quiet_hours_enabled'))
      return {
        rows: options.missing
          ? []
          : [
              {
                quiet_hours_enabled: options.enabled ?? false,
                timezone: 'UTC',
                now: '2026-11-09T23:30:00Z',
              },
            ],
      };
    return { rows: [] };
  });
  const db = {
    execute,
    transaction: async (run: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      run({ execute }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as Db;
  const push = new FakePush();
  const worker = new OutboxDispatcher(db, push);
  // Test the attempt seam without fabricating the unrelated inbox query builder.
  const delivery = worker as unknown as {
    drainDeliveries(
      event: typeof schema.outboxEvents.$inferSelect,
      mapping: { kind: 'plan_ready'; audience: 'members' },
      roomId: string,
      staged: null,
    ): Promise<void>;
  };
  return {
    push,
    statements,
    leave: () => {
      eligible = false;
    },
    run: (eventType = event.eventType) =>
      delivery.drainDeliveries(
        { ...event, eventType },
        { kind: 'plan_ready', audience: 'members' },
        roomId,
        null,
      ),
  };
}

describe('ADR-0050 existing-producer retry ownership (#817)', () => {
  it.each([true, false])(
    'keeps transient failure pending when settings missing=%s',
    async (missing) => {
      const { push, run, statements } = fixture({ missing });
      const send = vi.spyOn(push, 'sendToUsers');
      push.unavailable = true;
      await expect(run()).rejects.toBeInstanceOf(ProviderUnavailableError);
      const reset = statements.at(-1)!.sql;
      expect(reset).toContain("set status = 'pending', lease_until = null");
      expect(reset).not.toContain('deferred_attempts');
      push.unavailable = false;
      await run();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
        recipientPushKey(event.id, userId),
        recipientPushKey(event.id, userId),
      ]);
    },
  );

  it('terminally suppresses a staged recipient who left, even with no current cohort', async () => {
    const { push, run, statements, leave } = fixture();
    push.unavailable = true;
    await expect(run()).rejects.toBeInstanceOf(ProviderUnavailableError);
    leave();
    push.unavailable = false;
    await run();
    expect(push.sent).toHaveLength(0);
    expect(
      statements.some((q) => q.sql.includes('set status = $1') && q.params[0] === 'suppressed'),
    ).toBe(true);
  });

  it('hands opted-in quiet work to the ledger without attempting the provider', async () => {
    const { push, run, statements } = fixture({ enabled: true });
    await run();
    expect(push.sent).toHaveLength(0);
    expect(statements.find((q) => q.sql.includes("set status = 'deferred'"))?.params).toContain(
      '2026-11-10T07:00:00.000Z',
    );
  });

  it('retains ledger retry ownership after quiet hours are disabled', async () => {
    const { push, run, statements } = fixture({ deferred: true });
    push.unavailable = true;
    await expect(run()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(statements.at(-1)!.sql).toContain('deferred_attempts = deferred_attempts + 1');
  });

  it('preserves PR4 advance-reminder bounded ledger retries', async () => {
    const { push, run, statements } = fixture();
    push.unavailable = true;
    await expect(run('room.reminder_due')).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(statements.at(-1)!.sql).toContain('deferred_attempts = deferred_attempts + 1');
    expect(statements.at(-1)!.params).toContain(6);
  });
});
