import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { FakePush } from '@gogo/providers';
import {
  CampaignDispatcher,
  CampaignsService,
  PushDeviceIdentityService,
  PushDeviceLifecycle,
  PushIdentityService,
  PushSubscriptionsService,
  audiencePredicate,
} from '@gogo/modules';

/**
 * NTF-BE-017 (#747), ADR-0038 — a device with no session, and how its writes order
 * against everything else that can touch the same subscription.
 *
 * The orderings are forced: the provider read is held open while the competing
 * request runs from start to finish. `PUSH_TEST_DATABASE_URL` (a server where the
 * role may CREATE DATABASE) replaces the container on a workstation without Docker.
 */

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');
const APP_ID = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const FLAG = 'push.device_identity.enabled';

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

/** What the provider holds per external id, and a way to hold its next answer open. */
function fakeProvider() {
  const state = {
    subscriptions: new Map<string, { id: string; enabled: boolean }[]>(),
    held: null as null | Promise<void>,
    reached: () => {},
    down: false,
  };
  const fetchImpl = (async (url: string) => {
    if (state.down) throw new Error('down');
    const externalId = decodeURIComponent(String(url).split('/').pop()!);
    const subscriptions = state.subscriptions.get(externalId);
    const held = state.held;
    state.held = null;
    state.reached();
    if (held) await held;
    if (!subscriptions) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ subscriptions }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return Object.assign(state, { fetchImpl });
}

type Provider = ReturnType<typeof fakeProvider>;

function services(provider: Provider, ceiling = 1_000) {
  const metrics = new Map<string, number>();
  const port = {
    increment(name: string, labels?: Record<string, string>) {
      const key = `${name}:${labels?.['result'] ?? ''}`;
      metrics.set(key, (metrics.get(key) ?? 0) + 1);
    },
    observe() {},
    gauge() {},
  };
  const identity = new PushIdentityService(
    {
      ONESIGNAL_APP_ID: APP_ID,
      ONESIGNAL_IDENTITY_VERIFICATION_KEY: PEM,
      ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 3_600,
    } as never,
    undefined,
    provider.fetchImpl,
  );
  return {
    identity,
    metrics,
    users: new PushSubscriptionsService(db as never, identity, port as never),
    devices: new PushDeviceIdentityService(db as never, identity, {
      APP_ENV: 'dev',
      PUSH_DEVICE_IDENTITY_DAILY_CEILING: ceiling,
    } as never),
  };
}

function holdNextRead(provider: Provider) {
  let release!: () => void;
  provider.held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (provider.reached = r));
  return { release, reached };
}

async function setFlag(enabled: boolean, environment: 'all' | 'dev' = 'all') {
  await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, FLAG));
  await db.insert(schema.featureFlags).values({ key: FLAG, environment, platform: 'all', enabled });
}

async function newUser() {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    email: `device-${id}@gogo.id.vn`,
    displayName: 'device',
  } as never);
  return { type: 'user', id, sessionId: `s-${id}` } as const;
}

function scenario(ceiling?: number) {
  const provider = fakeProvider();
  return { provider, ...services(provider, ceiling), sub: randomUUID() };
}

async function newDevice(s: ReturnType<typeof scenario>) {
  const created = await s.devices.create();
  return {
    ...created,
    auth: `Device ${created.deviceId}.${created.deviceSecret}`,
    attach(subId: string, enabled = true) {
      s.provider.subscriptions.set(created.externalId, [{ id: subId, enabled }]);
    },
  };
}

const report = (over: Partial<Parameters<PushDeviceIdentityService['report']>[1]> = {}) => ({
  platform: 'ios' as const,
  subscriptionId: '',
  promotionsEnabled: true,
  preferenceVersion: 1,
  ...over,
});

const row = async (subscriptionId: string) =>
  (
    await db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.subscriptionId, subscriptionId))
  )[0];

const identityRow = async (id: string) =>
  (
    await db
      .select()
      .from(schema.pushDeviceIdentities)
      .where(eq(schema.pushDeviceIdentities.id, id))
  )[0];

const codeOf = (e: unknown) => (e as { code?: string }).code;
const fails = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => codeOf(e) ?? String(e),
  );

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
  pool = new Pool({ connectionString: await freshDatabase(), max: 8 });
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

beforeEach(async () => {
  await setFlag(true);
});

