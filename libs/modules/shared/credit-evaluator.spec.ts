import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { CreditEvaluator } from './credit-evaluator';
import { CREDIT_SEEDS, type CreditRule } from './credit-catalogue';
import type * as CreditCatalogue from './credit-catalogue';
import { CREDIT_TRIGGERS } from './credit-triggers';
import { resolveBooleanFlag } from './feature-flags';
vi.mock('./feature-flags', () => ({
  flagEnvironmentOf: () => 'dev',
  resolveBooleanFlag: vi.fn(async () => false),
}));
vi.mock('./credit-catalogue', async (original) => ({
  ...(await original<typeof CreditCatalogue>()),
  assertCreditWriterReady: vi.fn(async () => {}),
}));
const dialect = new PgDialect();
const subject = randomUUID();
function rule(overrides: Partial<CreditRule> = {}): CreditRule {
  return {
    id: CREDIT_SEEDS[2].id,
    key: 'review_published',
    trigger_event_type: 'review.published',
    trigger_schema_version: 2,
    condition: {
      all: [
        { fact: 'target', op: 'eq', value: 'place' },
        { fact: 'firstPublication', op: 'eq', value: true },
      ],
    },
    condition_version: 1,
    audience: 'individual',
    dedup_scope: 'per_place_subject',
    amount: 5,
    status: 'active',
    starts_at: '-infinity',
    ends_at: null,
    max_per_user: null,
    max_per_group: null,
    budget_total: null,
    budget_used: 0,
    ...overrides,
  };
}
function fixture(
  options: {
    rules?: CreditRule[];
    eventType?: string;
    payload?: Record<string, unknown>;
    version?: number;
    inactive?: string[];
    fail?: string;
  } = {},
) {
  const eventId = randomUUID();
  const trace: { sql: string; params: unknown[] }[] = [];
  let state = {
    rules: options.rules ?? [rule()],
    entitlements: [] as { eventId: string; key: string }[],
    ledger: [] as { userId: string; ruleId: string; delta: number; group: string | null }[],
    balance: 0,
    ack: null as { status: string; grants: number } | null,
  };
  const event = {
    id: eventId,
    event_type: options.eventType ?? 'review.published',
    payload_schema_version: options.version ?? 2,
    occurred_at: new Date(),
    payload: options.payload ?? {
      reviewId: randomUUID(),
      userId: subject,
      target: 'place',
      placeId: randomUUID(),
      firstPublication: true,
      grantOwner: 'evaluator',
    },
  };
  const execute = vi.fn(async (query) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    trace.push({ sql: text, params });
    if (options.fail && text.includes(options.fail)) throw new Error('injected write failure');
    if (text.includes('from outbox_events where id=')) return { rows: [event] };
    if (text.includes('select * from credit_events')) return { rows: state.rules };
    if (text.includes('select id from users'))
      return { rows: options.inactive?.includes(String(params[0])) ? [] : [{ id: params[0] }] };
    if (text.includes('select status from credit_evaluations'))
      return { rows: state.ack ? [state.ack] : [] };
    if (text.includes('select ledger_id from credit_entitlements'))
      return {
        rows: state.entitlements.filter((e) => e.eventId === params[0] && e.key === params[1]),
      };
    if (text.includes('count(distinct group_grant_id)'))
      return { rows: [{ n: new Set(state.ledger.map((l) => l.group).filter(Boolean)).size }] };
    if (text.includes('select count(distinct e.ledger_id)::int as n'))
      return {
        rows: [
          {
            n: state.ledger.filter((l) => l.ruleId === params[0] && l.userId === params[1]).length,
          },
        ],
      };
    if (text.startsWith('update credit_events')) {
      const r = state.rules.find((r) => params.includes(r.id))!;
      const n = Number(params[0]);
      if (r.status !== 'active' || (r.budget_total !== null && r.budget_used + n > r.budget_total))
        return { rows: [] };
      r.budget_used += n;
      if (r.budget_used === r.budget_total) r.status = 'closed';
      return { rows: [{ id: r.id }] };
    }
    if (text.startsWith('insert into assistant_credit_ledger'))
      state.ledger.push({
        userId: String(params[1]),
        delta: Number(params[2]),
        ruleId: String(params[4]),
        group: params[6] as string | null,
      });
    if (text.startsWith('insert into credit_entitlements'))
      state.entitlements.push({ eventId: String(params[0]), key: String(params[1]) });
    if (text.startsWith('insert into assistant_credit_accounts'))
      state.balance += Number(params[1]);
    if (text.startsWith('insert into credit_evaluations'))
      state.ack = text.includes("'quarantined'")
        ? { status: 'quarantined', grants: 0 }
        : { status: 'evaluated', grants: Number(params[2]) };
    return { rows: [] };
  });
  const db = {
    execute,
    transaction: async (work: (tx: { execute: typeof execute }) => Promise<unknown>) => {
      const before = structuredClone(state);
      try {
        return await work({ execute });
      } catch (e) {
        state = before;
        throw e;
      }
    },
  };
  const quarantine = vi.fn();
  return {
    eventId,
    event,
    trace,
    execute,
    state: () => state,
    quarantine,
    evaluator: new CreditEvaluator(db as never, {
      environment: 'dev',
      subjectKeySecret: 's'.repeat(32),
      quarantine,
    }),
  };
}
/** Selection double; real grant transactions still run through each fixture. SQL is
 * exercised against PostgreSQL by credit-events-evaluator.int.spec.ts. */
