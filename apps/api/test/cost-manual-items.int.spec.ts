import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';
import {
  COST_REGISTRY,
  addMonths,
  ManualCostService,
  manualCostSource,
  writeAudit,
} from '@gogo/modules';

/**
 * COST-BE-023 (#382) — manual / fixed costs against a real Postgres and the
 * booted app: the permission gate on every route, the registry as the only
 * judge of what may carry a manual cost, and the acceptance the issue
 * states — a MONTHLY item becomes a MANUAL row on its billing day
 * (COST-BE-034 / ADR-0015: a charge, not a daily share), a changed amount
 * changes the row, a deleted item leaves none, and every write has an audit
 * row with a diff. Then the same rows read back through the Cost API as
 * `manualMicros`, which is the point of materialising at all.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.73.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;

const tokens: Record<string, string> = {};
const ENV = 'dev';
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const MONTH_START = `${MONTH}-01`;
const DAY_OF_MONTH = Number(TODAY.slice(8, 10));
/** The next 1st-of-month charge as of today: today itself on the 1st, else next month. */
const NEXT_FIRST = DAY_OF_MONTH === 1 ? MONTH_START : `${addMonths(MONTH, 1)}-01`;
const BASE = '/v1/cms/ops/costs/manual-items';

async function createAdmin(role: 'editor' | 'moderator' | 'ops_admin' | 'super_admin') {
  const email = `manual-cost-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db.insert(schema.adminUsers).values({ email, passwordHash, displayName: role, role });
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  role?: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  api().inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...headers },
    ...(payload !== undefined ? { payload } : {}),
  });

type Row = { day: string; provider_id: string; service_id: string; amount_micros: string };
async function manualRows(): Promise<Row[]> {
  const { rows } = await db.execute(sql`
    select to_char(day, 'YYYY-MM-DD') as day, provider_id, service_id, amount_micros::text as amount_micros,
           basis, confidence, source, currency, cost_kind, billing_cadence,
           period_amount_micros::text as period_amount_micros, metadata
    from provider_cost_daily
    where environment = ${ENV} and basis = 'MANUAL'
    order by day, source
  `);
  return rows as unknown as Row[];
}

async function audits(): Promise<{ action: string; resource_id: string; diff: unknown }[]> {
  const { rows } = await db.execute(sql`
    select action, resource_id, diff from audit_logs
    where action like 'cost.manual_item.%' order by created_at, action
  `);
  return rows as never;
}

const monthlyItem = {
  providerId: 'apple',
  serviceId: 'apple.developer_program',
  name: 'Apple Developer Program',
  amountMicros: 30_000_000,
  currency: 'USD',
  period: 'MONTHLY',
  effectiveFrom: MONTH_START,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_cost_manual_items_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
  process.env.APP_ENV = ENV;
  process.env.COST_LEDGER_ENABLED = 'true';

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();
  for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
    await createAdmin(role);
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('#382 — RBAC on every manual-cost route', () => {
  it('refuses an unauthenticated caller, an editor and a moderator on read and write alike', async () => {
    const id = randomUUID();
    const attempts: ['GET' | 'POST' | 'PATCH' | 'DELETE', string, object?][] = [
      ['GET', BASE],
      ['POST', BASE, monthlyItem],
      ['GET', `${BASE}/${id}`],
      ['PATCH', `${BASE}/${id}`, { name: 'x' }],
      ['DELETE', `${BASE}/${id}`],
    ];
    for (const [method, url, payload] of attempts) {
      expect((await call(method, url, undefined, payload)).statusCode, `${method} ${url}`).toBe(
        401,
      );
      const editor = await call(method, url, 'editor', payload);
      expect(editor.statusCode, `${method} ${url}`).toBe(403);
      expect(editor.json().code).toBe('ROLE_DENIED');
      expect((await call(method, url, 'moderator', payload)).statusCode, `${method} ${url}`).toBe(
        403,
      );
    }
    // A refused caller wrote nothing.
    expect(await manualRows()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('lets ops_admin and super_admin read; an unknown id is a 404, a non-uuid a 400', async () => {
    for (const role of ['ops_admin', 'super_admin']) {
      const list = await call('GET', BASE, role);
      expect(list.statusCode, role).toBe(200);
      expect(list.json().items).toEqual([]);
      expect((await call('GET', `${BASE}/${randomUUID()}`, role)).statusCode).toBe(404);
      expect((await call('GET', `${BASE}/${randomUUID()}`, role)).json().code).toBe(
        'COST_MANUAL_ITEM_NOT_FOUND',
      );
      expect((await call('GET', `${BASE}/not-a-uuid`, role)).statusCode).toBe(400);
    }
  });
});

describe('#382 — the registry decides who may carry a manual cost (epic §6, §44.2)', () => {
  it('lists eligible services from MANUAL_COST, provider-wide or service-only', async () => {
    const res = await call('GET', BASE, 'ops_admin');
    expect(res.statusCode).toBe(200);
    const eligible = res.json().eligibleServices as { serviceId: string; providerId: string }[];
    expect(eligible.map((e) => e.serviceId)).toEqual(
      COST_REGISTRY.servicesWith('MANUAL_COST').map((s) => s.id),
    );
    expect(eligible).toContainEqual({
      providerId: 'google',
      providerDisplayName: 'Google',
      serviceId: 'google.play_console',
      displayName: 'Play Console',
    });
    expect(eligible.some((e) => e.serviceId === 'google.places')).toBe(false);
  });

  it('refuses a service without MANUAL_COST, a service under the wrong provider, an unknown provider, an inverted range, a bad currency — each as a field error', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [
        { serviceId: 'google.places', providerId: 'google' },
        'serviceId',
        'manual_cost_not_supported',
      ],
      [{ serviceId: 'hosting.vps' }, 'serviceId', 'unknown_service'],
      [{ providerId: 'acme', serviceId: 'acme.thing' }, 'providerId', 'unknown_provider'],
      [{ effectiveTo: '2020-01-01' }, 'effectiveTo', 'invalid_range'],
    ];
    for (const [over, field, code] of cases) {
      const res = await call('POST', BASE, 'ops_admin', { ...monthlyItem, ...over });
      expect(res.statusCode, `${field}/${code}`).toBe(400);
      expect(res.json().code).toBe('COST_MANUAL_ITEM_INVALID');
      expect(res.json().field_errors).toEqual([expect.objectContaining({ field, code })]);
    }
    // Shape failures are the pipe's, before the service sees them.
    for (const over of [
      { currency: 'usd' },
      { period: 'WEEKLY' },
      { effectiveFrom: '2026-02-30' },
      { amountMicros: -1 },
      { amountMicros: 1.5 },
      { name: '' },
    ]) {
      const res = await call('POST', BASE, 'ops_admin', { ...monthlyItem, ...over });
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    }
    expect(await manualRows()).toEqual([]);
    expect(await audits()).toEqual([]);
  });
});

describe('#382 — lifecycle: create → row, change → row changes, delete → row gone, all audited', () => {
  let itemId = '';

  it('creates a MONTHLY item and materialises one MANUAL row on its billing day, at the full fee', async () => {
    const res = await call('POST', BASE, 'ops_admin', monthlyItem, {
      'idempotency-key': 'manual-item-create-0001',
    });
    expect(res.statusCode).toBe(201);
    const item = res.json().item;
    itemId = item.id;
    expect(item).toMatchObject({
      environment: ENV,
      providerId: 'apple',
      serviceId: 'apple.developer_program',
      name: 'Apple Developer Program',
      amountMicros: 30_000_000,
      currency: 'USD',
      period: 'MONTHLY',
      // ADR-0015: the classification every cost source carries, and the next billing day.
      costKind: 'RECURRING',
      billingCadence: 'MONTHLY',
      nextChargeDay: NEXT_FIRST,
      effectiveFrom: MONTH_START,
      effectiveTo: null,
      note: null,
    });
    expect(item.createdBy).toMatch(/^[0-9a-f-]{36}$/);

    // One row, on the 1st, for the whole fee — not a share per elapsed day.
    const rows = await manualRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: MONTH_START,
      provider_id: 'apple',
      service_id: 'apple.developer_program',
      amount_micros: '30000000',
      basis: 'MANUAL',
      confidence: 'HIGH',
      currency: 'USD',
      source: manualCostSource(itemId),
      cost_kind: 'RECURRING',
      billing_cadence: 'MONTHLY',
      period_amount_micros: '30000000',
    });
    expect((rows[0] as unknown as { metadata: { itemId: string; name: string } }).metadata).toEqual(
      expect.objectContaining({
        itemId,
        name: 'Apple Developer Program',
        period: 'MONTHLY',
        costKind: 'RECURRING',
        billingCadence: 'MONTHLY',
        chargeDay: MONTH_START,
      }),
    );
    // Nothing past today: a month-to-date is month-to-date.
    expect(rows.every((r) => r.day <= TODAY)).toBe(true);
  });

  it('replays the create under the same Idempotency-Key instead of adding a second item', async () => {
    const again = await call('POST', BASE, 'ops_admin', monthlyItem, {
      'idempotency-key': 'manual-item-create-0001',
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().item.id).toBe(itemId);
    const list = await call('GET', BASE, 'ops_admin');
    expect(list.json().items).toHaveLength(1);
    expect((await manualRows()).length).toBe(1);
  });

  it('reads back through the Cost API as manualMicros / basis MANUAL, and as a landed recurring charge in the forecast', async () => {
    const res = await call('GET', '/v1/cms/ops/costs/providers/apple?window=mtd', 'ops_admin');
    expect(res.statusCode).toBe(200);
    const provider = res.json().provider;
    const expected = 30_000_000;
    expect(provider).toMatchObject({
      providerId: 'apple',
      status: 'active',
      capabilities: ['MANUAL_COST'],
      // ADR-0014: a fee is MANUAL and, materialised through today, FRESH; it has no runtime.
      cost: { kind: 'MANUAL', freshness: 'FRESH' },
      runtime: { coverage: 'N/A' },
      spendMicros: expected,
      manualMicros: expected,
      estimatedMicros: null,
      actualMicros: null,
      basis: 'MANUAL',
      confidence: 'HIGH',
      currency: 'USD',
      costStatus: 'KNOWN',
    });
    expect(provider.services[0]).toMatchObject({
      serviceId: 'apple.developer_program',
      capabilities: ['MANUAL_COST'],
      manualMicros: expected,
      basis: 'MANUAL',
    });
    const overview = await call('GET', '/v1/cms/ops/costs?window=today', 'ops_admin');
    const { cards } = overview.json();
    // The fee landed on the 1st: today's card carries it only on the 1st.
    expect(cards.today.byBasis?.MANUAL ?? 0).toBe(DAY_OF_MONTH === 1 ? expected : 0);
    expect(cards.monthToDate.byBasis.MANUAL).toBe(expected);
    expect(cards.monthToDate.byKind).toEqual({ USAGE: 0, RECURRING: expected, ONE_TIME: 0 });
    // ADR-0015: landed in full, nothing scheduled, a monthly run-rate input,
    // and never multiplied by the days of the month.
    expect(cards.forecast.recurring).toEqual({
      landedMicros: expected,
      scheduledMicros: 0,
      committedMicros: expected,
    });
    expect(cards.forecast.scheduled).toEqual([]);
    expect(cards.forecast.runRate.recurringMonthlyMicros).toBe(expected);
    expect(cards.forecast.cash.floorMicros).toBe(expected);
  });

  it('changes the amount and every row follows; the audit diff names only what changed', async () => {
    const res = await call('PATCH', `${BASE}/${itemId}`, 'ops_admin', {
      amountMicros: 60_000_000,
      note: '  renewed  ',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toMatchObject({ amountMicros: 60_000_000, note: 'renewed' });
    const rows = await manualRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount_micros: '60000000', period_amount_micros: '60000000' });
    const trail = await audits();
    expect(trail.map((a) => a.action)).toEqual([
      'cost.manual_item.created',
      'cost.manual_item.updated',
    ]);
    expect(trail[1]?.diff).toEqual({
      changed: {
        amountMicros: { before: 30_000_000, after: 60_000_000 },
        note: { before: null, after: 'renewed' },
      },
    });
    // A no-op patch changes nothing and audits nothing.
    const same = await call('PATCH', `${BASE}/${itemId}`, 'ops_admin', {
      amountMicros: 60_000_000,
    });
    expect(same.statusCode).toBe(200);
    expect((await audits()).length).toBe(2);
    // An empty patch is refused by shape.
    expect((await call('PATCH', `${BASE}/${itemId}`, 'ops_admin', {})).statusCode).toBe(400);
  });

  it('moves the item to another service and shortens its range: the old row goes, the billed day stays', async () => {
    const res = await call('PATCH', `${BASE}/${itemId}`, 'ops_admin', {
      providerId: 'hosting',
      serviceId: 'hosting.vps',
      effectiveTo: MONTH_START,
    });
    expect(res.statusCode).toBe(200);
    const rows = await manualRows();
    expect(rows).toEqual([
      expect.objectContaining({
        day: MONTH_START,
        provider_id: 'hosting',
        service_id: 'hosting.vps',
        source: manualCostSource(itemId),
      }),
    ]);
    // The merged item is validated whole: a service that is not the provider's is refused.
    const bad = await call('PATCH', `${BASE}/${itemId}`, 'ops_admin', {
      serviceId: 'apple.developer_program',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().field_errors[0]).toMatchObject({
      field: 'serviceId',
      code: 'unknown_service',
    });
  });

  it('deletes the item and leaves no row behind; the audit keeps the item as it was', async () => {
    const res = await call('DELETE', `${BASE}/${itemId}`, 'super_admin');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(await manualRows()).toEqual([]);
    expect((await call('GET', `${BASE}/${itemId}`, 'ops_admin')).statusCode).toBe(404);
    expect((await call('DELETE', `${BASE}/${itemId}`, 'ops_admin')).statusCode).toBe(404);
    expect((await call('PATCH', `${BASE}/${itemId}`, 'ops_admin', { name: 'x' })).statusCode).toBe(
      404,
    );
    const trail = await audits();
    expect(trail.map((a) => a.action)).toEqual([
      'cost.manual_item.created',
      'cost.manual_item.updated',
      'cost.manual_item.updated',
      'cost.manual_item.deleted',
    ]);
    expect(trail.at(-1)?.diff).toEqual({
      before: expect.objectContaining({
        providerId: 'hosting',
        serviceId: 'hosting.vps',
        amountMicros: 60_000_000,
        effectiveTo: MONTH_START,
      }),
    });
    expect(trail.every((a) => a.resource_id === itemId)).toBe(true);
  });
});

describe('#382 — periods and idempotent rebuilds (service level, frozen clock)', () => {
  const SVC_ENV = 'svc';
  const svc = (now: string) =>
    new ManualCostService(db as never, COST_REGISTRY, {
      environment: SVC_ENV,
      now: () => new Date(now),
      audit: writeAudit,
    });
  const rowsOf = async () => {
    const { rows } = await db.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, source, amount_micros::text as amount_micros,
             cost_kind, billing_cadence
      from provider_cost_daily where environment = ${SVC_ENV} order by day, source
    `);
    return rows as unknown as {
      day: string;
      source: string;
      amount_micros: string;
      cost_kind: string;
      billing_cadence: string | null;
    }[];
  };

  it('YEARLY lands once a year, ONE_TIME once, a future item has no rows yet, and a rebuild is a no-op', async () => {
    const jan10 = svc('2026-01-10T09:00:00Z');
    const yearly = await jan10.create(
      {
        providerId: 'apple',
        serviceId: 'apple.developer_program',
        name: 'Developer Program',
        amountMicros: 36_500_000,
        period: 'YEARLY',
        effectiveFrom: '2026-01-01',
      },
      { adminId: null },
    );
    const once = await jan10.create(
      {
        providerId: 'registrar',
        serviceId: 'registrar.domain',
        name: 'gogo.vn',
        amountMicros: 5_000_000,
        currency: 'VND',
        period: 'ONE_TIME',
        effectiveFrom: '2026-01-05',
      },
      { adminId: null },
    );
    await jan10.create(
      {
        providerId: 'hosting',
        serviceId: 'hosting.vps',
        name: 'VPS',
        amountMicros: 1,
        period: 'MONTHLY',
        effectiveFrom: '2026-02-01',
      },
      { adminId: null },
    );
    const rows = await rowsOf();
    // The annual fee is one row on its renewal date, whole — not 1/365 a day.
    expect(rows.filter((r) => r.source === manualCostSource(yearly.id))).toEqual([
      {
        day: '2026-01-01',
        source: manualCostSource(yearly.id),
        amount_micros: '36500000',
        cost_kind: 'RECURRING',
        billing_cadence: 'ANNUAL',
      },
    ]);
    expect(rows.filter((r) => r.source === manualCostSource(once.id))).toEqual([
      {
        day: '2026-01-05',
        source: manualCostSource(once.id),
        amount_micros: '5000000',
        cost_kind: 'ONE_TIME',
        billing_cadence: null,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(yearly.nextChargeDay).toBe('2027-01-01');
    expect(once.nextChargeDay).toBeNull();

    // Nothing changed → nothing written, nothing deleted.
    expect(await jan10.materialise()).toMatchObject({
      environment: SVC_ENV,
      today: '2026-01-10',
      items: 3,
      rowsWritten: 0,
      rowsDeleted: 0,
    });
    // The clock moves: the worker's daily pass lands the February VPS fee
    // (Feb 1) and nothing else — the annual fee's next date is 2027.
    expect(await svc('2026-02-02T09:00:00Z').materialise()).toMatchObject({
      rowsWritten: 1,
      rowsDeleted: 0,
    });
    // Moving the yearly anchor drops the old billing-day row and lands the new one.
    await svc('2026-02-02T09:00:00Z').update(
      yearly.id,
      { effectiveFrom: '2026-01-15' },
      { adminId: null },
    );
    expect(
      (await rowsOf()).filter((r) => r.source === manualCostSource(yearly.id)).map((r) => r.day),
    ).toEqual(['2026-01-15']);
    // An orphaned row (item gone from the table by other means) is swept.
    await db.execute(sql`delete from manual_cost_items where id = ${once.id}`);
    expect(await svc('2026-02-02T09:00:00Z').materialise()).toMatchObject({ rowsDeleted: 1 });
    expect((await rowsOf()).some((r) => r.source === manualCostSource(once.id))).toBe(false);
  });
});