describe('AC-2 — issuance and renewal', () => {
  it('creates a device: identity whose JWT carries exactly the provider claims', async () => {
    const s = scenario();
    const d = await s.devices.create();
    expect(d.externalId).toBe(`device:${d.deviceId}`);
    const claims = JSON.parse(Buffer.from(d.token.split('.')[1]!, 'base64url').toString()) as {
      iss: string;
      exp: number;
      iat: number;
      identity: { external_id: string };
    };
    expect(claims.iss).toBe(APP_ID);
    expect(claims.identity).toEqual({ external_id: d.externalId });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3_600);
    const stored = await identityRow(d.deviceId);
    expect(stored!.secretHash).not.toContain(d.deviceSecret);
    expect(stored!.promotionsEnabled).toBeNull();
    expect(stored!.cleanupState).toBe('none');
  });

  it('renews with the credential and touches last_seen_at', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await db
      .update(schema.pushDeviceIdentities)
      .set({ lastSeenAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.pushDeviceIdentities.id, d.deviceId));
    const renewed = await s.devices.token(d.auth);
    expect(renewed.externalId).toBe(d.externalId);
    const stored = await identityRow(d.deviceId);
    expect(Date.now() - stored!.lastSeenAt.getTime()).toBeLessThan(60_000);
  });

  it('answers the same 404 for an unknown id, a wrong secret and a retired identity', async () => {
    const s = scenario();
    const d = await newDevice(s);
    const secret = randomBytes(32).toString('base64url');
    expect(await fails(s.devices.token(`Device ${randomUUID()}.${secret}`))).toBe(
      'PUSH_DEVICE_IDENTITY_GONE',
    );
    expect(await fails(s.devices.token(`Device ${d.deviceId}.${secret}`))).toBe(
      'PUSH_DEVICE_IDENTITY_GONE',
    );
    await s.devices.retire(d.auth);
    expect(await fails(s.devices.token(d.auth))).toBe('PUSH_DEVICE_IDENTITY_GONE');
    expect(await fails(s.devices.retire(d.auth))).toBe('PUSH_DEVICE_IDENTITY_GONE');
  });

  it('answers 401 for a missing or malformed credential, not a guess', async () => {
    const s = scenario();
    for (const bad of [undefined, 'Bearer x', 'Device nope', `Device ${randomUUID()}`]) {
      expect(await fails(s.devices.token(bad)), String(bad)).toBe('DEVICE_CREDENTIAL_REQUIRED');
    }
  });

  it('refuses creation past the global ceiling', async () => {
    const before = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from push_device_identities`,
    );
    const s = scenario(Number(before.rows[0]!.n) + 1);
    await s.devices.create();
    const refused = await s.devices.create().catch((e: unknown) => e);
    expect((refused as { httpStatus: number }).httpStatus).toBe(429);
  });
});

describe('F-02 — the ceiling under concurrency', () => {
  it('concurrent creations cannot jointly exceed it', async () => {
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from push_device_identities
          where created_at >= now() - interval '24 hours'`,
    );
    const s = scenario(Number(rows[0]!.n) + 2);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => s.devices.create()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
});

describe('AC-10 — the flag', () => {
  it('off: issuing, renewing and reporting answer DISABLED; retiring still works', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await setFlag(false);
    expect(await fails(s.devices.create())).toBe('PUSH_DEVICE_IDENTITY_DISABLED');
    expect(await fails(s.devices.token(d.auth))).toBe('PUSH_DEVICE_IDENTITY_DISABLED');
    expect(await fails(s.devices.report(d.auth, report({ subscriptionId: s.sub })))).toBe(
      'PUSH_DEVICE_IDENTITY_DISABLED',
    );
    await s.devices.retire(d.auth);
    expect((await identityRow(d.deviceId))!.revokedAt).not.toBeNull();
  });

  it('with no row at all it is off', async () => {
    const s = scenario();
    await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, FLAG));
    expect(await s.devices.enabled()).toBe(false);
  });
});

describe('AC-2 — reporting a subscription', () => {
  it('refuses a subscription not attached to this device, and writes nothing', async () => {
    const s = scenario();
    const d = await newDevice(s);
    s.provider.subscriptions.set(d.externalId, [{ id: randomUUID(), enabled: true }]);
    expect(await fails(s.devices.report(d.auth, report({ subscriptionId: s.sub })))).toBe(
      'PUSH_SUBSCRIPTION_NOT_CONFIRMED',
    );
    expect(await row(s.sub)).toBeUndefined();
    expect((await identityRow(d.deviceId))!.promotionsEnabled).toBeNull();
  });

  it('answers 503 when the provider cannot be asked', async () => {
    const s = scenario();
    const d = await newDevice(s);
    s.provider.down = true;
    expect(await fails(s.devices.report(d.auth, report({ subscriptionId: s.sub })))).toBe(
      'PUSH_SUBSCRIPTION_UNVERIFIED',
    );
  });

  it('stores a verified subscription as device-owned, and the choice with it', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    const result = await s.devices.report(
      d.auth,
      report({ subscriptionId: s.sub, preferenceVersion: 3 }),
    );
    expect(result).toEqual({ appliedVersion: 3, storedVersion: 3, providerEnabled: true });
    const stored = await row(s.sub);
    expect(stored).toMatchObject({ ownerKind: 'device', userId: null, deviceId: d.deviceId });
    expect((await identityRow(d.deviceId))!.promotionsEnabled).toBe(true);
  });

  it('accepts an opt-out for a disabled subscription, refuses an opt-in for one', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub, false);
    expect(
      await fails(
        s.devices.report(d.auth, report({ subscriptionId: s.sub, promotionsEnabled: true })),
      ),
    ).toBe('PUSH_SUBSCRIPTION_NOT_CONFIRMED');
    const off = await s.devices.report(
      d.auth,
      report({ subscriptionId: s.sub, promotionsEnabled: false }),
    );
    expect(off.providerEnabled).toBe(false);
    expect((await identityRow(d.deviceId))!.promotionsEnabled).toBe(false);
  });

  it('R-16: an older version is refused with the stored one and changes nothing', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub, preferenceVersion: 9 }));
    const refused = await s.devices
      .report(
        d.auth,
        report({ subscriptionId: s.sub, promotionsEnabled: false, preferenceVersion: 8 }),
      )
      .catch((e: unknown) => e);
    expect(codeOf(refused)).toBe('PUSH_PREFERENCE_STALE');
    expect(
      (refused as { options: { fieldErrors: { message: string }[] } }).options.fieldErrors[0]!
        .message,
    ).toBe('9');
    const stored = await identityRow(d.deviceId);
    expect(stored).toMatchObject({ promotionsEnabled: true, preferenceVersion: 9 });
  });

  it('R-16: the same version replays the stored choice and reports the provider afresh', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    const first = await s.devices.report(
      d.auth,
      report({ subscriptionId: s.sub, promotionsEnabled: false, preferenceVersion: 8 }),
    );
    expect(first.providerEnabled).toBe(true);
    d.attach(s.sub, false);
    const again = await s.devices.report(
      d.auth,
      report({ subscriptionId: s.sub, promotionsEnabled: false, preferenceVersion: 8 }),
    );
    expect(again).toEqual({ appliedVersion: 8, storedVersion: 8, providerEnabled: false });
  });

  it('version 0 on a fresh identity is a stated choice, not a replay of nothing', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub, preferenceVersion: 0 }));
    expect((await identityRow(d.deviceId))!.promotionsEnabled).toBe(true);
  });
});

