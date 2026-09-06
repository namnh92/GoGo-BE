import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { CostCenterService, ManualCostService, COST_REGISTRY } from '@gogo/modules';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let snapshot: string;
const now = () => new Date('2026-09-10T12:00:00Z');
const fixtures = [
  ['11111111-1111-4111-8111-111111111111', 'apple', 'apple.developer_program', 120_000_000],
  ['22222222-2222-4222-8222-222222222222', 'hosting', 'hosting.vps', 240_000_000],
  ['33333333-3333-4333-8333-333333333333', 'registrar', 'registrar.domain', 36_000_000],
] as const;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  snapshot = await mkdtemp(path.join(tmpdir(), 'gogo-before-0043-'));
  const migrations = path.resolve(__dirname, '../../../migrations');
  await cp(migrations, snapshot, { recursive: true });
  const journalPath = path.join(snapshot, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 43);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(db, { migrationsFolder: snapshot });
  // Representative pre-deployment snapshot: authoritative annual items and old daily shares.
  // Synthetic amounts deliberately differ from DEV; never seed or re-enter production values.
  for (const [id, provider, service, amount] of fixtures) {
    await pool.query(
      `insert into manual_cost_items
      (id, environment, provider_id, service_id, name, amount_micros, currency, period, effective_from)
      values ($1, 'dev', $2, $3, $3, $4, 'USD', 'YEARLY', '2026-01-15')`,
      [id, provider, service, amount],
    );
    await pool.query(
      `insert into provider_cost_daily
      (day, environment, provider_id, service_id, amount_micros, currency, basis, confidence, source, metadata)
      values ('2026-09-01', 'dev', $1, $2, 123, 'USD', 'MANUAL', 'HIGH', $3, $4::jsonb)`,
      [
        provider,
        service,
        `manual_cost_items:${id}`,
        JSON.stringify({ itemId: id, period: 'YEARLY', amountMicros: amount }),
      ],
    );
  }
  await migrate(db, { migrationsFolder: migrations });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (snapshot) await rm(snapshot, { recursive: true, force: true });
});

it('0043 backfill and repeated worker rebuild preserve annual items and zero non-due cash', async () => {
  const classified = await pool.query(
    'select cost_kind, billing_cadence, period_amount_micros from provider_cost_daily order by provider_id',
  );
  expect(classified.rows).toHaveLength(3);
  for (const row of classified.rows) {
    expect(row).toMatchObject({ cost_kind: 'RECURRING', billing_cadence: 'ANNUAL' });
    expect(Number(row.period_amount_micros)).toBeGreaterThan(123);
  }
  const manual = new ManualCostService(db, COST_REGISTRY, {
    environment: 'dev',
    now,
    audit: async () => {
      throw new Error('A rebuild must not edit manual items');
    },
  });
  expect(await manual.materialise()).toMatchObject({ items: 3, rowsWritten: 3, rowsDeleted: 3 });
  expect(await manual.materialise()).toMatchObject({ items: 3, rowsWritten: 0, rowsDeleted: 0 });
  expect(
    (await pool.query("select * from provider_cost_daily where day >= '2026-09-01'")).rows,
  ).toEqual([]);
  const center = new CostCenterService(db, COST_REGISTRY, {
    environment: 'dev',
    ledgerEnabled: true,
    now,
  });
  const overview = await center.overview('mtd');
  expect(overview.cards.forecast.actual.micros).toBe(0);
  expect(overview.cards.forecast.cash.floorMicros).toBe(0);
  expect(overview.cards.forecast.runRate.annualEquivalentMicros).toBe(33_000_000);
  for (const [id, provider, service, amount] of fixtures) {
    const expected = {
      cost: { kind: 'MANUAL', freshness: 'FRESH' },
      basis: 'MANUAL',
      costStatus: 'KNOWN',
      spendMicros: 0,
      manualMicros: 0,
      billingItems: [
        {
          id,
          amountMicros: amount,
          costKind: 'RECURRING',
          billingCadence: 'ANNUAL',
          periodAmountMicros: amount,
          nextChargeDay: '2027-01-15',
          normalizedMonthlyRunRateMicros: amount / 12,
        },
      ],
    };
    expect(overview.providerRows.find((r) => r.providerId === provider)).toMatchObject(expected);
    expect(await center.provider(provider, 'mtd')).toMatchObject(expected);
    expect(await center.service(provider, service, 'mtd')).toMatchObject(expected);
    expect(overview.cards.unknown.serviceIds).not.toContain(service);
  }
  const otherEnvironment = new CostCenterService(db, COST_REGISTRY, {
    environment: 'preview',
    ledgerEnabled: true,
    now,
  });
  expect(await otherEnvironment.provider('apple', 'mtd')).toMatchObject({
    costStatus: 'UNKNOWN',
    billingItems: [],
  });
});
