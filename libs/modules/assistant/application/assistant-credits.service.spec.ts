import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@gogo/database';
import { NoopMetrics } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AssistantCreditsService } from './assistant-credits.service';
import type {
  AssistantCreditRepository,
  CreditHistoryRow,
} from '../infrastructure/assistant-credit.repository';
import { decodeCreditCursor } from '../domain/credit-visibility';

const actor: Actor = { type: 'user', id: randomUUID(), sessionId: randomUUID() };
function setup(enabled = true) {
  const summary = vi.fn().mockResolvedValue({
    balance: 139,
    reserved: '0',
    policy_key: 'legacy_allowance_v1',
    earned: '140',
    spent: '1',
    as_of: '2026-11-10T00:00:00.123456Z',
  });
  const history = vi.fn().mockResolvedValue([{ id: null }]);
  const repo = { summary, history } as unknown as AssistantCreditRepository;
  const execute = vi.fn().mockResolvedValue({
    rows: enabled ? [{ environment: 'all', platform: 'all', enabled: true, payload: null }] : [],
  });
  const metrics = new NoopMetrics();
  const increment = vi.spyOn(metrics, 'increment');
  return {
    summary,
    history,
    execute,
    increment,
    service: new AssistantCreditsService(
      repo,
      { execute } as unknown as Db,
      { APP_ENV: 'dev' },
      metrics,
    ),
  };
}

describe('V own credit reads', () => {
  it('preserves legacy balance, lifetime totals and policy, with no holds', async () => {
    const { service, summary } = setup();
    expect(await service.summary(actor)).toEqual({
      balance: 139,
      earned: 140,
      spent: 1,
      reserved: 0,
      availableBalance: 139,
      asOf: '2026-11-10T00:00:00.123456Z',
      policyKey: 'legacy_allowance_v1',
    });
    expect(summary).toHaveBeenCalledWith(actor.id);
  });

  it('refuses guests and admins before consulting flags or the ledger', async () => {
    const { service, summary, execute } = setup();
    for (const type of ['guest', 'admin'] as const) {
      await expect(service.summary({ ...actor, type })).rejects.toMatchObject({
        code: 'USER_ONLY',
        httpStatus: 403,
      });
      await expect(service.history({ ...actor, type }, {})).rejects.toMatchObject({
        code: 'USER_ONLY',
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
  });

  it('defaults display off without changing evaluator or assistant admission', async () => {
    const { service, summary, history } = setup(false);
    await expect(service.summary(actor)).rejects.toMatchObject({
      code: 'CREDITS_DISPLAY_DISABLED',
      httpStatus: 404,
    });
    await expect(service.history(actor, {})).rejects.toMatchObject({
      code: 'CREDITS_DISPLAY_DISABLED',
    });
    expect(summary).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('returns zero/empty for no account, refuses missing/inactive users', async () => {
    const { service, summary, history } = setup();
    summary.mockResolvedValueOnce({
      reserved: '0',
      policy_key: 'legacy_allowance_v1',
      balance: 0,
      earned: '0',
      spent: '0',
      as_of: 'now',
    });
    expect(await service.summary(actor)).toMatchObject({ balance: 0, earned: 0, spent: 0 });
    expect(await service.history(actor, {})).toEqual({ items: [], nextCursor: null });
    summary.mockResolvedValueOnce(undefined);
    history.mockResolvedValueOnce([]);
    await expect(service.summary(actor)).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
    await expect(service.history(actor, {})).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
  });

  it('monitors mismatch without repair or replacing posted balance; refuses unsafe JSON integers', async () => {
    const { service, summary, increment } = setup();
    summary.mockResolvedValueOnce({
      reserved: '0',
      policy_key: 'legacy_allowance_v1',
      balance: 7,
      earned: '140',
      spent: '1',
      as_of: 'now',
    });
    expect(await service.summary(actor)).toMatchObject({ balance: 7, earned: 140, spent: 1 });
    expect(increment).toHaveBeenCalledWith('assistant_credit_account_mismatch_total');
    summary.mockResolvedValueOnce({
      reserved: '0',
      policy_key: 'legacy_allowance_v1',
      balance: 0,
      earned: '9007199254740992',
      spent: '9007199254740992',
      as_of: 'now',
    });
    await expect(service.summary(actor)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it.each([0, 10, 11])(
    'maps %i rows to a fixed page with a subject-bound cursor and public facts only',
    async (count) => {
      const { service, history } = setup();
      const rows: CreditHistoryRow[] = Array.from({ length: count }, () => ({
        id: randomUUID(),
        created_at: '2026-11-10T00:00:00.123456Z',
        delta: 70,
        reason: 'submission_approved',
        event_id: null,
        usage_linked: false,
        conversation: null,
        event_labels: null,
      }));
      history.mockResolvedValueOnce(count ? rows : [{ id: null }]);
      const page = await service.history(actor, {});
      expect(page.items).toHaveLength(Math.min(count, 10));
      if (count > 10)
        expect(decodeCreditCursor(page.nextCursor!, actor.id)).toEqual({
          at: rows[9]!.created_at,
          id: rows[9]!.id,
        });
      else expect(page.nextCursor).toBeNull();
      if (count)
        expect(Object.keys(page.items[0]!).sort()).toEqual([
          'conversation',
          'createdAt',
          'delta',
          'direction',
          'eventKey',
          'eventLabels',
          'id',
          'source',
        ]);
    },
  );

  it('maps legacy spends, D debits/refunds and catalogue labels to public grouping facts', async () => {
    const { service, history } = setup();
    const conversation = { id: randomUUID(), title: 'Dinner plans' };
    const untitled = { id: randomUUID(), title: null };
    const labels = { vi: 'Đánh giá địa điểm', en: 'Place review' };
    const rows = [
      { reason: 'message_spent', delta: -1, conversation, event_labels: null },
      { reason: 'message_spent', delta: -12, conversation: untitled, event_labels: null },
      { reason: 'assistant_usage_adjustment', delta: 3, conversation, event_labels: null },
      { reason: 'review_published', delta: 5, conversation: null, event_labels: labels },
    ].map((row) => ({
      id: randomUUID(),
      created_at: '2026-11-11T00:00:00.123456Z',
      usage_linked: row.delta < 0 || row.reason === 'assistant_usage_adjustment',
      event_id: row.reason === 'review_published' ? randomUUID() : null,
      ...row,
    }));
    history.mockResolvedValueOnce(rows);
    const page = await service.history(actor, {});
    expect(page.items).toEqual(
      rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        delta: row.delta,
        direction:
          row.reason === 'message_spent'
            ? 'spent'
            : row.reason === 'assistant_usage_adjustment'
              ? 'adjustment'
              : 'earned',
        eventKey: row.reason === 'message_spent' ? 'assistant_usage' : row.reason,
        source: { type: row.reason === 'review_published' ? 'review' : 'assistant_usage' },
        ...(row.event_id ? { eventId: row.event_id } : {}),
        conversation: row.conversation,
        eventLabels: row.event_labels,
      })),
    );
    expect(page.nextCursor).toBeNull();
  });

  it('keeps unreadable/unknown conversations and non-event labels explicitly null', async () => {
    const { service, history } = setup();
    history.mockResolvedValueOnce([
      {
        id: randomUUID(),
        created_at: '2026-11-11T00:00:00.123456Z',
        delta: -1,
        reason: 'message_spent',
        usage_linked: true,
        event_id: null,
        conversation: null,
        event_labels: null,
      },
    ]);
    expect((await service.history(actor, {})).items[0]).toMatchObject({
      conversation: null,
      eventLabels: null,
    });
  });
});