describe('D1 — one namespace each way', () => {
  it('a user path refuses the device: prefix', async () => {
    const s = scenario();
    const actor = { type: 'user', id: `device:${randomUUID()}`, sessionId: 's' } as const;
    expect(() => s.identity.issue(actor)).toThrow(/signed-in users only/);
  });

  it('a device path refuses anything that is not a uuid', async () => {
    const s = scenario();
    expect(() => s.identity.issueForDevice('someone')).toThrow(/uuid/);
  });

  it('a device-owned row joins no account audience', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    const { rows } = await db.execute(sql`
      select u.id from users u, push_subscriptions p
      where p.subscription_id = ${s.sub} and (p.user_id = u.id)
        and ${audiencePredicate('all', {})}
    `);
    expect(rows).toEqual([]);
  });
});

describe('D1 step 4 — a user taking the device over', () => {
  it('moves the row and retires the identity in one write', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    const before = await row(s.sub);

    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    await s.users.register(user, { platform: 'ios', subscriptionId: s.sub });

    const after = await row(s.sub);
    expect(after).toMatchObject({
      ownerKind: 'user',
      userId: user.id,
      deviceId: null,
      revokedAt: null,
    });
    expect(after!.revision).toBe(before!.revision + 1);
    const identity = await identityRow(d.deviceId);
    expect(identity!.revokedAt).not.toBeNull();
    expect(identity!.cleanupState).toBe('pending');
    expect(await fails(s.devices.token(d.auth))).toBe('PUSH_DEVICE_IDENTITY_GONE');
  });

  it('a sign-out returns the row to a fresh device identity', async () => {
    const s = scenario();
    const user = await newUser();
    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    await s.users.register(user, { platform: 'ios', subscriptionId: s.sub });
    s.provider.subscriptions.set(user.id, []);
    await s.users.confirmLogout(user, s.sub);

    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    expect(await row(s.sub)).toMatchObject({
      ownerKind: 'device',
      userId: null,
      deviceId: d.deviceId,
      revokedAt: null,
    });
  });

  it('another device identity on the same subscription loses it and is retired', async () => {
    const s = scenario();
    const a = await newDevice(s);
    const b = await newDevice(s);
    a.attach(s.sub);
    await s.devices.report(a.auth, report({ subscriptionId: s.sub }));
    b.attach(s.sub);
    await s.devices.report(b.auth, report({ subscriptionId: s.sub }));
    expect((await row(s.sub))!.deviceId).toBe(b.deviceId);
    expect((await identityRow(a.deviceId))!.revokedAt).not.toBeNull();
  });
});

