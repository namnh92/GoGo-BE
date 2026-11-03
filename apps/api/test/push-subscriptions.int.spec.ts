import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { PushIdentityService, PushSubscriptionsService, audiencePredicate } from '@gogo/modules';

/**
 * NTF-BE-016 (#746), ADR-0037 — ownership writes as a compare-and-set, and the
 * fence for a row that does not exist yet.
 *
 * The orderings here are forced, not hoped for: the provider read is held open
 * while the competing request runs from start to finish, which is exactly the
 * window the protocol exists for. `PUSH_TEST_DATABASE_URL` (a server where the
 * role may CREATE DATABASE) replaces the container on a workstation without
 * Docker. CI uses the container.
 */

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');
const APP_ID = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

let container: StartedPostgreSqlContainer | null = null;
let serverUrl: string;
const databases: string[] = [];
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function freshDatabase(): Promise<string> {
  const name = `gogo_push_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  databases.push(name);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** What the provider says about one subscription, and a way to hold its answer open. */
function fakeProvider() {
  const state = { enabled: true, sub: '', held: null as null | Promise<void>, reached: () => {} };
  const fetchImpl = (async () => {
    // The answer is decided when the request arrives, like a real read: holding
    // the response is what makes it stale by the time the caller acts on it.
    const subscriptions = state.enabled ? [{ id: state.sub, enabled: true }] : [];
    const held = state.held;
    state.held = null;
    state.reached();
    if (held) await held;
    return new Response(JSON.stringify({ subscriptions }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return Object.assign(state, { fetchImpl });
}

type Provider = ReturnType<typeof fakeProvider>;

function services(provider: Provider) {
  const identity = new PushIdentityService(
    {
      ONESIGNAL_APP_ID: APP_ID,
      ONESIGNAL_IDENTITY_VERIFICATION_KEY: PEM,
      ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 3_600,
    } as never,
    undefined,
    provider.fetchImpl,
  );
  return new PushSubscriptionsService(db as never, identity);
}

/** Hold the next provider answer. Resolves once the caller is waiting on it. */
function holdNextRead(provider: Provider) {
  let release!: () => void;
  provider.held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (provider.reached = r));
  return { release, reached };
}

async function newUser() {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    email: `push-${id}@gogo.id.vn`,
    displayName: 'push',
  } as never);
  return { type: 'user', id, sessionId: `s-${id}` } as const;
}

function scenario() {
  const provider = fakeProvider();
  provider.sub = randomUUID();
  return { provider, svc: services(provider), sub: provider.sub };
}

const row = async (subscriptionId: string) =>
  (
    await db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.subscriptionId, subscriptionId))
  )[0];

const codeOf = (e: unknown) => (e as { code?: string }).code;

// The orderings below drive a logout as the endpoint runs it.
const logout = (svc: PushSubscriptionsService, actor: { id: string }, sub: string) =>
  svc.confirmLogout(actor as never, sub);

beforeAll(async () => {
  const external = process.env['PUSH_TEST_DATABASE_URL'];
  if (external) {
    serverUrl = external;
  } else {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
      .withDatabase('gogo_push_test')
      .start();
    serverUrl = container.getConnectionUri();
  }
  pool = new Pool({ connectionString: await freshDatabase(), max: 6 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  if (container) {
    await container.stop();
    return;
  }
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  for (const name of databases) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe('AC-2 — a row that does not exist yet (R-20, R-23)', () => {
  it('a registration verified before a confirmed logout cannot create the row after it', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();

    const hold = holdNextRead(provider);
    const late = svc
      .register(user, { platform: 'ios', subscriptionId: sub })
      .catch((e: unknown) => e);
    await hold.reached;

    provider.enabled = false;
    await expect(logout(svc, user, sub)).resolves.toEqual({ confirmed: true });

    hold.release();
    expect(codeOf(await late)).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect(await row(sub)).toBeUndefined();

    // The 409 means "verify again", and the fresh answer is the true one.
    const again = await svc
      .register(user, { platform: 'ios', subscriptionId: sub })
      .catch((e: unknown) => e);
    expect(codeOf(again)).toBe('PUSH_SUBSCRIPTION_NOT_CONFIRMED');
    expect(await row(sub)).toBeUndefined();
  });

  it('a logout that saw no row cannot revoke a registration newer than its answer', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();

    provider.enabled = false;
    const hold = holdNextRead(provider);
    const delayed = logout(svc, user, sub);
    await hold.reached;

    provider.enabled = true;
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    hold.release();
    await expect(delayed).resolves.toEqual({ confirmed: true });
    const after = await row(sub);
    expect(after?.userId).toBe(user.id);
    expect(after?.revokedAt).toBeNull();
  });

  it('a registration still needs the current fence after that delayed logout landed', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();

    provider.enabled = false;
    await logout(svc, user, sub);
    provider.enabled = true;

    // A fresh read after the logout sees the new generation, so it lands.
    await svc.register(user, { platform: 'android', subscriptionId: sub });
    expect((await row(sub))?.revokedAt).toBeNull();
  });

  it('waits for a logout still in flight rather than reading past it', async () => {
    // Without the fence's row lock, a plain comparison could read the old
    // generation and insert after the logout commits. Hold the logout's
    // transaction open and show the registration waits, then loses.
    const { provider, svc, sub } = scenario();
    const user = await newUser();

    const hold = holdNextRead(provider);
    const late = svc
      .register(user, { platform: 'ios', subscriptionId: sub })
      .catch((e: unknown) => e);
    await hold.reached;

    const logoutTx = await pool.connect();
    await logoutTx.query('begin');
    await logoutTx.query(
      `insert into push_subscription_fences (subscription_id, generation) values ($1, 1)`,
      [sub],
    );

    hold.release();
    const settled = await Promise.race([
      late.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('waiting'), 300)),
    ]);
    expect(settled).toBe('waiting');

    await logoutTx.query('commit');
    logoutTx.release();
    expect(codeOf(await late)).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect(await row(sub)).toBeUndefined();
  });

  it('two first reports at once write one row; the loser is told to report again', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();

    const hold = holdNextRead(provider);
    const first = svc
      .register(user, { platform: 'ios', subscriptionId: sub })
      .catch((e: unknown) => e);
    await hold.reached;
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    hold.release();
    expect(codeOf(await first)).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect((await row(sub))?.revision).toBe(0);
  });
});

describe('AC-2 — a row that exists (R-20, D1)', () => {
  it('a delayed logout cannot revoke a newer registration', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    provider.enabled = false;
    const hold = holdNextRead(provider);
    const delayed = logout(svc, user, sub);
    await hold.reached;

    provider.enabled = true;
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    hold.release();
    await expect(delayed).resolves.toEqual({ confirmed: true });
    const after = await row(sub);
    expect(after?.revokedAt).toBeNull();
    expect(after?.revision).toBe(1);
  });

  it('a registration verified before a logout cannot undo that logout', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    const hold = holdNextRead(provider);
    const late = svc
      .register(user, { platform: 'ios', subscriptionId: sub })
      .catch((e: unknown) => e);
    await hold.reached;

    provider.enabled = false;
    await logout(svc, user, sub);
    hold.release();

    expect(codeOf(await late)).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect((await row(sub))?.revokedAt).not.toBeNull();
  });

  it('a registration verified before a logout cannot reactivate an already revoked row', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();
    await svc.register(user, { platform: 'ios', subscriptionId: sub });
    provider.enabled = false;
    await logout(svc, user, sub);
    provider.enabled = true;

    const hold = holdNextRead(provider);
    const late = svc
      .register(user, { platform: 'ios', subscriptionId: sub })
      .catch((e: unknown) => e);
    await hold.reached;

    provider.enabled = false;
    await logout(svc, user, sub);
    hold.release();

    expect(codeOf(await late)).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect((await row(sub))?.revokedAt).not.toBeNull();
  });

  it('a confirmed logout revokes the row and advances its revision', async () => {
    const { provider, svc, sub } = scenario();
    const user = await newUser();
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    provider.enabled = false;
    await logout(svc, user, sub);

    const after = await row(sub);
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revision).toBe(1);
  });

  it('an unconfirmed logout leaves the row and the fence alone', async () => {
    const { svc, sub } = scenario();
    const user = await newUser();
    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    await expect(logout(svc, user, sub)).resolves.toEqual({ confirmed: false });

    expect((await row(sub))?.revokedAt).toBeNull();
    const fence = await db
      .select()
      .from(schema.pushSubscriptionFences)
      .where(eq(schema.pushSubscriptionFences.subscriptionId, sub));
    // The registration's own touch left generation 0; only a confirmation moves it.
    expect(fence.map((f) => f.generation)).toEqual([0]);
  });

  it("another user's logout does not touch the row", async () => {
    const { provider, svc, sub } = scenario();
    const owner = await newUser();
    const other = await newUser();
    await svc.register(owner, { platform: 'ios', subscriptionId: sub });

    provider.enabled = false;
    await logout(svc, other, sub);

    expect((await row(sub))?.revokedAt).toBeNull();
    expect((await row(sub))?.userId).toBe(owner.id);
  });

  it('a device moves to whoever signs in next, as one row', async () => {
    const { svc, sub } = scenario();
    const a = await newUser();
    const b = await newUser();
    await svc.register(a, { platform: 'ios', subscriptionId: sub });
    await svc.register(b, { platform: 'ios', subscriptionId: sub });

    const after = await row(sub);
    expect(after?.userId).toBe(b.id);
    expect(after?.ownerKind).toBe('user');
    expect(after?.revision).toBe(1);
  });
});

describe('AC-3 — rollback baseline (R-18, R-18b)', () => {
  const deviceRow = async (sub: string) =>
    pool.query(
      `insert into push_subscriptions (owner_kind, device_id, platform, subscription_id)
       values ('device', $1, 'ios', $2)`,
      [randomUUID(), sub],
    );

  it('this binary takes over a device-owned row, atomically and validly', async () => {
    const { svc, sub } = scenario();
    const user = await newUser();
    await deviceRow(sub);

    await svc.register(user, { platform: 'ios', subscriptionId: sub });

    const after = await row(sub);
    expect(after).toMatchObject({
      ownerKind: 'user',
      userId: user.id,
      deviceId: null,
      revokedAt: null,
      revision: 1,
    });
  });

  it('this binary takes over a row the previous binary wrote between the two releases', async () => {
    const { svc, sub } = scenario();
    const before = await newUser();
    const after = await newUser();
    // The previous binary's upsert, verbatim: it knows none of the new columns.
    await pool.query(
      `insert into push_subscriptions (user_id, platform, subscription_id) values ($1, 'ios', $2)
       on conflict (subscription_id) do update set user_id = $1, last_confirmed_at = now(), revoked_at = null`,
      [before.id, sub],
    );

    await svc.register(after, { platform: 'ios', subscriptionId: sub });

    expect(await row(sub)).toMatchObject({ ownerKind: 'user', userId: after.id, revision: 1 });
  });

  it('the previous binary is refused on a device-owned row: why it is not the baseline', async () => {
    const { sub } = scenario();
    const before = await newUser();
    await deviceRow(sub);

    await expect(
      pool.query(
        `insert into push_subscriptions (user_id, platform, subscription_id) values ($1, 'ios', $2)
         on conflict (subscription_id) do update set user_id = $1, last_confirmed_at = now(), revoked_at = null`,
        [before.id, sub],
      ),
    ).rejects.toMatchObject({ constraint: 'push_subscriptions_one_owner' });
  });

  it.each([
    ['no owner', { owner_kind: 'user', user_id: null, device_id: null }],
    ['a device on a user row', { owner_kind: 'user', user_id: 'U', device_id: 'D' }],
    ['a user on a device row', { owner_kind: 'device', user_id: 'U', device_id: 'D' }],
    ['a device row with no device', { owner_kind: 'device', user_id: null, device_id: null }],
  ])('the schema refuses %s', async (_label, shape) => {
    const user = await newUser();
    const value = (v: string | null) => (v === 'U' ? user.id : v === 'D' ? randomUUID() : null);
    await expect(
      pool.query(
        `insert into push_subscriptions (owner_kind, user_id, device_id, platform, subscription_id)
         values ($1, $2, $3, 'ios', $4)`,
        [shape.owner_kind, value(shape.user_id), value(shape.device_id), randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: 'push_subscriptions_one_owner' });
  });

  it('a device-owned row joins no account audience', async () => {
    const count = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(sql`users u`)
          .where(audiencePredicate('all', {}))
      )[0]!.n;
    const before = await count();

    await deviceRow(scenario().sub);

    expect(await count()).toBe(before);
  });
});

describe('AC-1 — the migration on a database with data', () => {
  let oldPool: Pool;
  let folder: string;

  /** Migrations up to, not including, 0077, seeded as the running system has it. */
  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'gogo-migrations-'));
    await cp(MIGRATIONS, folder, { recursive: true });
    const journalPath = path.join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.tag < '0077');
    await writeFile(journalPath, JSON.stringify(journal));
    oldPool = new Pool({ connectionString: await freshDatabase(), max: 2 });
    await migrate(drizzle(oldPool, { schema }), { migrationsFolder: folder });
  }, 120_000);

  afterAll(async () => {
    await oldPool.end();
    await rm(folder, { recursive: true, force: true });
  });

  it('keeps every row and every audience result, and the down script restores the shape', async () => {
    const live = randomUUID();
    const gone = randomUUID();
    await oldPool.query(
      `insert into users (id, email, display_name) values
         ($1, 'live@gogo.id.vn', 'live'), ($2, 'gone@gogo.id.vn', 'gone')`,
      [live, gone],
    );
    await oldPool.query(
      `insert into push_subscriptions (user_id, platform, subscription_id, revoked_at) values
         ($1, 'ios', 'sub-live', null), ($2, 'android', 'sub-gone', now())`,
      [live, gone],
    );
    const audience = () =>
      oldPool.query<{ id: string }>(
        `select u.id from users u where u.status <> 'deleted' and exists (
           select 1 from push_subscriptions ps where ps.user_id = u.id and ps.revoked_at is null
         )`,
      );
    const before = (await audience()).rows;
    const seedDeviceRow = () =>
      oldPool.query(
        `insert into push_subscriptions (owner_kind, device_id, platform, subscription_id)
         values ('device', $1, 'ios', 'sub-device')`,
        [randomUUID()],
      );
    /**
     * Runs the migration's Down statement by statement on one connection, carrying
     * on after an error: the worst a runner can do, and what the script must survive.
     */
    const runDown = async () => {
      const source = await readFile(
        path.join(MIGRATIONS, '0077_push-subscription-ownership.sql'),
        'utf8',
      );
      const header = source.slice(source.indexOf('-- Down')).split('\n').slice(1);
      const end = header.findIndex((l) => !l.startsWith('--'));
      const statements: string[] = [];
      for (const line of header.slice(0, end).map((l) => l.replace(/^--\s{0,3}/, ''))) {
        if (/^(BEGIN|DO|DROP|ALTER|COMMIT)\b/.test(line)) statements.push(line);
        else statements[statements.length - 1] += `\n${line}`;
      }
      const errors: string[] = [];
      const client = await oldPool.connect();
      try {
        for (const statement of statements) {
          await client.query(statement).catch((e: Error) => errors.push(e.message));
        }
      } finally {
        client.release();
      }
      return errors;
    };

    await migrate(drizzle(oldPool, { schema }), { migrationsFolder: MIGRATIONS });

    expect((await audience()).rows).toEqual(before);
    const migrated = await oldPool.query(
      `select subscription_id, owner_kind, revision, device_id from push_subscriptions
       order by subscription_id`,
    );
    expect(migrated.rows).toEqual([
      { subscription_id: 'sub-gone', owner_kind: 'user', revision: 0, device_id: null },
      { subscription_id: 'sub-live', owner_kind: 'user', revision: 0, device_id: null },
    ]);

    await seedDeviceRow();
    expect((await runDown())[0]).toMatch(/device-owned/);
    // Refused means untouched: the constraint, the fences and the rows all stay.
    const kept = await oldPool.query(
      `select
         (select count(*)::int from push_subscriptions) as rows,
         (select count(*)::int from pg_constraint where conname = 'push_subscriptions_one_owner') as checks,
         to_regclass('push_subscription_fences') is not null as fences`,
    );
    expect(kept.rows[0]).toEqual({ rows: 3, checks: 1, fences: true });
    await oldPool.query(`delete from push_subscriptions where owner_kind = 'device'`);

    expect(await runDown()).toEqual([]);

    const columns = await oldPool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'push_subscriptions'`,
    );
    const names = columns.rows.map((c) => c.column_name);
    expect(names).not.toContain('owner_kind');
    expect(names).not.toContain('revision');
    expect(columns.rows.find((c) => c.column_name === 'user_id')?.is_nullable).toBe('NO');
    expect((await audience()).rows).toEqual(before);
  });
});