function scheduler(events: ReturnType<typeof fixture>[]) {
  let clock = 0;
  const attempted = new Map<string, number>();
  const execute = vi.fn(async (query) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    const candidates = events.filter((f) => {
      if (text.includes("or c.status='quarantined'")) return f.state().ack?.status !== 'evaluated';
      if (text.includes('c.event_id is null')) return !f.state().ack;
      if (text.includes("c.status='quarantined'")) return f.state().ack?.status === 'quarantined';
      throw new Error(`Unexpected selection: ${text}`);
    });
    if (text.includes('order by c.evaluated_at'))
      candidates.sort((a, b) => (attempted.get(a.eventId) ?? 0) - (attempted.get(b.eventId) ?? 0));
    return { rows: candidates.slice(0, Number(params.at(-1))).map((f) => ({ id: f.eventId })) };
  });
  const evaluator = new CreditEvaluator({ execute } as never, {
    environment: 'dev',
    subjectKeySecret: 's'.repeat(32),
  });
  const evaluate = vi.spyOn(evaluator, 'evaluate').mockImplementation(async (id) => {
    attempted.set(id, ++clock);
    await events.find((f) => f.eventId === id)!.evaluator.evaluate(id);
  });
  const tick = (limit?: number) => {
    vi.mocked(resolveBooleanFlag).mockResolvedValueOnce(true);
    return evaluator.tick(limit);
  };
  return { tick, evaluate };
}
describe('#829 atomic credit evaluation', () => {
  it('grants pending work behind 200 quarantined events and rotates bounded retries fairly', async () => {
    const quarantined = Array.from({ length: 200 }, () => fixture({ version: 3 }));
    for (const f of quarantined) await f.evaluator.evaluate(f.eventId);
    const valid = fixture();
    const events = [...quarantined, valid];
    const s = scheduler(events);
    expect(await s.tick()).toBe(21);
    expect(valid.state().balance).toBe(5);
    expect(valid.state().ack).toEqual({ status: 'evaluated', grants: 1 });
    for (let i = 1; i < 10; i++) {
      const pending = fixture();
      events.push(pending);
      expect(await s.tick()).toBe(21);
      expect(pending.state().balance).toBe(5);
    }
    const ids = new Set<string>(quarantined.map((f) => f.eventId));
    const retries = s.evaluate.mock.calls.map(([id]) => id).filter((id) => ids.has(id));
    expect(retries).toHaveLength(200);
    expect(new Set(retries).size).toBe(200);
    expect(quarantined.every((f) => f.state().ack?.status === 'quarantined')).toBe(true);
  });
  it('reserves pending and retry capacity even at limit 1', async () => {
    const q = fixture({ version: 3 });
    await q.evaluator.evaluate(q.eventId);
    const valid = fixture();
    const s = scheduler([q, valid]);
    expect(await s.tick(1)).toBe(2);
    expect(valid.state().balance).toBe(5);
    expect(q.state().ack?.status).toBe('quarantined');
  });
  it('waits until the next tick before retrying newly quarantined pending work', async () => {
    const q = fixture({ version: 3 });
    const s = scheduler([q]);
    expect(await s.tick()).toBe(1);
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(await s.tick()).toBe(1);
    expect(s.evaluate).toHaveBeenCalledTimes(2);
  });
  it('records plan reviews without place identity as ineligible and grants later valid work', async () => {
    const plan = fixture({ rules: [rule({ condition: { all: [] } })] });
    plan.event.payload.target = 'plan';
    delete plan.event.payload.placeId;
    const valid = fixture();
    await scheduler([plan, valid]).tick();
    expect(plan.state()).toMatchObject({
      balance: 0,
      ledger: [],
      entitlements: [],
      ack: { status: 'evaluated', grants: 0 },
    });
    expect(plan.trace.some((t) => t.sql.startsWith('update credit_events'))).toBe(false);
    expect(plan.trace.at(-1)?.params).toContain('ineligible');
    expect(valid.state().balance).toBe(5);
  });
  it('skips only rules missing scope identity, preserving other eligible plan-review rules', async () => {
    const f = fixture({
      rules: [
        rule({ condition: { all: [] } }),
        rule({
          id: randomUUID(),
          key: 'plan_review',
          dedup_scope: 'per_source',
          condition: { all: [] },
        }),
      ],
    });
    f.event.payload.target = 'plan';
    delete f.event.payload.placeId;
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(5);
    expect(f.state().ack).toEqual({ status: 'evaluated', grants: 1 });
    expect(f.state().rules[0]!.budget_used).toBe(0);
    expect(f.state().ledger[0]!.ruleId).toBe(f.state().rules[1]!.id);
  });
  it('continues after a transaction failure, then reports it without acknowledging failed work', async () => {
    const failed = fixture({ fail: 'insert into credit_evaluations' });
    const valid = fixture();
    await expect(scheduler([failed, valid]).tick()).rejects.toThrow('injected write failure');
    expect(failed.state()).toMatchObject({ balance: 0, ledger: [], entitlements: [], ack: null });
    expect(valid.state().balance).toBe(5);
  });
  it('keeps all pending/quarantined rows untouched while paused', async () => {
    const f = fixture();
    expect(await f.evaluator.tick()).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('grants and acknowledges once; locks rules then accounts then outbox', async () => {
    const f = fixture();
    await f.evaluator.evaluate(f.eventId);
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(5);
    expect(f.state().ledger).toHaveLength(1);
    expect(f.state().ack).toEqual({ status: 'evaluated', grants: 1 });
    const texts = f.trace.map((t) => t.sql);
    const rule = texts.findIndex(
      (t) => t.includes('from credit_events') && t.includes('for update'),
    );
    const account = texts.findIndex((t) => t.includes('pg_advisory_xact_lock'));
    const outbox = texts.findIndex(
      (t) => t.includes('from outbox_events') && t.includes('for update'),
    );
    expect(rule).toBeLessThan(account);
    expect(account).toBeLessThan(outbox);
  });
  it('deduplicates different deliveries by the business entitlement', async () => {
    const f = fixture();
    await f.evaluator.evaluate(f.eventId);
    f.state().ack = null;
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(5);
    expect(f.state().ack?.grants).toBe(0);
  });
  it.each(['insert into credit_entitlements', 'insert into credit_evaluations'])(
    'rolls the reservation, ledger and balance back on %s failure',
    async (fail) => {
      const f = fixture({ fail });
      await expect(f.evaluator.evaluate(f.eventId)).rejects.toThrow('injected');
      expect(f.state()).toMatchObject({ balance: 0, ledger: [], entitlements: [], ack: null });
      expect(f.state().rules[0]!.budget_used).toBe(0);
    },
  );
  it('quarantines malformed top-level JSON rather than dropping it', async () => {
    const f = fixture();
    f.event.payload = null as never;
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().ack?.status).toBe('quarantined');
    expect(f.state().balance).toBe(0);
  });
  it('keeps older supported backlog eligible when a newer rule requires a higher minimum version', async () => {
    const f = fixture({
      rules: [rule(), rule({ id: randomUUID(), key: 'future_review', trigger_schema_version: 3 })],
    });
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(5);
    expect(f.quarantine).not.toHaveBeenCalled();
  });
  it('quarantines an unknown version and retries after a decoder ships', async () => {
    const f = fixture({ version: 3 });
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().ack?.status).toBe('quarantined');
    expect(f.state().balance).toBe(0);
    expect(f.quarantine).toHaveBeenCalledOnce();
    const decoders = CREDIT_TRIGGERS['review.published']!.decoders;
    decoders[3] = decoders[2]!;
    try {
      await f.evaluator.evaluate(f.eventId);
      expect(f.state().balance).toBe(5);
      expect(f.state().ack?.status).toBe('evaluated');
    } finally {
      delete decoders[3];
    }
  });
  it.each(['sync', 'none', undefined])(
    'terminally acknowledges owner %s without using event time',
    async (grantOwner) => {
      const f = fixture();
      f.event.payload.grantOwner = grantOwner;
      await f.evaluator.evaluate(f.eventId);
      expect(f.state().balance).toBe(0);
      expect(f.state().ack?.status).toBe('evaluated');
    },
  );
  it.each([null, undefined])('accepts erased subject %s without quarantining', async (userId) => {
    const f = fixture();
    f.event.payload.userId = userId;
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().ack).toEqual({ status: 'evaluated', grants: 0 });
    expect(f.quarantine).not.toHaveBeenCalled();
  });
  it('checks active accounts and firstPublication under locks', async () => {
    const f = fixture({ inactive: [subject] });
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(0);
    const g = fixture();
    g.event.payload.firstPublication = false;
    await g.evaluator.evaluate(g.eventId);
    expect(g.state().balance).toBe(0);
  });
  it('reads user caps under the rule/account locks', async () => {
    const f = fixture({ rules: [rule({ max_per_user: 1 })] });
    f.state().ledger.push({ userId: subject, ruleId: CREDIT_SEEDS[2].id, delta: 5, group: null });
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(0);
  });
  it.each([20, 30])('group 3×10 reserves all-or-none with budget %i', async (budget) => {
    const users = Array.from({ length: 3 }, () => randomUUID());
    const f = fixture({
      rules: [
        rule({
          id: randomUUID(),
          key: 'group_completion',
          trigger_event_type: 'room.completed',
          audience: 'group',
          amount: 10,
          dedup_scope: 'per_source',
          condition: { all: [] },
          budget_total: budget,
        }),
      ],
      eventType: 'room.completed',
      payload: {
        roomId: randomUUID(),
        triggeredAt: new Date().toISOString(),
        room: { type: 'group', participantCount: 4 },
        plan: { stopsCompleted: 2 },
        subjects: users.map((userId) => ({ userId, memberId: randomUUID(), role: 'member' })),
        grantOwner: 'evaluator',
      },
    });
    await f.evaluator.evaluate(f.eventId);
    expect(f.state().balance).toBe(budget === 30 ? 30 : 0);
    expect(f.state().ledger).toHaveLength(budget === 30 ? 3 : 0);
    expect(f.state().rules[0]!.budget_used).toBe(budget === 30 ? 30 : 0);
    expect(f.state().rules[0]!.status).toBe(budget === 30 ? 'closed' : 'active');
    if (budget === 30) expect(new Set(f.state().ledger.map((l) => l.group)).size).toBe(1);
    const acquired = f.trace
      .filter((t) => t.sql.includes('pg_advisory'))
      .map((t) => String(t.params[0]).replace('assistant:', ''));
    expect(acquired).toEqual([...users].sort());
  });
});