describe('AC-15 — forced orderings (R-19, R-20, R-23)', () => {
  it('a report verified before a DELETE cannot land after it', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    const held = holdNextRead(s.provider);
    const pending = fails(s.devices.report(d.auth, report({ subscriptionId: s.sub })));
    await held.reached;
    await s.devices.retire(d.auth);
    held.release();
    expect(await pending).toBe('PUSH_DEVICE_IDENTITY_GONE');
    expect(await row(s.sub)).toBeUndefined();
  });

  it('a report verified before a takeover cannot take the row back', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));

    const held = holdNextRead(s.provider);
    const pending = fails(s.devices.report(d.auth, report({ subscriptionId: s.sub })));
    await held.reached;
    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    await s.users.register(user, { platform: 'ios', subscriptionId: s.sub });
    held.release();

    expect(await pending).toBe('PUSH_DEVICE_IDENTITY_GONE');
    expect(await row(s.sub)).toMatchObject({ ownerKind: 'user', userId: user.id });
  });

  it('a takeover verified before a report loses, and retires nothing', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));

    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    const held = holdNextRead(s.provider);
    const pending = fails(s.users.register(user, { platform: 'ios', subscriptionId: s.sub }));
    await held.reached;
    await s.devices.report(d.auth, report({ subscriptionId: s.sub, preferenceVersion: 2 }));
    held.release();

    expect(await pending).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect((await row(s.sub))!.ownerKind).toBe('device');
    expect((await identityRow(d.deviceId))!.revokedAt).toBeNull();
  });

  it('absent row: a report verified before a confirmed logout cannot create it after', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    const held = holdNextRead(s.provider);
    const pending = fails(s.devices.report(d.auth, report({ subscriptionId: s.sub })));
    await held.reached;
    s.provider.subscriptions.set(user.id, []);
    await s.users.confirmLogout(user, s.sub);
    held.release();

    expect(await pending).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect(await row(s.sub)).toBeUndefined();
    // The choice rolled back with the row.
    expect((await identityRow(d.deviceId))!.promotionsEnabled).toBeNull();
    // Reporting again verifies again, and now lands.
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    expect((await row(s.sub))!.deviceId).toBe(d.deviceId);
  });

  it('absent row: a logout that saw nothing cannot revoke a report newer than its answer', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    s.provider.subscriptions.set(user.id, []);
    const held = holdNextRead(s.provider);
    const pending = s.users.confirmLogout(user, s.sub);
    await held.reached;
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    held.release();
    await pending;
    expect(await row(s.sub)).toMatchObject({ ownerKind: 'device', revokedAt: null });
  });

  it('a delayed logout cannot revoke a row a device has since taken', async () => {
    const s = scenario();
    const user = await newUser();
    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    await s.users.register(user, { platform: 'ios', subscriptionId: s.sub });

    s.provider.subscriptions.set(user.id, []);
    const held = holdNextRead(s.provider);
    const pending = s.users.confirmLogout(user, s.sub);
    await held.reached;
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    held.release();
    await pending;
    expect(await row(s.sub)).toMatchObject({ ownerKind: 'device', revokedAt: null });
  });

  it('a renewal holding the lock first makes the purge skip', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await db
      .update(schema.pushDeviceIdentities)
      .set({ lastSeenAt: new Date(Date.now() - 91 * 86_400_000), promotionsEnabled: true })
      .where(eq(schema.pushDeviceIdentities.id, d.deviceId));

    const renewal = await pool.connect();
    await renewal.query('begin');
    await renewal.query('select 1 from push_device_identities where id = $1 for update', [
      d.deviceId,
    ]);
    await renewal.query('update push_device_identities set last_seen_at = now() where id = $1', [
      d.deviceId,
    ]);
    const lifecycle = new PushDeviceLifecycle(db as never, new FakePush());
    const purge = lifecycle.tick();
    await new Promise((r) => setTimeout(r, 100));
    await renewal.query('commit');
    renewal.release();
    await purge;
    expect((await identityRow(d.deviceId))!.revokedAt).toBeNull();
  });

  it('a purge landing first makes the renewal answer GONE', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await db
      .update(schema.pushDeviceIdentities)
      .set({ lastSeenAt: new Date(Date.now() - 91 * 86_400_000), promotionsEnabled: true })
      .where(eq(schema.pushDeviceIdentities.id, d.deviceId));
    await new PushDeviceLifecycle(db as never, new FakePush()).tick();
    expect(await fails(s.devices.token(d.auth))).toBe('PUSH_DEVICE_IDENTITY_GONE');
  });

  it('every writer at once ends in one valid owner, with no deadlock', async () => {
    const s = scenario();
    const user = await newUser();
    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    for (let round = 0; round < 6; round += 1) {
      const a = await newDevice(s);
      const b = await newDevice(s);
      a.attach(s.sub);
      b.attach(s.sub);
      const outcomes = await Promise.all([
        fails(s.devices.report(a.auth, report({ subscriptionId: s.sub }))),
        fails(s.devices.report(b.auth, report({ subscriptionId: s.sub }))),
        fails(s.users.register(user, { platform: 'ios', subscriptionId: s.sub })),
        fails(s.devices.retire(a.auth)),
        fails(s.devices.token(b.auth)),
      ]);
      for (const outcome of outcomes) {
        expect(outcome).toMatch(
          /^(no error|PUSH_SUBSCRIPTION_CONFLICT|PUSH_DEVICE_IDENTITY_GONE)$/,
        );
      }
    }
    const stored = await row(s.sub);
    expect(stored!.ownerKind === 'user' ? stored!.userId : stored!.deviceId).not.toBeNull();
  });
});

describe('Metric', () => {
  it('counts a row revoked once, whatever a repeated logout does', async () => {
    const s = scenario();
    const user = await newUser();
    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    await s.users.register(user, { platform: 'ios', subscriptionId: s.sub });
    s.provider.subscriptions.set(user.id, []);
    await s.users.confirmLogout(user, s.sub);
    await s.users.confirmLogout(user, s.sub);
    expect(s.metrics.get('push_subscription_registrations_total:revoked')).toBe(1);
  });
});

describe('AC-14 — rollback (R-18, R-18b)', () => {
  /** What the release carrying 0077 runs: its register() statement, verbatim in effect. */
  const baselineTakeover = (subscriptionId: string, userId: string, revision: number) =>
    db.execute(sql`
      update push_subscriptions
      set owner_kind = 'user', user_id = ${userId}::uuid, device_id = null,
          platform = 'ios', last_confirmed_at = now(), revoked_at = null,
          revision = revision + 1
      where subscription_id = ${subscriptionId} and revision = ${revision}
      returning id
    `);

  it('the baseline takes over a device row created after enablement', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    const before = await row(s.sub);
    const { rows } = await baselineTakeover(s.sub, user.id, before!.revision);
    expect(rows).toHaveLength(1);
    expect(await row(s.sub)).toMatchObject({ ownerKind: 'user', userId: user.id, deviceId: null });
  });

  it('the binary before the baseline is still refused on a device row', async () => {
    const s = scenario();
    const user = await newUser();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    await expect(
      db.execute(sql`
        insert into push_subscriptions (user_id, platform, subscription_id)
        values (${user.id}::uuid, 'ios', ${s.sub})
        on conflict (subscription_id) do update
        set user_id = excluded.user_id, revoked_at = null
      `),
    ).rejects.toThrow();
  });
});

