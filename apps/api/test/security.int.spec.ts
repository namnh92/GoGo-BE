import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { schema } from '@gogo/database';

/**
 * QP-006 (#77) — the security suite.
 *
 * `docs/threat-model.md` describes what the system is supposed to refuse.
 * These are the tests that check it actually does, against the real HTTP
 * surface with hand-crafted requests, because the rule is that the API is the
 * enforcement layer and a UI that hides a button proves nothing.
 *
 * Organised by the OWASP categories the security rules name, so a gap is
 * visible as a missing describe block rather than as an absence nobody
 * notices.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const SECRET = 'test-secret-'.padEnd(48, 'x');

function api() {
  return app.getHttpAdapter().getInstance();
}

let ipCounter = 0;
const ip = () => `10.77.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function register(email: string) {
  const res = await api().inject({
    method: 'POST',
    url: '/v1/auth/register',
    remoteAddress: ip(),
    payload: { email, password: 'sufficiently-long-pw', displayName: 'User' },
  });
  const body = res.json();
  return { token: body.accessToken as string, userId: body.userId as string };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_security_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = SECRET;

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  // The container is stopped in afterAll; an idle client erroring as the
  // server goes away must not fail the run that already passed.
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });

  await db.insert(schema.taxonomies).values({ kind: 'category', key: 'cafe' });
  await db.insert(schema.places).values([
    {
      name: "Quán Trà '; drop table places; --",
      nameNormalized: 'x',
      geom: { x: 106.7, y: 10.77 },
      status: 'published',
    },
    {
      name: '<script>alert(1)</script> Cafe',
      nameNormalized: 'x',
      geom: { x: 106.71, y: 10.78 },
      status: 'published',
    },
  ]);

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

describe('injection (A03)', () => {
  it('treats a SQL payload in a search query as text, not as SQL', async () => {
    const before = await db.execute(sql`select count(*)::int as n from places`);

    const res = await api().inject({
      method: 'GET',
      url: `/v1/places/search?q=${encodeURIComponent("'; drop table places; --")}&lat=10.77&lng=106.7`,
    });
    expect(res.statusCode).toBe(200);

    const after = await db.execute(sql`select count(*)::int as n from places`);
    // The table is still there, which is the whole assertion.
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
  });

  it('survives a payload in a filter parameter, not only in free text', async () => {
    const res = await api().inject({
      method: 'GET',
      url: `/v1/places/search?categories=${encodeURIComponent("cafe') or 1=1--")}&lat=10.77&lng=106.7`,
    });
    // Either a clean rejection or an empty result; never a 500, which is what
    // a query that reached the planner malformed would produce.
    expect([200, 400]).toContain(res.statusCode);
  });

  it('stores a script tag as data and never renders it', async () => {
    const res = await api().inject({
      method: 'GET',
      url: '/v1/places/search?q=script&lat=10.77&lng=106.7',
    });
    expect(res.statusCode).toBe(200);
    // The API is JSON-only: escaping is the client's job, but the content type
    // is what stops a browser from executing a reflected payload here.
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('broken authentication (A07)', () => {
  it('refuses a token signed with the wrong secret', async () => {
    const { token } = await register('sec-wrongsig@gogo.vn');
    const [header, payload] = token.split('.');
    const forged = createHmac('sha256', 'not-the-real-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');

    const res = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(`${header}.${payload}.${forged}`),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an unsigned token claiming alg none', async () => {
    const { token } = await register('sec-algnone@gogo.vn');
    const payload = token.split('.')[1]!;
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');

    const res = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(`${header}.${payload}.`),
    });
    // The classic JWT bypass: accepted only by a verifier that trusts the
    // token's own header about which algorithm to use.
    expect(res.statusCode).toBe(401);
  });

  it('refuses a token whose payload was edited to another user', async () => {
    const { token } = await register('sec-swap@gogo.vn');
    const other = await register('sec-swap-victim@gogo.vn');
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    claims.sub = other.userId;
    const edited = Buffer.from(JSON.stringify(claims)).toString('base64url');

    const res = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(`${header}.${edited}.${signature}`),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an expired token even with a valid signature', async () => {
    const { token } = await register('sec-expired@gogo.vn');
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    claims.exp = Math.floor(Date.now() / 1000) - 60;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');

    const res = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(`${header}.${body}.${signature}`),
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not accept a refresh token in the Authorization header', async () => {
    const login = await api().inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: ip(),
      payload: {
        email: 'sec-refresh-as-access@gogo.vn',
        password: 'sufficiently-long-pw',
        displayName: 'U',
      },
    });
    const refreshToken = login.json().refreshToken as string;

    const res = await api().inject({
      method: 'GET',
      url: '/v1/me',
      headers: auth(refreshToken),
    });
    // Opaque refresh tokens are not access tokens; confusing the two is how a
    // long-lived credential ends up doing a short-lived one's job.
    expect(res.statusCode).toBe(401);
  });
});

describe('enumeration', () => {
  it('does not reveal whether an email exists', async () => {
    await register('sec-known@gogo.vn');
    const known = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip(),
      payload: { email: 'sec-known@gogo.vn', password: 'wrong-password-here' },
    });
    const unknown = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip(),
      payload: { email: 'sec-nobody@gogo.vn', password: 'wrong-password-here' },
    });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json().code).toBe(unknown.json().code);
  });

  it('does not reveal whether an invite code exists', async () => {
    const wrong = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: 'ZZZZZZZZ', displayName: 'Guest' },
    });
    const malformed = await api().inject({
      method: 'POST',
      url: '/v1/rooms/join/guest',
      remoteAddress: ip(),
      payload: { inviteCode: 'YYYYYYYY', displayName: 'Guest' },
    });
    expect(wrong.statusCode).toBe(malformed.statusCode);
  });
});

describe('access control (A01)', () => {
  it('denies every protected route without credentials', async () => {
    for (const [method, url] of [
      ['GET', '/v1/me'],
      ['GET', '/v1/rooms'],
      ['POST', '/v1/rooms'],
      ['GET', '/v1/cms/places'],
      ['POST', '/v1/uploads'],
    ] as const) {
      const res = await api().inject({ method, url, remoteAddress: ip(), payload: {} });
      expect([401, 403]).toContain(res.statusCode);
    }
  });

  it('a consumer token cannot reach the CMS, however it is presented', async () => {
    const { token } = await register('sec-consumer@gogo.vn');
    for (const url of ['/v1/cms/places', '/v1/cms/audit', '/v1/cms/experiments']) {
      const res = await api().inject({
        method: 'GET',
        url,
        remoteAddress: ip(),
        headers: auth(token),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('ignores client-supplied fields that would change ownership', async () => {
    const owner = await register('sec-owner@gogo.vn');
    const attacker = await register('sec-attacker@gogo.vn');
    const res = await api().inject({
      method: 'POST',
      url: '/v1/rooms',
      remoteAddress: ip(),
      headers: auth(attacker.token),
      payload: {
        type: 'group',
        decisionMode: 'vote',
        participantCount: 3,
        // Mass assignment attempt: the host must come from the token.
        hostUserId: owner.userId,
        constraint: { budgetMode: 'per_person', budgetAmount: 200_000, currency: 'VND' },
      },
    });
    expect(res.statusCode).toBe(201);
    const [room] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, res.json().id));
    expect(room!.hostUserId).toBe(attacker.userId);
  });
});

describe('rate limiting', () => {
  it('cannot be evaded by spoofing X-Forwarded-For', async () => {
    const email = 'sec-spoof@gogo.vn';
    await register(email);

    // Same source, a different claimed address on every attempt. If the
    // forwarded header is trusted from an untrusted peer, each of these looks
    // like a new client and the per-IP limit never bites.
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await api().inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: '10.99.0.1',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email, password: 'wrong-password-here' },
      });
      codes.push(res.statusCode);
    }
    // Either the IP limit or the per-account lockout must stop this run.
    expect(codes).toContain(429);
  });

  it('a rotating forwarded header does not buy a fresh bucket', async () => {
    // An IP-keyed route with no per-account fallback, so this measures the IP
    // key alone. With TRUST_PROXY=1 (the old default) fifteen of these drew no
    // 429 at all: each spoofed address was a new client.
    const codes: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const res = await api().inject({
        method: 'POST',
        url: '/v1/rooms/join/guest',
        remoteAddress: '10.98.0.1',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
        payload: { inviteCode: 'ZZZZZZZZ', displayName: 'Guest' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
  });
});

describe('logging and PII', () => {
  it('never puts a token in a URL', async () => {
    const { token } = await register('sec-url-token@gogo.vn');
    const res = await api().inject({
      method: 'GET',
      url: `/v1/me?access_token=${token}`,
      headers: auth(token),
    });
    // Accepting a token from the query string would put credentials into
    // every access log and Referer header that touches the request.
    expect(res.statusCode).toBe(200);
    const unauthenticated = await api().inject({
      method: 'GET',
      url: `/v1/me?access_token=${token}`,
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('does not echo the request body back in an error', async () => {
    const res = await api().inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip(),
      payload: { email: 'not-an-email', password: 'super-secret-password-value' },
    });
    expect(res.statusCode).toBe(400);
    // Field errors name the field, never the value: an error envelope that
    // quotes the payload puts the password in whatever renders it.
    expect(res.body).not.toContain('super-secret-password-value');
  });
});

describe('security headers', () => {
  it('sends the headers a JSON API should send', async () => {
    const res = await api().inject({ method: 'GET', url: '/v1/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });
});
