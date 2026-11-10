import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { FakePush } from '@gogo/providers';
import { CampaignDispatcher } from './campaign-dispatcher';

const userId = '00000000-0000-4000-8000-000000000001';
const campaign = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Preview',
  body: 'Preview body',
  image_key: null,
  audience_type: 'platform',
  audience_filter: { platform: 'android' },
  destination_type: 'home',
  destination_value: null,
  dispatch_key: 'dispatch',
  test_send_user_id: userId,
};

function database(testSend: boolean, eligible = true, suppressed = false) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const statement = new PgDialect().sqlToQuery(query);
    statements.push(statement);
    if (statement.sql.includes('select id from users')) return { rows: [{ id: userId }] };
    if (statement.sql.includes('returning id, title, body')) return { rows: [campaign] };
    if (statement.sql.includes('select n.id, n.push_sent_at'))
      return {
        rows: [
          { id: 'inbox-row', push_sent_at: null, push_suppressed_at: suppressed ? 'now' : null },
        ],
      };
    if (statement.sql.includes('select u.id from users u'))
      return { rows: eligible || !statement.sql.includes('where u.id =') ? [{ id: userId }] : [] };
    return { rows: [] };
  });
  const push = new FakePush();
  const dispatcher = new CampaignDispatcher(
    {
      execute,
      transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
        fn({ execute }),
    } as unknown as Db,
    push,
  );
  return {
    statements,
    push,
    run: () => (testSend ? dispatcher.deliverTestSends() : dispatcher.dispatchDue()),
  };
}

describe('composer test send eligibility', () => {
  it.each(['platform', 'couple', 'group'])(
    'previews outside %s targeting on an eligible account',
    async (audience) => {
      const original = campaign.audience_type;
      campaign.audience_type = audience;
      try {
        const { run, push, statements } = database(true);
        await run();
        expect(push.sent).toHaveLength(1);
        const final = statements.find((q) => q.sql.includes('where u.id ='))!;
        expect(final.sql).not.toMatch(/ps.platform =|join rooms/);
        expect(final.sql).toContain("u.status <> 'deleted'");
        expect(final.sql).toContain('ps.revoked_at is null');
        expect(final.sql).toContain('ns.push_enabled');
      } finally {
        campaign.audience_type = original;
      }
    },
  );

  it('keeps platform targeting on real campaign delivery', async () => {
    const { run, statements } = database(false);
    await run();
    const final = statements.find((q) => q.sql.includes('where u.id ='))!;
    expect(final.sql).toContain('ps.platform =');
    expect(final.params).toContain('android');
  });

  it('still suppresses a preview when account eligibility/consent fails', async () => {
    const { run, push, statements } = database(true, false);
    await run();
    expect(push.sent).toHaveLength(0);
    expect(statements.some((q) => q.sql.includes('set push_suppressed_at = now()'))).toBe(true);
  });

  it('never replays terminally suppressed preview delivery', async () => {
    const { run, push, statements } = database(true, true, true);
    await run();
    expect(push.sent).toHaveLength(0);
    expect(statements.some((q) => q.sql.includes('where u.id ='))).toBe(false);
  });
});