describe('AC-2 — migration on a snapshot', () => {
  let folder: string;
  let url: string;
  let snapshot: Pool;

  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'gogo-migrations-'));
    await cp(MIGRATIONS, folder, { recursive: true });
    const journalPath = path.join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.tag < '0078');
    await writeFile(journalPath, JSON.stringify(journal));
    url = await freshDatabase();
    snapshot = new Pool({ connectionString: url, max: 2 });
    await migrate(drizzle(snapshot), { migrationsFolder: folder });
  }, 180_000);

  afterAll(async () => {
    await snapshot.end();
    await rm(folder, { recursive: true, force: true });
  });

  /** Runs the Down statement by statement on one connection, as the file says to. */
  const runDown = async () => {
    const source = await readFile(path.join(MIGRATIONS, '0078_push-device-identity.sql'), 'utf8');
    const down = source.slice(source.indexOf('--   BEGIN;'), source.indexOf('--   COMMIT;') + 12);
    const script = down.replace(/^--(?: {0,3})/gm, '');
    const client = await snapshot.connect();
    try {
      await client.query(script);
      return null;
    } catch (e) {
      await client.query('rollback');
      return (e as Error).message;
    } finally {
      client.release();
    }
  };

  it('keeps user rows, takes them over afterwards, and the down script reverses', async () => {
    const userId = randomUUID();
    const sub = randomUUID();
    await snapshot.query(`insert into users (id, email, display_name) values ($1, $2, 'between')`, [
      userId,
      `between-${userId}@gogo.id.vn`,
    ]);
    await snapshot.query(
      `insert into push_subscriptions (user_id, platform, subscription_id) values ($1, 'ios', $2)`,
      [userId, sub],
    );

    await migrate(drizzle(snapshot), { migrationsFolder: MIGRATIONS });
    const kept = await snapshot.query(
      `select owner_kind, user_id from push_subscriptions where subscription_id = $1`,
      [sub],
    );
    expect(kept.rows[0]).toEqual({ owner_kind: 'user', user_id: userId });

    const device = await snapshot.query(
      `insert into push_device_identities (secret_hash) values ('x') returning id`,
    );
    const deviceSub = randomUUID();
    await snapshot.query(
      `insert into push_subscriptions (owner_kind, device_id, platform, subscription_id)
       values ('device', $1, 'ios', $2)`,
      [device.rows[0].id, deviceSub],
    );
    expect(await runDown()).toMatch(/device-owned/);
    await snapshot.query(`delete from push_subscriptions where subscription_id = $1`, [deviceSub]);
    expect(await runDown()).toBeNull();

    const tables = await snapshot.query(
      `select to_regclass('push_device_identities') as a, to_regclass('campaign_device_sends') as b`,
    );
    expect(tables.rows[0]).toEqual({ a: null, b: null });
    const still = await snapshot.query(
      `select user_id from push_subscriptions where subscription_id = $1`,
      [sub],
    );
    expect(still.rows[0].user_id).toBe(userId);
  });
});

describe('D4 — the `public` campaign', () => {
  async function campaign(audienceType: 'public' | 'all', over: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(schema.notificationCampaigns)
      .values({
        name: `c-${randomUUID()}`,
        title: 't',
        body: 'b',
        audienceType,
        audienceFilter: {},
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1_000),
        dispatchKey: randomUUID(),
        createdByAdminId: randomUUID(),
        ...over,
      } as never)
      .returning();
    return row!;
  }

  const stateOf = async (id: string) =>
    (
      await db
        .select()
        .from(schema.notificationCampaigns)
        .where(eq(schema.notificationCampaigns.id, id))
    )[0]!;

  /** Runs one campaign alone: others already due would otherwise share the fake. */
  async function clearDue() {
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'draft' })
      .where(eq(schema.notificationCampaigns.status, 'scheduled'));
    await db.execute(
      sql`update push_device_identities set revoked_at = now() where revoked_at is null`,
    );
    await db.execute(
      sql`update push_subscriptions set revoked_at = now() where revoked_at is null`,
    );
  }

  async function subscribedDevice(promotionsEnabled = true) {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub, promotionsEnabled }));
    return { ...d, sub: s.sub };
  }

  beforeEach(clearDue);

  it('sends once per device under <dispatch_key>:device:<id>, with no inbox row', async () => {
    const d = await subscribedDevice();
    const c = await campaign('public');
    const push = new FakePush();
    await new CampaignDispatcher(db as never, push).dispatchDue();

    const toDevices = push.sent.filter((m) => m.userIds[0]!.startsWith('device:'));
    expect(toDevices.map((m) => m.userIds[0])).toEqual([d.externalId]);
    const [ledger] = await db
      .select()
      .from(schema.campaignDeviceSends)
      .where(eq(schema.campaignDeviceSends.campaignId, c.id));
    expect(ledger!.dedupeKey).toBe(`${c.dispatchKey}:device:${d.deviceId}`);
    expect(ledger!.pushSentAt).not.toBeNull();
    const state = await stateOf(c.id);
    expect(state).toMatchObject({
      status: 'sent',
      deviceRecipientCount: 1,
      deviceSentCount: 1,
      deviceFailedCount: 0,
    });
    const { rows } = await db.execute(
      sql`select 1 from notifications where payload->>'campaignId' = ${c.id}`,
    );
    expect(rows).toEqual([]);
  });

  it('never addresses a device outside `public`, or one that did not say yes', async () => {
    await subscribedDevice();
    await campaign('all');
    const push = new FakePush();
    await new CampaignDispatcher(db as never, push).dispatchDue();
    expect(push.sent.some((m) => m.userIds[0]!.startsWith('device:'))).toBe(false);

    await clearDue();
    await subscribedDevice(false);
    const s = scenario();
    await newDevice(s); // never reported: null, not admitted
    await campaign('public');
    const second = new FakePush();
    await new CampaignDispatcher(db as never, second).dispatchDue();
    expect(second.sent.some((m) => m.userIds[0]!.startsWith('device:'))).toBe(false);
  });

  it('AC-10: flag off skips devices', async () => {
    await subscribedDevice();
    await setFlag(false);
    const c = await campaign('public');
    const push = new FakePush();
    await new CampaignDispatcher(db as never, push).dispatchDue();
    expect(push.sent.some((m) => m.userIds[0]!.startsWith('device:'))).toBe(false);
    expect((await stateOf(c.id)).deviceRecipientCount).toBeNull();
  });

  it('zero accepted across both halves is failed; a no-target device is counted', async () => {
    const d = await subscribedDevice();
    await db.execute(
      sql`update push_subscriptions set revoked_at = now() where user_id is not null`,
    );
    const c = await campaign('public');
    const push = new FakePush();
    push.unknownUserIds.add(d.externalId);
    await new CampaignDispatcher(db as never, push).dispatchDue();
    const state = await stateOf(c.id);
    expect(state.status).toBe('failed');
    expect(state.lastError).toMatch(/^NO_SUBSCRIPTION_ACCEPTED/);
    expect(state.deviceFailedCount).toBe(1);
  });

  it('§8.1: an id with invalid_aliases naming the target is no_target, not sent', async () => {
    const d = await subscribedDevice();
    await db.execute(
      sql`update push_subscriptions set revoked_at = now() where user_id is not null`,
    );
    const c = await campaign('public');
    const push = new FakePush();
    push.sendToUser = (async (externalId: string) => ({
      providerMessageId: 'msg-1',
      providerMessageIds: ['msg-1'],
      emptyResponses: 0,
      unknownUserIds: [externalId],
    })) as never;
    await new CampaignDispatcher(db as never, push).dispatchDue();
    const [ledger] = await db
      .select()
      .from(schema.campaignDeviceSends)
      .where(eq(schema.campaignDeviceSends.deviceId, d.deviceId));
    expect(ledger).toMatchObject({ pushSentAt: null, failedReason: 'no_target' });
    expect((await stateOf(c.id)).deviceFailedCount).toBe(1);
  });

  it('F-04: a device reached earlier still counts after it left the audience', async () => {
    const reached = await subscribedDevice();
    const other = await subscribedDevice();
    const c = await campaign('public');
    // The first run: the ledger says `reached` got its push; the other throws.
    await db.execute(sql`
      insert into campaign_device_sends (campaign_id, device_id, dedupe_key, push_sent_at)
      values (${c.id}::uuid, ${reached.deviceId}::uuid,
              ${`${c.dispatchKey}:device:${reached.deviceId}`}, now())
    `);
    const down = new FakePush();
    down.unavailable = true;
    await new CampaignDispatcher(db as never, down).dispatchDue();
    expect((await stateOf(c.id)).status).toBe('failed');

    await db
      .update(schema.pushDeviceIdentities)
      .set({ revokedAt: new Date() })
      .where(eq(schema.pushDeviceIdentities.id, reached.deviceId));
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.notificationCampaigns.id, c.id));
    const retry = new FakePush();
    retry.unknownUserIds.add(other.externalId);
    await new CampaignDispatcher(db as never, retry).dispatchDue();

    const state = await stateOf(c.id);
    expect(state.status).toBe('sent');
    expect(state.deviceSentCount).toBe(1);
    expect(state.deviceFailedCount).toBe(1);
  });

  it('an outage fails the campaign; a re-run replays the same keys and skips what landed', async () => {
    const first = await subscribedDevice();
    const second = await subscribedDevice();
    await db.execute(
      sql`update push_subscriptions set revoked_at = now() where user_id is not null`,
    );
    const c = await campaign('public');

    const failing = new FakePush();
    const realSend = failing.sendToUser.bind(failing);
    let calls = 0;
    failing.sendToUser = (async (id: string, n: never) => {
      calls += 1;
      if (calls === 2) throw new Error('provider down');
      return realSend(id, n);
    }) as never;
    await new CampaignDispatcher(db as never, failing).dispatchDue();
    expect((await stateOf(c.id)).status).toBe('failed');

    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.notificationCampaigns.id, c.id));
    const retry = new FakePush();
    await new CampaignDispatcher(db as never, retry).dispatchDue();

    const state = await stateOf(c.id);
    expect(state).toMatchObject({ status: 'sent', deviceSentCount: 2 });
    const keys = failing.sent.concat(retry.sent).map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(failing.sent.length + retry.sent.length).toBe(2);
    expect(new Set([first.externalId, second.externalId]).size).toBe(2);
  });
});

