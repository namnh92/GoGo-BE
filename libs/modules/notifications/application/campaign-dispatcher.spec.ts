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
  const dispatcher = new CampaignDispatcher({ execute } as unknown as Db, push);
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
