import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantTurnRunner } from '../../../libs/modules/assistant/application/assistant-turn-runner.service';
import { AssistantAvailabilityService } from '../../../libs/modules/assistant/application/assistant-availability.service';
import { AssistantRepository } from '../../../libs/modules/assistant/infrastructure/assistant.repository';
import { AssistantCreditSpendRepository } from '../../../libs/modules/assistant/infrastructure/assistant-credit-spend.repository';
import { startAssistantFixture, type AssistantFixture } from './support/assistant-fixture';
import { vnDayStart } from '../../../libs/modules/assistant/domain/limits';
let f: AssistantFixture;
let start: ReturnType<typeof vi.spyOn>;
const artifact = 'test-only-verified-bound';
beforeAll(async () => {
  f = await startAssistantFixture({
    OPENROUTER_ASSISTANT_API_KEY: 'unused-admission-test',
    OPENROUTER_API_KEY: 'unused-admission-test',
    ASSISTANT_USER_DAILY_MAX_MESSAGES: '5',
    ASSISTANT_USER_PER_MINUTE_MAX_MESSAGES: '600',
    ASSISTANT_MONTHLY_MAX_USD: '100',
    ASSISTANT_CREDIT_BOUND_USD: '0.00012',
    ASSISTANT_CREDIT_BOUND_VERSION: artifact,
  });
  // Policy/transaction tests deliberately stop before inference. No provider acceptance claim.
  start = vi.spyOn(f.app.get(AssistantTurnRunner), 'start').mockImplementation(() => undefined);
}, 240000);
beforeEach(async () => {
  start.mockClear();
  await f.db.execute(
    sql`insert into feature_flags(key,environment,platform,enabled) values('assistant_credits.display_enabled','all','all',true) on conflict(key,environment,platform) do update set enabled=true`,
  );
  await f.db.execute(
    sql`update assistant_credit_spend_control set policy_key='free_then_actual_cost_v1',epoch=1,activated_at=now(),bound_version=${artifact}`,
  );
  for (const key of [
    'assistant_credits.spend_enabled',
    'assistant_credits.settlement_enabled',
    'assistant_credits.display_enabled',
  ])
    await f.db.execute(
      sql`insert into feature_flags(key,environment,platform,enabled) values(${key},'all','all',true) on conflict(key,environment,platform) do update set enabled=true`,
    );
});
afterAll(async () => {
  start?.mockRestore();
  await f?.close();
});
async function subject(balance = 0) {
  const email = randomUUID() + '@d1.test',
    token = await f.register(email);
  const user = (await f.db.execute(sql`select id from users where email=${email}`)).rows[0] as {
    id: string;
  };
  // A realistic test wallet: historical grant minus historical usage, never a production top-up.
  if (balance > 0) {
    await f.db.execute(
      sql`insert into assistant_credit_ledger(user_id,delta,reason,submission_id,venue_identity) values(${user.id},50,'submission_approved',${randomUUID()},${randomUUID()})`,
    );
    if (balance < 50)
      await f.db.execute(
        sql`insert into assistant_credit_ledger(user_id,delta,reason,usage_ledger_id) values(${user.id},${balance - 50},'message_spent',${randomUUID()})`,
      );
    await f.db.execute(
      sql`insert into assistant_credit_accounts(user_id,balance) values(${user.id},${balance})`,
    );
  }
  return { id: user.id, token };
}
async function conversation(token: string) {
  const r = await f.inject({
    method: 'POST',
    url: '/v1/assistant/conversations',
    token,
    payload: {},
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().credits).toMatchObject({
    creditsUsed: 0,
    creditsReserved: 0,
    pendingTurns: 0,
    state: 'settled',
  });
  return r.json().id as string;
}
const send = (token: string, id: string, key = randomUUID()) =>
  f.inject({
    method: 'POST',
    url: `/v1/assistant/conversations/${id}/messages`,
    token,
    headers: { 'idempotency-key': key },
    payload: { text: 'Admission funding test' },
  });
async function exhaust(userId: string, count = 5, now = new Date()) {
  await f.db.execute(sql`insert into assistant_usage_ledger(user_id,allowance_source,accepted_at)
  select ${userId},'daily',${new Date(vnDayStart(now).getTime() + 1000).toISOString()}::timestamptz from generate_series(1,${count})`);
}
async function counts(userId: string) {
  return (
    await f.db.execute(sql`select
 (select count(*)::int from assistant_usage_ledger where user_id=${userId}) as usage,
 (select count(*)::int from assistant_messages where user_id=${userId}) as messages,
 (select count(*)::int from assistant_credit_ledger where user_id=${userId}) as ledger,
 (select count(*)::int from assistant_credit_turns where user_id=${userId}) as turns`)
  ).rows[0];
}
describe('#851 D01/D03/D04 HTTP free-first admission and reservations', () => {
  it.each([0, 50])(
    'D01 all five configured free sends work at balance %i without debit/hold',
    async (balance) => {
      const u = await subject(balance),
        before = await counts(u.id);
      for (let i = 0; i < 5; i++) {
        const c = await conversation(u.token),
          r = await send(u.token, c);
        expect(r.statusCode).toBe(202);
        expect(r.json().assistantMessage.credits).toMatchObject({
          policyKey: 'free_then_actual_cost_v1',
          fundingSource: 'free',
          state: 'settled',
          creditsCharged: 0,
          creditsReserved: 0,
        });
        expect(r.json().userMessage).not.toHaveProperty('credits');
      }
      const after = (await counts(u.id)) as Record<string, number>;
      expect(after.ledger).toBe((before as Record<string, number>).ledger);
      expect(after.turns).toBe(5);
      expect(
        (
          await f.db.execute(
            sql`select coalesce(sum(held_credits),0)::int held from assistant_credit_turns where user_id=${u.id}`,
          )
        ).rows[0],
      ).toEqual({ held: 0 });
      if (balance === 0)
        expect(
          (await f.db.execute(sql`select * from assistant_credit_accounts where user_id=${u.id}`))
            .rows,
        ).toHaveLength(0);
    },
  );
  it('D01 legacy daily then exactly -1 is unchanged regardless of new paid flags/bound', async () => {
    await f.db.execute(
      sql`update assistant_credit_spend_control set policy_key='legacy_allowance_v1',epoch=0,activated_at=null,bound_version=null`,
    );
    await f.db.execute(
      sql`update feature_flags set enabled=false where key='assistant_credits.spend_enabled'`,
    );
    const u = await subject(50);
    await exhaust(u.id);
    const r = await send(u.token, await conversation(u.token));
    expect(r.statusCode).toBe(202);
    expect(r.json().assistantMessage.credits).toMatchObject({
      policyKey: 'legacy_allowance_v1',
      fundingSource: 'credit',
      state: 'settled',
      creditsCharged: 1,
      creditsReserved: 0,
    });
    expect(
      (await f.db.execute(sql`select balance from assistant_credit_accounts where user_id=${u.id}`))
        .rows[0],
    ).toEqual({ balance: 49 });
    expect(
      (await f.db.execute(sql`select * from assistant_credit_turns where user_id=${u.id}`)).rows,
    ).toHaveLength(0);
  });
  it('D03 two conversations race for the last free slot: one free, one held', async () => {
    const u = await subject(12);
    await exhaust(u.id, 4);
    const a = await conversation(u.token),
      b = await conversation(u.token);
    const r = await Promise.all([send(u.token, a), send(u.token, b)]);
    expect(r.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(r.map((r) => r.json().assistantMessage.credits.fundingSource).sort()).toEqual([
      'credit',
      'free',
    ]);
    expect(
      (
        await f.db.execute(
          sql`select sum(held_credits)::int held from assistant_credit_turns where user_id=${u.id}`,
        )
      ).rows[0],
    ).toEqual({ held: 12 });
  });
  it('D03 two paid sends with funds for one cannot overspend', async () => {
    const u = await subject(12);
    await exhaust(u.id);
    const a = await conversation(u.token),
      b = await conversation(u.token);
    const r = await Promise.all([send(u.token, a), send(u.token, b)]);
    expect(r.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(r.find((r) => r.statusCode === 409)!.json().details).toMatchObject({
      creditBalance: 12,
      creditReserved: 12,
      creditAvailable: 0,
      requiredCredits: 12,
    });
    expect(start).toHaveBeenCalledTimes(1);
    const status = await f.inject({ method: 'GET', url: '/v1/assistant/status', token: u.token });
    expect(status.json()).toMatchObject({
      state: 'insufficient_credit',
      creditBalance: 12,
      creditReserved: 12,
      creditAvailable: 0,
      creditPolicy: 'free_then_actual_cost_v1',
      paidCreditsRequired: 12,
      paidSendEnabled: true,
    });
    const credits = await f.inject({ method: 'GET', url: '/v1/me/credits', token: u.token });
    expect(credits.json()).toMatchObject({
      balance: 12,
      reserved: 12,
      availableBalance: 0,
      policyKey: 'free_then_actual_cost_v1',
    });
  });
  it('D04 R-1 refuses with exact typed details and no acceptance/provider changes; R succeeds', async () => {
    const u = await subject(11);
    await exhaust(u.id);
    const c = await conversation(u.token),
      before = await counts(u.id);
    const r = await send(u.token, c);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      code: 'ASSISTANT_INSUFFICIENT_CREDIT',
      retryable: false,
      details: {
        creditBalance: 11,
        creditReserved: 0,
        creditAvailable: 11,
        requiredCredits: 12,
        remainingToday: 0,
      },
    });
    expect(Object.keys(r.json().details).sort()).toEqual(
      [
        'creditBalance',
        'creditReserved',
        'creditAvailable',
        'remainingToday',
        'requiredCredits',
        'resetsAt',
      ].sort(),
    );
    expect(await counts(u.id)).toEqual(before);
    expect(start).not.toHaveBeenCalled();
    const ready = await subject(12);
    await exhaust(ready.id);
    const accepted = await send(ready.token, await conversation(ready.token));
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().assistantMessage.credits).toMatchObject({
      state: 'pending',
      creditsCharged: 0,
      creditsReserved: 12,
    });
  });
  it('missing audited binding preserves genuine free sends and fails exhausted sends with 503', async () => {
    await f.db.execute(sql`update assistant_credit_spend_control set bound_version=null`);
    const u = await subject(50);
    expect((await send(u.token, await conversation(u.token))).statusCode).toBe(202);
    await exhaust(u.id, 4);
    const r = await send(u.token, await conversation(u.token));
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('ASSISTANT_DISABLED');
  });
  it('replay bypasses changed readiness/allowance and refreshes full conversation facts', async () => {
    const u = await subject(12);
    await exhaust(u.id);
    const c = await conversation(u.token),
      key = randomUUID();
    const first = await send(u.token, c, key);
    expect(first.statusCode).toBe(202);
    await f.db.execute(sql`update assistant_credit_spend_control set bound_version=null`);
    const replay = await send(u.token, c, key);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().assistantMessage.id).toBe(first.json().assistantMessage.id);
    expect(replay.json().conversationCredits).toMatchObject({
      creditsUsed: 0,
      creditsReserved: 12,
      pendingTurns: 1,
      state: 'pending',
    });
    expect(start).toHaveBeenCalledTimes(1);
    const page = await f.inject({
      method: 'GET',
      url: `/v1/assistant/conversations/${c}/messages?limit=1`,
      token: u.token,
    });
    expect(page.json().conversationCredits).toMatchObject({ creditsReserved: 12, pendingTurns: 1 });
  });
});
describe('#851 D05 VN day boundary and same-day cutover', () => {
  it('replay after VN reset consumes nothing; concurrent admissions straddling midnight get independent free days', async () => {
    const u = await subject(),
      repo = f.app.get(AssistantRepository);
    const before = new Date('2026-11-11T16:59:59Z'),
      after = new Date('2026-11-11T17:00:00Z');
    await exhaust(u.id, 4, before);
    const c = await conversation(u.token),
      key = randomUUID();
    const clock = vi.spyOn(repo, 'acceptanceTime').mockResolvedValue(before);
    try {
      const first = await send(u.token, c, key);
      expect(first.statusCode).toBe(202);
      clock.mockResolvedValue(after);
      const replay = await send(u.token, c, key);
      expect(replay.statusCode).toBe(202);
      expect(replay.json().assistantMessage.id).toBe(first.json().assistantMessage.id);
      expect(
        await f.app.get(AssistantCreditSpendRepository).snapshot(f.db, u.id, vnDayStart(after)),
      ).toMatchObject({ accepted_today: 0 });
      const other = await subject(),
        a = await conversation(other.token),
        b = await conversation(other.token);
      clock.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      const results = await Promise.all([send(other.token, a), send(other.token, b)]);
      expect(results.map((r) => r.statusCode)).toEqual([202, 202]);
      const days = await f.db.execute(
        sql`select free_day::text from assistant_credit_turns where user_id=${other.id} order by free_day`,
      );
      expect(days.rows).toEqual([{ free_day: '2026-11-11' }, { free_day: '2026-11-12' }]);
    } finally {
      clock.mockRestore();
    }
  });

  it('committed daily funding crosses midnight once; yesterday paid funding remains paid', async () => {
    const u = await subject(12);
    const before = new Date('2026-11-11T16:59:59Z'),
      after = new Date('2026-11-11T17:00:00Z');
    await exhaust(u.id, 4, before);
    const repo = f.app.get(AssistantRepository),
      spend = f.app.get(AssistantCreditSpendRepository),
      availability = f.app.get(AssistantAvailabilityService);
    const accept = async (at: Date) => {
      const c = await conversation(u.token);
      return f.db.transaction(async (tx) => {
        const control = await spend.lockControl(tx);
        await repo.lockAccount(tx, u.id);
        await repo.lockBudget(tx);
        await repo.lockAdmissionSubject(tx, u.id, c);
        const funding = await availability.funding(
          tx,
          u.id,
          { dailyMessageLimit: 5, messagesPerMinuteLimit: 600 },
          at,
          control,
        );
        const turn = await repo.insertTurn(tx, {
          userId: u.id,
          conversationId: c,
          text: 'boundary',
          locale: 'vi',
          context: null,
          leaseOwner: 'test',
          leaseMs: 90000,
          acceptedAt: at,
          allowanceSource: funding.allowanceSource,
          billingPolicy: control.policy_key,
          billingEpoch: control.epoch,
        });
        await spend.reserveWithin(tx, {
          usageId: turn.ledgerId,
          userId: u.id,
          messageId: turn.assistant.id,
          conversationId: c,
          acceptedAt: at,
          control,
          required: funding.required,
          boundVersion: funding.boundVersion,
        });
        return { turn, funding };
      });
    };
    const free = await accept(before),
      paid = await accept(before),
      tomorrow = await accept(after);
    expect([
      free.funding.allowanceSource,
      paid.funding.allowanceSource,
      tomorrow.funding.allowanceSource,
    ]).toEqual(['daily', 'credit', 'daily']);
    expect((await spend.snapshot(f.db, u.id, vnDayStart(after))).accepted_today).toBe(1);
    const rows = (
      await f.db.execute(
        sql`select funding_source,held_credits,applied_credits,state from assistant_credit_turns where user_id=${u.id} order by accepted_at, funding_source`,
      )
    ).rows;
    expect(rows.filter((r) => r.funding_source === 'free')).toEqual([
      { funding_source: 'free', held_credits: 0, applied_credits: 0, state: 'settled' },
      { funding_source: 'free', held_credits: 0, applied_credits: 0, state: 'settled' },
    ]);
    // More legacy daily accepts than the current configured limit do not grant extra free turns.
    await exhaust(u.id, 6, after);
    expect((await spend.snapshot(f.db, u.id, vnDayStart(after))).accepted_today).toBe(7);
  });
});