describe('AC-3 inputs — what the console reads', () => {
  const campaigns = () =>
    new CampaignsService(db as never, {} as never, { APP_ENV: 'dev' } as never);

  async function draft(audienceType: 'public' | 'all') {
    const [c] = await db
      .insert(schema.notificationCampaigns)
      .values({
        name: `est-${randomUUID()}`,
        title: 't',
        body: 'b',
        audienceType,
        createdByAdminId: randomUUID(),
      } as never)
      .returning();
    return c!;
  }

  it('estimate is accounts plus devices for `public` only, per distinct device', async () => {
    const s = scenario();
    const d = await newDevice(s);
    const secondSub = randomUUID();
    s.provider.subscriptions.set(d.externalId, [
      { id: s.sub, enabled: true },
      { id: secondSub, enabled: true },
    ]);
    const baseline = await campaigns().estimateAudience((await draft('public')).id);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    await s.devices.report(d.auth, report({ subscriptionId: secondSub }));

    const pub = await campaigns().estimateAudience((await draft('public')).id);
    expect(pub.estimatedDevices).toBe(baseline.estimatedDevices + 1);
    expect(pub.estimatedRecipients).toBe(pub.estimatedAccounts + pub.estimatedDevices);
    const all = await campaigns().estimateAudience((await draft('all')).id);
    expect(all.estimatedDevices).toBe(0);
  });

  it('flag off: no device in the estimate, and capabilities say so', async () => {
    const c = await draft('public');
    expect(await campaigns().capabilities()).toEqual({ publicAudience: true });
    await setFlag(false);
    expect(await campaigns().capabilities()).toEqual({ publicAudience: false });
    expect((await campaigns().estimateAudience(c.id)).estimatedDevices).toBe(0);
  });

  it('flag is per environment: a dev row does not turn production on', async () => {
    await setFlag(true, 'dev');
    const production = new CampaignsService(
      db as never,
      {} as never,
      { APP_ENV: 'production' } as never,
    );
    expect(await production.capabilities()).toEqual({ publicAudience: false });
    expect(await campaigns().capabilities()).toEqual({ publicAudience: true });
  });

  it('a delivery to a device alone freezes the content', async () => {
    const c = await draft('public');
    const s = scenario();
    const d = await newDevice(s);
    await db.insert(schema.campaignDeviceSends).values({
      campaignId: c.id,
      deviceId: d.deviceId,
      dedupeKey: `k:device:${randomUUID()}`,
      pushSentAt: new Date(),
    });
    await db
      .update(schema.notificationCampaigns)
      .set({ status: 'failed' })
      .where(eq(schema.notificationCampaigns.id, c.id));
    const refused = await fails(
      campaigns().update({ type: 'admin', id: randomUUID() } as never, c.id, { title: 'new' }),
    );
    expect(refused).toBe('CAMPAIGN_ALREADY_DELIVERED');
  });
});

