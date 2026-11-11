import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema, type Db } from '@gogo/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenService } from '../../../libs/modules/identity/application/token.service';
import { AssistantCreditRepository } from '../../../libs/modules/assistant/infrastructure/assistant-credit.repository';

// V1–V3: real migrated PostgreSQL + production HTTP guards/hooks. NOT RUN locally.
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let app: NestFastifyApplication;
const api = () => app.getHttpAdapter().getInstance();
let requestNumber = 0;
const ip = () => `10.83.${Math.floor(++requestNumber / 250)}.${(requestNumber % 250) + 1}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function register() {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: {
      email: `${randomUUID()}@credits.test`,
      password: 'Sufficiently-long-pw1!',
      displayName: 'Credit user',
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { accessToken: string; userId: string };
}

function get(token: string | undefined, suffix = '') {
  return api().inject({
    method: 'GET',
    url: `/v1/me/credits${suffix}`,
    remoteAddress: ip(),
    ...(token ? { headers: auth(token) } : {}),
  });
}

async function grant(
  userId: string,
  delta = 50,
  at = '2026-11-10T09:00:00.123456Z',
  id = randomUUID(),
) {
  await pool.query(
    `insert into assistant_credit_ledger(id,user_id,delta,reason,submission_id,venue_identity,created_at)
    values ($1,$2,$3,'submission_approved',$4,$5,$6)`,
    [id, userId, delta, randomUUID(), randomUUID(), at],
  );
  await pool.query(
    `insert into assistant_credit_accounts(user_id,balance) values ($1,$2)
    on conflict(user_id) do update set balance=assistant_credit_accounts.balance+excluded.balance`,
    [userId, delta],
  );
  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_credits_v')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.GOOGLE_PLACES_API_KEY = '';
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('V1 self-only, private, gated reads', () => {
  it('defaults off, advertises capability, enables independently of evaluator; reads create nothing', async () => {
    const user = await register();
    const off = await get(user.accessToken);
    expect(off.statusCode).toBe(404);
    expect(off.json().code).toBe('CREDITS_DISPLAY_DISABLED');
    expect(off.headers['cache-control']).toBe('private, no-store');
    const me = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(user.accessToken),
    });
    expect(me.json().capabilities.assistantCredits).toBe(false);
    await pool.query(
      `insert into feature_flags(key,enabled) values ('assistant_credits.display_enabled',true)`,
    );
    const on = await get(user.accessToken);
    expect(on.statusCode).toBe(200);
    expect(on.headers['cache-control']).toBe('private, no-store');
    expect(on.json()).toMatchObject({
      balance: 0,
      earned: 0,
      spent: 0,
      reserved: 0,
      availableBalance: 0,
      policyKey: 'legacy_allowance_v1',
    });
    expect(on.json().asOf).toMatch(/\.\d{6}Z$/);
    expect((await get(user.accessToken, '/ledger')).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    const meOn = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(user.accessToken),
    });
    expect(meOn.json().capabilities.assistantCredits).toBe(true);
    expect(
      (await pool.query('select * from assistant_credit_accounts where user_id=$1', [user.userId]))
        .rowCount,
    ).toBe(0);
  });

  it('missing/expired login, guest, inactive account and invalid queries remain private', async () => {
    for (const suffix of ['', '/ledger']) {
      const missing = await get(undefined, suffix);
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['cache-control']).toBe('private, no-store');
      const invalid = await get('expired-or-invalid', suffix);
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers['cache-control']).toBe('private, no-store');
    }
    const user = await register();
    const tokens = app.get(TokenService);
    const guestId = randomUUID();
    const guest = tokens.issueAccessToken({
      actorType: 'guest',
      actorId: guestId,
      sessionId: guestId,
      roomId: randomUUID(),
    });
    for (const suffix of ['', '/ledger']) {
      const response = await get(guest, suffix);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('USER_ONLY');
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    for (const suffix of [
      '/ledger?limit=11',
      '/ledger?userId=' + randomUUID(),
      '/ledger?cursor=!',
    ]) {
      const response = await get(user.accessToken, suffix);
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    await pool.query(`update users set status='suspended' where id=$1`, [user.userId]);
    for (const suffix of ['', '/ledger'])
      expect((await get(user.accessToken, suffix)).statusCode).toBe(401);
  });
});

describe('V2 stable ten-row keyset history', () => {
  it.each([0, 10, 11, 21])(
    'paginates %i rows with equal timestamps, UUID ties and distinct microseconds',
    async (count) => {
      const user = await register();
      const expected: { id: string; at: string }[] = [];
      for (let i = 0; i < count; i++) {
        const at = i < 12 ? '2026-11-10T09:00:00.123456Z' : `2026-11-10T09:00:00.${123456 - i}Z`;
        const id = await grant(user.userId, 50, at);
        expected.push({ id, at });
      }
      expected.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await get(
          user.accessToken,
          '/ledger' + (cursor ? '?cursor=' + cursor : ''),
        );
        expect(response.statusCode).toBe(200);
        const page = response.json();
        expect(page.items.length).toBeLessThanOrEqual(10);
        seen.push(...page.items.map((entry: { id: string }) => entry.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(expected.map((entry) => entry.id));
      expect(new Set(seen).size).toBe(count);
    },
  );

  it('rejects another user cursor and malformed cursors; refresh sees new entries without shifting continuation', async () => {
    const user = await register();
    const other = await register();
    for (let i = 0; i < 11; i++) await grant(user.userId);
    const first = (await get(user.accessToken, '/ledger')).json();
    const newest = await grant(user.userId, 70, '2026-11-10T09:00:00.123457Z');
    const second = (await get(user.accessToken, '/ledger?cursor=' + first.nextCursor)).json();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(first.items.some((entry: { id: string }) => entry.id === second.items[0].id)).toBe(
      false,
    );
    expect((await get(user.accessToken, '/ledger')).json().items[0].id).toBe(newest);
    const wrong = await get(other.accessToken, '/ledger?cursor=' + first.nextCursor);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('INVALID_CURSOR');
    expect((await get(user.accessToken, '?userId=' + other.userId)).json().earned).toBe(620);
    for (const cursor of ['!', 'a'.repeat(513), Buffer.from('[]').toString('base64url')]) {
      const bad = await get(user.accessToken, '/ledger?cursor=' + cursor);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('INVALID_CURSOR');
    }
  });
});

describe('V3 lifetime arithmetic and forward-compatible projection', () => {
  it('keeps mixed historical grants and -1 spends after source/usage absence, independent of page size', async () => {
    const user = await register();
    for (const delta of [20, 50, 70]) await grant(user.userId, delta);
    const usage = randomUUID();
    await pool.query(
      `insert into assistant_credit_ledger(user_id,delta,reason,usage_ledger_id) values ($1,-1,'message_spent',$2)`,
      [user.userId, usage],
    );
    await pool.query('update assistant_credit_accounts set balance=balance-1 where user_id=$1', [
      user.userId,
    ]);
    expect((await get(user.accessToken)).json()).toMatchObject({
      balance: 139,
      earned: 140,
      spent: 1,
    });
    const page = (await get(user.accessToken, '/ledger?limit=10')).json();
    expect(page.items).toHaveLength(4);
    expect(page.items.find((entry: { delta: number }) => entry.delta === -1)).toMatchObject({
      eventKey: 'assistant_usage',
      direction: 'spent',
      source: { type: 'assistant_usage' },
    });
    expect(JSON.stringify(page)).not.toContain(usage);
    for (const entry of page.items)
      expect(Object.keys(entry).sort()).toEqual([
        'conversation',
        'createdAt',
        'delta',
        'direction',
        'eventKey',
        'eventLabels',
        'id',
        'source',
      ]);
    // The sources/usage have no live rows: history/arithmetic use ledger only.
    expect(
      (await pool.query('select id from assistant_usage_ledger where id=$1', [usage])).rowCount,
    ).toBe(0);
  });

  it('reads future catalogue grants, component entitlements and refunds in an isolated compatibility fixture (no D writer/migration)', async () => {
    const user = await register();
    const event = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Shadow only for this connection: do not loosen the real migrated schema.
      await client.query('create schema visibility_compat');
      await client.query('set local search_path=visibility_compat,public');
      await client.query('create table visibility_compat.users as select * from public.users');
      await client.query(
        'create table visibility_compat.assistant_credit_accounts as select * from public.assistant_credit_accounts where false',
      );
      await client.query(
        'create table visibility_compat.assistant_credit_ledger as select * from public.assistant_credit_ledger where false',
      );
      await client.query(
        'alter table visibility_compat.assistant_credit_ledger add column if not exists credit_event_id uuid',
      );
      await client.query('create table visibility_compat.credit_entitlements(ledger_id uuid)');
      const historical = randomUUID();
      await client.query(
        `insert into assistant_credit_ledger(id,user_id,delta,reason,created_at,credit_event_id,usage_ledger_id) values
        ($1,$2,70,'submission_approved',now(),null,null),
        ($3,$2,5,'arbitrary_future_key',now(),$4,null),
        ($5,$2,-1,'message_spent',now(),null,$5),
        ($6,$2,1,'assistant_usage_adjustment',now(),null,$5)`,
        [historical, user.userId, randomUUID(), event, randomUUID(), randomUUID()],
      );
      await client.query('insert into credit_entitlements values ($1),($1)', [historical]);
      await client.query('insert into assistant_credit_accounts(user_id,balance) values ($1,75)', [
        user.userId,
      ]);
      const repository = new AssistantCreditRepository(drizzle(client, { schema }));
      expect(await repository.summary(user.userId)).toMatchObject({
        balance: 75,
        earned: '75',
        spent: '0',
      });
      expect(
        (await repository.history(user.userId, null)).find(
          (row) => row.reason === 'arbitrary_future_key',
        )?.event_id,
      ).toBe(event);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('Owner 2026-11-11 credit history grouping facts', () => {
  async function conversation(userId: string, title: string | null) {
    const id = randomUUID();
    await pool.query('insert into assistant_conversations(id,user_id,title) values ($1,$2,$3)', [
      id,
      userId,
      title,
    ]);
    return { id, title };
  }

  async function legacyUsage(
    ledgerUserId: string,
    conversationId: string,
    usageUserId = ledgerUserId,
    messageUserId = usageUserId,
  ) {
    const messageId = randomUUID();
    const usageId = randomUUID();
    const id = randomUUID();
    await pool.query(
      `insert into assistant_messages(id,conversation_id,user_id,role,status)
       values ($1,$2,$3,'assistant','complete')`,
      [messageId, conversationId, messageUserId],
    );
    await pool.query(
      `insert into assistant_usage_ledger(id,user_id,message_id,allowance_source)
       values ($1,$2,$3,'credit')`,
      [usageId, usageUserId, messageId],
    );
    await pool.query(
      `insert into assistant_credit_ledger(id,user_id,delta,reason,usage_ledger_id)
       values ($1,$2,-1,'message_spent',$3)`,
      [id, ledgerUserId, usageId],
    );
    return { id, usageId, messageId };
  }

  async function turnUsage(
    ledgerUserId: string,
    conversationId: string,
    turnUserId = ledgerUserId,
  ) {
    const usageId = randomUUID();
    const id = randomUUID();
    // D attribution survives retained usage/message removal. No such rows are seeded.
    await pool.query(
      `insert into assistant_credit_turns(usage_ledger_id,user_id,conversation_id,accepted_at,
         policy_key,policy_epoch,funding_source,reserved_ceiling,held_credits,applied_credits,
         bound_version,cost_revision,applied_cost_revision,state,finalized_at)
       values ($1,$2,$3,now(),'free_then_actual_cost_v1',1,'credit',12,0,12,
         'history-test-bound',1,1,'settled',now())`,
      [usageId, turnUserId, conversationId],
    );
    await pool.query(
      `insert into assistant_credit_ledger(id,user_id,delta,reason,usage_ledger_id,cost_revision)
       values ($1,$2,-12,'message_spent',$3,1)`,
      [id, ledgerUserId, usageId],
    );
    return { id, usageId };
  }

  it('returns two own conversations on legacy/D usage and refunds, plus exact catalogue grant labels', async () => {
    const user = await register();
    const first = await conversation(user.userId, 'Dinner plans');
    const second = await conversation(user.userId, null);
    const legacy = await legacyUsage(user.userId, first.id);
    const turn = await turnUsage(user.userId, second.id);
    const refundId = randomUUID();
    await pool.query(
      `insert into assistant_credit_ledger(id,user_id,delta,reason,usage_ledger_id,cost_revision)
       values ($1,$2,3,'assistant_usage_adjustment',$3,2)`,
      [refundId, user.userId, turn.usageId],
    );
    await pool.query(
      `update assistant_credit_turns set applied_credits=9,cost_revision=2,applied_cost_revision=2
       where usage_ledger_id=$1`,
      [turn.usageId],
    );
    const eventId = randomUUID();
    const grantId = randomUUID();
    const labels = { vi: `Thưởng ${eventId}`, en: `Reward ${eventId}` };
    await pool.query(
      `insert into credit_events(id,key,labels,trigger_event_type,trigger_schema_version,condition,
         audience,dedup_scope,amount)
       values ($1,'history_test_reward',$2,'history.test',1,'{"all":[]}',
         'individual','per_subject',5)`,
      [eventId, labels],
    );
    await pool.query(
      `insert into assistant_credit_ledger(id,user_id,delta,reason,credit_event_id,entitlement_key)
       values ($1,$2,5,'history_test_reward',$3,$4)`,
      [grantId, user.userId, eventId, randomUUID()],
    );
    const historicalGrantId = await grant(user.userId);
    const response = await get(user.accessToken, '/ledger');
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    const entry = (id: string) => page.items.find((item: { id: string }) => item.id === id);
    expect(entry(legacy.id)).toMatchObject({ conversation: first, eventLabels: null });
    expect(entry(turn.id)).toMatchObject({ conversation: second, eventLabels: null });
    expect(entry(refundId)).toMatchObject({
      conversation: second,
      eventLabels: null,
      direction: 'adjustment',
    });
    expect(entry(grantId)).toMatchObject({ conversation: null, eventId, eventLabels: labels });
    expect(entry(historicalGrantId)).toMatchObject({ conversation: null, eventLabels: null });
    expect(JSON.stringify(page)).not.toContain(legacy.usageId);
    expect(JSON.stringify(page)).not.toContain(legacy.messageId);
    expect(JSON.stringify(page)).not.toContain(turn.usageId);
  });

  it('returns null after conversation deletion or expiry and for unknown usage', async () => {
    const user = await register();
    const deleted = await conversation(user.userId, 'Deleted private title');
    const expired = await conversation(user.userId, 'Expired private title');
    await legacyUsage(user.userId, deleted.id);
    await turnUsage(user.userId, deleted.id);
    await legacyUsage(user.userId, expired.id);
    await turnUsage(user.userId, expired.id);
    await pool.query('delete from assistant_conversations where id=$1', [deleted.id]);
    await pool.query(
      `update assistant_conversations set last_message_at=now()-interval '91 days' where id=$1`,
      [expired.id],
    );
    await pool.query(
      `insert into assistant_credit_ledger(user_id,delta,reason,usage_ledger_id)
       values ($1,-1,'message_spent',$2)`,
      [user.userId, randomUUID()],
    );
    const response = await get(user.accessToken, '/ledger');
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(5);
    for (const entry of response.json().items)
      expect(entry).toMatchObject({ conversation: null, eventLabels: null });
    expect(JSON.stringify(response.json())).not.toContain(deleted.title);
    expect(JSON.stringify(response.json())).not.toContain(expired.title);
  });

  it('never follows foreign usage, messages, turns or conversations, or a fallback for a known D turn', async () => {
    const user = await register();
    const other = await register();
    const own = await conversation(user.userId, 'Own conversation');
    const foreign = await conversation(other.userId, 'Other user secret');
    // Deliberately inconsistent links verify each boundary independently.
    await legacyUsage(user.userId, own.id, other.userId, user.userId);
    await legacyUsage(user.userId, own.id, user.userId, other.userId);
    await legacyUsage(user.userId, foreign.id);
    await turnUsage(user.userId, own.id, other.userId);
    await turnUsage(user.userId, foreign.id);
    const legacy = await legacyUsage(user.userId, own.id);
    await pool.query(
      `insert into assistant_credit_turns(usage_ledger_id,user_id,conversation_id,accepted_at,
         policy_key,policy_epoch,funding_source,reserved_ceiling,held_credits,applied_credits,
         bound_version,cost_revision,applied_cost_revision,state,finalized_at)
       values ($1,$2,$3,now(),'free_then_actual_cost_v1',1,'credit',1,0,1,
         'history-test-bound',1,1,'settled',now())`,
      [legacy.usageId, user.userId, foreign.id],
    );
    const otherEntry = await legacyUsage(other.userId, foreign.id);
    const response = await get(user.accessToken, '/ledger');
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.items).toHaveLength(6);
    for (const entry of page.items)
      expect(entry).toMatchObject({ conversation: null, eventLabels: null });
    expect(JSON.stringify(page)).not.toContain(foreign.id);
    expect(JSON.stringify(page)).not.toContain(foreign.title);
    expect(JSON.stringify(page)).not.toContain(otherEntry.id);
  });
});