describe('account campaign quiet hours', () => {
  it('keeps the inbox immediate and waits in sending without claiming provider acceptance', async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const execute = vi.fn(async (query: SQL) => {
      const statement = new PgDialect().sqlToQuery(query);
      statements.push(statement);
      if (statement.sql.includes('select id from users')) return { rows: [{ id: userId }] };
      if (statement.sql.includes('returning id, title, body')) return { rows: [campaign] };
      if (statement.sql.includes('select n.id, n.push_sent_at'))
        return { rows: [{ id: userId, push_sent_at: null, push_suppressed_at: null }] };
      if (statement.sql.includes('select u.id from users u')) return { rows: [{ id: userId }] };
      if (statement.sql.includes('select quiet_hours_enabled'))
        return {
          rows: [
            {
              quiet_hours_enabled: true,
              timezone: 'Asia/Ho_Chi_Minh',
              now: '2026-11-09T16:00:00Z',
            },
          ],
        };
      return { rows: [] };
    });
    const push = new FakePush();
    await new CampaignDispatcher(
      {
        execute,
        transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
          fn({ execute }),
      } as unknown as Db,
      push,
    ).dispatchDue();
    expect(push.sent).toHaveLength(0);
    expect(statements.some((q) => q.sql.includes('insert into notifications'))).toBe(true);
    expect(statements.find((q) => q.sql.includes('set push_deferred_until'))?.params).toContain(
      '2026-11-10T00:00:00.000Z',
    );
    const completion = statements.find((q) => q.sql.includes('quiet_pending ='))!;
    expect(completion.params).toContain('sending');
    expect(completion.params).not.toContain('sent');
  });

  it.each(['due', 'quiet', 'cancelled', 'opt_out', 'failed', 'scheduled', 'replaced'])(
    'rechecks a deferred campaign at wake: %s',
    async (state) => {
      const statements: { sql: string; params: unknown[] }[] = [];
      const dedupeKey = `campaign:dispatch:${userId}`;
      let status = ['failed', 'scheduled', 'cancelled'].includes(state) ? state : 'sending';
      const execute = vi.fn(async (query: SQL) => {
        const statement = new PgDialect().sqlToQuery(query);
        statements.push(statement);
        if (statement.sql.includes('select id from users')) return { rows: [{ id: userId }] };
        if (statement.sql.includes('returning id, user_id, dedupe_key, payload'))
          return {
            rows: [
              {
                id: userId,
                user_id: userId,
                dedupe_key: dedupeKey,
                payload: { campaignId: campaign.id },
              },
            ],
          };
        if (statement.sql.includes('destination_value, dispatch_key, status'))
          return {
            rows: [
              {
                ...campaign,
                status,
                dispatch_key: state === 'replaced' ? 'replacement' : campaign.dispatch_key,
              },
            ],
          };
        if (statement.sql.includes('select n.id, n.push_sent_at'))
          return { rows: [{ id: userId, push_sent_at: null, push_suppressed_at: null }] };
        if (statement.sql.includes('select u.id from users u'))
          return { rows: state === 'opt_out' ? [] : [{ id: userId }] };
        if (statement.sql.includes('select quiet_hours_enabled'))
          return {
            rows: [
              {
                quiet_hours_enabled: state === 'quiet',
                timezone: 'Asia/Ho_Chi_Minh',
                now: '2026-11-09T16:00:00Z',
              },
            ],
          };
        return { rows: [] };
      });
      const push = new FakePush();
      const worker = new CampaignDispatcher(
        {
          execute,
          transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
            fn({ execute }),
        } as unknown as Db,
        push,
      );
      await worker.dispatchDeferred();
      expect(push.sent).toHaveLength(state === 'due' ? 1 : 0);
      if (state === 'due') {
        expect(push.sent[0]?.idempotencyKey).toBeTruthy();
        const eligible = statements.find((q) => q.sql.includes('select u.id from users u'))!;
        expect(eligible.sql).toContain('ns.push_enabled');
        expect(eligible.sql).toContain('ps.platform');
      }
      if (state === 'failed' || state === 'scheduled') {
        expect(statements.some((q) => q.sql.includes('set push_suppressed_at = now()'))).toBe(
          false,
        );
        expect(
          statements.some((q) =>
            q.sql.includes('push_deferred_attempts = push_deferred_attempts + 1'),
          ),
        ).toBe(false);
        status = 'sending';
        await worker.dispatchDeferred();
        expect(push.sent).toHaveLength(1);
      }
      if (state === 'cancelled' || state === 'opt_out' || state === 'replaced')
        expect(statements.some((q) => q.sql.includes('push_suppressed_at = now()'))).toBe(true);
    },
  );
});