describe('D9 — how an identity ends', () => {
  const lifecycle = (push = new FakePush()) => ({
    push,
    run: new PushDeviceLifecycle(db as never, push, undefined, 'dev'),
  });
  const age = (id: string, values: Record<string, unknown>) =>
    db
      .update(schema.pushDeviceIdentities)
      .set(values as never)
      .where(eq(schema.pushDeviceIdentities.id, id));
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('expires one never confirmed in 7 days, or quiet for 90, and spares the rest', async () => {
    const s = scenario();
    const unconfirmed = await newDevice(s);
    const quiet = await newDevice(s);
    const recent = await newDevice(s);
    quiet.attach(s.sub);
    await s.devices.report(quiet.auth, report({ subscriptionId: s.sub }));
    await age(unconfirmed.deviceId, { createdAt: days(8) });
    await age(quiet.deviceId, { lastSeenAt: days(91) });
    await age(recent.deviceId, { createdAt: days(6) });

    await lifecycle().run.tick();

    expect((await identityRow(unconfirmed.deviceId))!.revokedAt).not.toBeNull();
    expect((await identityRow(quiet.deviceId))!.revokedAt).not.toBeNull();
    expect((await row(s.sub))!.revokedAt).not.toBeNull();
    expect((await identityRow(recent.deviceId))!.revokedAt).toBeNull();
  });

  it('waits out the JWT before cleaning the provider, then cleans once', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await s.devices.retire(d.auth);
    const l = lifecycle();

    await l.run.tick();
    expect(l.push.deletedIdentities).not.toContain(d.externalId);

    await age(d.deviceId, { cleanupNextAt: days(1) });
    await l.run.tick();
    expect(l.push.deletedIdentities).toContain(d.externalId);
    expect((await identityRow(d.deviceId))!.cleanupState).toBe('done');

    const count = l.push.deletedIdentities.length;
    await l.run.tick();
    expect(l.push.deletedIdentities).toHaveLength(count);
  });

  it('backs off on a provider fault and dead-letters after the attempts run out', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await s.devices.retire(d.auth);
    await age(d.deviceId, { cleanupNextAt: days(1) });
    const l = lifecycle();
    l.push.unavailable = true;

    await l.run.tick();
    let stored = await identityRow(d.deviceId);
    expect(stored).toMatchObject({ cleanupState: 'pending', cleanupAttempts: 1 });
    expect(stored!.cleanupNextAt!.getTime()).toBeGreaterThan(Date.now());

    await age(d.deviceId, { cleanupAttempts: 7, cleanupNextAt: days(1) });
    await l.run.tick();
    stored = await identityRow(d.deviceId);
    expect(stored).toMatchObject({ cleanupState: 'failed', cleanupNextAt: null });
    expect(await l.run.cleanupDeadLettered()).toBeGreaterThan(0);
    await age(d.deviceId, { cleanupState: 'none' });
  });

  it('deletes the identity and its row 30 days after cleanup; the ledger keeps its count', async () => {
    const s = scenario();
    const d = await newDevice(s);
    d.attach(s.sub);
    await s.devices.report(d.auth, report({ subscriptionId: s.sub }));
    const [c] = await db
      .insert(schema.notificationCampaigns)
      .values({
        name: `ret-${randomUUID()}`,
        title: 't',
        body: 'b',
        audienceType: 'public',
        createdByAdminId: randomUUID(),
      } as never)
      .returning();
    await db.insert(schema.campaignDeviceSends).values({
      campaignId: c!.id,
      deviceId: d.deviceId,
      dedupeKey: `k:device:${d.deviceId}`,
      pushSentAt: new Date(),
    });
    await s.devices.retire(d.auth);
    await age(d.deviceId, {
      cleanupState: 'done',
      cleanupNextAt: null,
      cleanupDoneAt: days(29),
      revokedAt: days(60),
    });

    await lifecycle().run.tick();
    expect(await identityRow(d.deviceId)).toBeDefined();

    await age(d.deviceId, { cleanupDoneAt: days(31) });
    await lifecycle().run.tick();
    expect(await identityRow(d.deviceId)).toBeUndefined();
    expect(await row(s.sub)).toBeUndefined();
    const [ledger] = await db
      .select()
      .from(schema.campaignDeviceSends)
      .where(eq(schema.campaignDeviceSends.campaignId, c!.id));
    expect(ledger).toMatchObject({ deviceId: null });
    expect(ledger!.pushSentAt).not.toBeNull();
  });

  it('F-03: the 30 days count from cleanup, however long after retirement it ran', async () => {
    const s = scenario();
    const d = await newDevice(s);
    await s.devices.retire(d.auth);
    await age(d.deviceId, { revokedAt: days(31), cleanupNextAt: days(1) });
    await lifecycle().run.tick();
    const stored = await identityRow(d.deviceId);
    expect(stored).toMatchObject({ cleanupState: 'done' });
    expect(stored!.cleanupDoneAt).not.toBeNull();
  });

  it('F-01: a write that read a deleted row cannot land on its replacement', async () => {
    const s = scenario();
    const user = await newUser();
    const old = await newDevice(s);
    old.attach(s.sub);
    await s.devices.report(old.auth, report({ subscriptionId: s.sub }));
    const fenceBefore = await db.execute<{ generation: number }>(
      sql`select generation from push_subscription_fences where subscription_id = ${s.sub}`,
    );
    await s.devices.retire(old.auth);
    const readRevision = (await row(s.sub))!.revision;

    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    const held = holdNextRead(s.provider);
    const delayed = fails(s.users.register(user, { platform: 'ios', subscriptionId: s.sub }));
    await held.reached;

    await age(old.deviceId, { cleanupState: 'done', cleanupDoneAt: days(31), cleanupNextAt: null });
    await lifecycle().run.tick();
    expect(await row(s.sub)).toBeUndefined();
    const fenceAfter = await db.execute<{ generation: number }>(
      sql`select generation from push_subscription_fences where subscription_id = ${s.sub}`,
    );
    expect(fenceAfter.rows[0]!.generation).toBe((fenceBefore.rows[0]?.generation ?? 0) + 1);

    const replacement = await newDevice(s);
    replacement.attach(s.sub);
    await s.devices.report(replacement.auth, report({ subscriptionId: s.sub }));
    let guard = 0;
    while ((await row(s.sub))!.revision < readRevision && guard++ < 10) {
      await s.devices.report(replacement.auth, report({ subscriptionId: s.sub }));
    }
    expect((await row(s.sub))!.revision).toBe(readRevision);

    held.release();
    expect(await delayed).toBe('PUSH_SUBSCRIPTION_CONFLICT');
    expect(await row(s.sub)).toMatchObject({ ownerKind: 'device', deviceId: replacement.deviceId });
    expect((await identityRow(replacement.deviceId))!.revokedAt).toBeNull();
  });

  const flagAge = (hours: number) =>
    db
      .update(schema.featureFlags)
      .set({ updatedAt: new Date(Date.now() - hours * 3_600_000) })
      .where(eq(schema.featureFlags.key, FLAG));

  it('drains only on a stored off row untouched for an hour, and only quiet identities', async () => {
    const s = scenario();
    const quiet = await newDevice(s);
    const fresh = await newDevice(s);
    await age(quiet.deviceId, { lastSeenAt: new Date(Date.now() - 2 * 3_600_000) });

    await lifecycle().run.tick();
    expect((await identityRow(quiet.deviceId))!.revokedAt).toBeNull();

    // Just turned off: the hour to take it back.
    await setFlag(false);
    await lifecycle().run.tick();
    expect((await identityRow(quiet.deviceId))!.revokedAt).toBeNull();

    await flagAge(2);
    await lifecycle().run.tick();
    expect((await identityRow(quiet.deviceId))!.revokedAt).not.toBeNull();
    expect((await identityRow(fresh.deviceId))!.revokedAt).toBeNull();
  });

  it('no row reads off for issuing, but never drains', async () => {
    const s = scenario();
    const quiet = await newDevice(s);
    await age(quiet.deviceId, { lastSeenAt: new Date(Date.now() - 2 * 3_600_000) });
    await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, FLAG));
    await lifecycle().run.tick();
    expect((await identityRow(quiet.deviceId))!.revokedAt).toBeNull();
    expect(await s.devices.enabled()).toBe(false);
  });

  it('an old off row for another environment does not drain this one', async () => {
    const s = scenario();
    const quiet = await newDevice(s);
    await age(quiet.deviceId, { lastSeenAt: new Date(Date.now() - 2 * 3_600_000) });
    await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, FLAG));
    await db.insert(schema.featureFlags).values({
      key: FLAG,
      environment: 'production',
      platform: 'all',
      enabled: false,
      updatedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await lifecycle().run.tick();
    expect((await identityRow(quiet.deviceId))!.revokedAt).toBeNull();
  });

  it('the rollback runbook in ADR-0038 leaves no device row and a live user row', async () => {
    const adr = await readFile(
      path.resolve(__dirname, '../../../docs/adr/0038-push-device-identity.md'),
      'utf8',
    );
    const blocks = [...adr.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const [readiness, runbook] = blocks;
    const pending = async () =>
      Number((await pool.query(readiness!.replace('count(*)', 'count(*)::int as n'))).rows[0].n);

    const s = scenario();
    const user = await newUser();
    s.provider.subscriptions.set(user.id, [{ id: s.sub, enabled: true }]);
    await s.users.register(user, { platform: 'ios', subscriptionId: s.sub });
    const d = await newDevice(s);
    const deviceSub = randomUUID();
    d.attach(deviceSub);
    await s.devices.report(d.auth, report({ subscriptionId: deviceSub }));
    expect(await pending()).toBeGreaterThan(0);

    await db.execute(sql`
      update push_device_identities
      set revoked_at = coalesce(revoked_at, now()), cleanup_state = 'done',
          cleanup_next_at = null, cleanup_done_at = now()
    `);
    await db.execute(sql`
      update push_subscriptions set revoked_at = now()
      where owner_kind = 'device' and revoked_at is null
    `);
    expect(await pending()).toBe(0);

    const client = await pool.connect();
    await client.query(runbook!).finally(() => client.release());

    expect(await row(deviceSub)).toBeUndefined();
    expect(await identityRow(d.deviceId)).toBeUndefined();
    expect(await row(s.sub)).toMatchObject({ ownerKind: 'user', userId: user.id });
    const { rows } = await db.execute<{ generation: number }>(
      sql`select generation from push_subscription_fences where subscription_id = ${deviceSub}`,
    );
    expect(rows[0]!.generation).toBeGreaterThan(0);
  });
});
